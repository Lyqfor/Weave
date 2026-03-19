import OpenAI from "openai";
import type { LlmConfig } from "../types/config.js";
import { AppLogger } from "../logging/app-logger.js";

/**
 * 文件作用：封装 Qwen（OpenAI 兼容接口）调用细节，向上提供统一的 chat 方法。
 */
export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatTurnInput {
  systemPrompt?: string;
  userMessage: string;
  historyMessages?: ChatHistoryMessage[];
}

export interface ChatStreamOptions {
  onDelta?: (deltaText: string) => void;
}

export interface ChatLoopInput {
  systemPrompt: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
}

export class QwenClient {
  private readonly client: OpenAI;
  private readonly logger = new AppLogger("qwen-client");

  constructor(private readonly config: LlmConfig) {
    // 初始化 OpenAI 兼容客户端：Qwen 通过 baseURL 接入兼容接口。
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl
    });
    this.logger.info("client.init", "Qwen 客户端初始化完成", {
      model: config.model,
      baseUrl: config.baseUrl
    });
  }

  async chat(input: ChatTurnInput): Promise<string> {
    // 构建一次最小对话请求：system + user，并将结果文本回传给 Agent 层。
    this.logger.info("chat.request", "发起非流式调用", {
      hasSystemPrompt: Boolean(input.systemPrompt),
      userMessageLength: input.userMessage.length
    });
    const completion = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      messages: this.buildMessages(input)
    });

    // 非流式模式下直接读取首个候选回复文本。
    const finalText = completion.choices[0]?.message?.content ?? "";
    this.logger.info("chat.response", "非流式调用完成", {
      responseLength: finalText.length
    });
    return finalText;
  }

  async chatStream(input: ChatTurnInput, options: ChatStreamOptions = {}): Promise<string> {
    // 使用流式接口逐段消费模型输出，并通过回调把增量文本向上游传递。
    this.logger.info("chat.stream.request", "发起流式调用", {
      hasSystemPrompt: Boolean(input.systemPrompt),
      userMessageLength: input.userMessage.length
    });
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream: true,
      messages: this.buildMessages(input)
    });

    // fullText 用于在流式结束后获得完整回复，方便落盘和审计。
    let fullText = "";
    let chunkCount = 0;

    for await (const chunk of stream) {
      const deltaText = chunk.choices[0]?.delta?.content ?? "";
      if (!deltaText) {
        continue;
      }

      // 每个 delta 片段都立即向上游透传，以实现终端/前端实时显示。
      fullText += deltaText;
      chunkCount += 1;
      options.onDelta?.(deltaText);
    }

    this.logger.info("chat.stream.completed", "流式调用完成", {
      chunkCount,
      responseLength: fullText.length
    });
    return fullText;
  }

  async chatWithTools(
    input: ChatLoopInput,
    options?: { onDelta?: (delta: string) => void }
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> {
    this.logger.info("chat.tools.request", "发起可工具调用请求", {
      messageCount: input.messages.length,
      toolCount: input.tools.length,
      streaming: Boolean(options?.onDelta)
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: input.systemPrompt },
      ...input.messages
    ];

    if (!options?.onDelta) {
      // 非流式路径（默认）：结构稳定，工具调用解析可靠
      const completion = await this.client.chat.completions.create({
        model: this.config.model,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        tool_choice: "auto",
        tools: input.tools,
        messages
      });

      const message = completion.choices[0]?.message;
      if (!message) {
        throw new Error("模型未返回可用消息。\n");
      }

      this.logger.info("chat.tools.response", "工具调用响应已返回", {
        hasToolCalls: Boolean(message.tool_calls?.length),
        hasContent: Boolean(message.content)
      });
      return message;
    }

    // 流式路径：逐 delta 广播，同时聚合完整消息
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      tool_choice: "auto",
      tools: input.tools,
      messages,
      stream: true
    });

    let fullContent = "";
    const toolCallBuilders = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        fullContent += delta.content;
        options.onDelta(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const prev = toolCallBuilders.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) prev.id = tc.id;
        if (tc.function?.name) prev.name += tc.function.name;
        if (tc.function?.arguments) prev.arguments += tc.function.arguments;
        toolCallBuilders.set(tc.index, prev);
      }
    }

    const tool_calls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined =
      toolCallBuilders.size > 0
        ? [...toolCallBuilders.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments }
            }))
        : undefined;

    this.logger.info("chat.tools.response", "工具调用流式响应已完成", {
      hasToolCalls: Boolean(tool_calls?.length),
      hasContent: Boolean(fullContent)
    });

    return {
      role: "assistant",
      content: fullContent || null,
      refusal: null,
      tool_calls
    };
  }

  private buildMessages(input: ChatTurnInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    // 组装多轮上下文消息：system + 历史问答 + 本轮用户输入。
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: input.systemPrompt ?? this.config.systemPrompt ?? "你是一个有帮助的智能助手。"
      }
    ];

    for (const history of input.historyMessages ?? []) {
      messages.push({
        role: history.role,
        content: history.content
      });
    }

    messages.push({
      role: "user",
      content: input.userMessage
    });

    return messages;
  }
}

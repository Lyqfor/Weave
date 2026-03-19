/**
 * 文件作用：LlmNode — 表示一次 LLM 推理决策节点。
 * doExecute() 驱动实际 LLM 调用并动态添加后续节点。
 * try/finally 保证 Plugin 生命周期闭合（afterLlmResponse 必须执行）。
 * doExecute() 只能 return（成功）或 throw（失败），状态由模板方法收口。
 */

import type OpenAI from "openai";
import type { NodeKind, GraphPort } from "./node-types.js";
import { BaseNode } from "./base-node.js";
import { ToolNode } from "./tool-node.js";
import { FinalNode } from "./final-node.js";
import type { RunContext } from "../session/run-context.js";
import { tryParseJson } from "../utils/text-utils.js";

export interface LlmNodeInit {
  step: number;
  systemPrompt?: string;
  messages?: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}

export class LlmNode extends BaseNode<RunContext> {
  readonly kind: NodeKind = "llm";

  public readonly step: number;
  private systemPrompt?: string;
  private messages?: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  private responseText?: string;
  private toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];

  constructor(id: string, init: LlmNodeInit, parentId?: string) {
    super(id, parentId);
    this.step = init.step;
    this.systemPrompt = init.systemPrompt;
    this.messages = init.messages;
  }

  get title(): string {
    return `LLM 决策 #${this.step}`;
  }

  /** 设置 LLM 响应结果（execute() 内部调用） */
  setResponse(
    text: string | null | undefined,
    toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
  ): void {
    this.responseText = text ?? undefined;
    this.toolCalls = toolCalls?.length ? toolCalls : undefined;
  }

  protected async doExecute(ctx: RunContext): Promise<void> {
    // 保存输入数据用于可视化
    this.systemPrompt = ctx.systemPrompt;
    this.messages = [...ctx.workingMessages];

    ctx.logger.info("run.dag.step", "DAG 调度执行 LLM 节点", {
      runId: ctx.runId,
      step: this.step,
      nodeId: this.id,
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      modelToolCount: ctx.toolRegistry.listModelTools().length
    });

    // beforeLlmRequest 插件钩子
    let effectiveSystemPrompt = ctx.systemPrompt;
    for (const plugin of ctx.plugins) {
      const changed = await plugin.beforeLlmRequest?.({
        ...ctx.basePluginContext,
        step: this.step,
        systemPrompt: effectiveSystemPrompt,
        messages: ctx.workingMessages
      });
      if (changed?.systemPrompt) {
        effectiveSystemPrompt = changed.systemPrompt;
      }
      ctx.bus.dispatchPluginOutput(changed?.output);
    }

    let assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessage | undefined;

    try {
      // LLM 调用（流式旁路：onDelta 广播至引擎事件总线，供 Web UI 实时展示）
      assistantMessage = await ctx.llmClient.chatWithTools(
        {
          systemPrompt: effectiveSystemPrompt,
          messages: ctx.workingMessages,
          tools: ctx.toolRegistry.listModelTools()
        },
        {
          onDelta: (delta) => ctx.dag.getEngineEventBus()?.onNodeStreamDelta?.(this.id, delta)
        }
      );
    } catch (error) {
      // 🛡️ LLM 调用失败时也要闭合 Plugin 生命周期
      for (const plugin of ctx.plugins) {
        try {
          await plugin.afterLlmResponse?.({
            ...ctx.basePluginContext,
            step: this.step,
            assistantMessage: { role: "assistant", content: null, refusal: null } as any
          });
        } catch (e) {
          ctx.logger?.warn("plugin.after_llm.error", `Plugin afterLlmResponse 异常: ${e}`);
        }
      }
      throw error;
    }

    // 🛡️ try/finally 闭合 Plugin 生命周期（正常路径）
    for (const plugin of ctx.plugins) {
      try {
        const output = await plugin.afterLlmResponse?.({
          ...ctx.basePluginContext,
          step: this.step,
          assistantMessage
        });
        ctx.bus.dispatchPluginOutput(output);
      } catch (e) {
        ctx.logger?.warn("plugin.after_llm.error", `Plugin afterLlmResponse 异常: ${e}`);
      }
    }

    // 更新可视化数据
    this.setResponse(assistantMessage.content, assistantMessage.tool_calls ?? []);

    // 记录到状态存储
    ctx.stateStore.setNodeOutput(this.id, {
      ok: true,
      content: assistantMessage.content ?? "",
      metadata: {
        toolCallCount: assistantMessage.tool_calls?.length ?? 0,
        step: this.step
      }
    });

    const toolCalls = assistantMessage.tool_calls ?? [];

    if (toolCalls.length === 0) {
      // 无工具调用 → 添加 FinalNode
      const finalNode = new FinalNode(`final-${this.step}`, assistantMessage.content ?? "");
      ctx.dag.addNode({ id: finalNode.id, type: "final", status: "pending" }, finalNode.freezeSnapshot());
      ctx.dag.addEdge(this.id, finalNode.id);
      ctx.dag.addDataEdge({
        fromNodeId: this.id,
        toNodeId: finalNode.id,
        fromKey: "content",
        toKey: "finalText"
      });
      ctx.nodeRegistry.set(finalNode.id, finalNode);
      return; // → BaseNode markSuccess
    }

    // 有工具调用 → 推入 assistant 消息，创建 ToolNode
    ctx.workingMessages.push({
      role: "assistant",
      content: assistantMessage.content ?? "",
      tool_calls: toolCalls
    });

    const toolNodeIds: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const parsedArgs = (tryParseJson(tc.function.arguments || "{}") ?? {}) as Record<string, unknown>;
      const toolNodeId = `tool-${this.step}-${i + 1}`;

      const toolNode = new ToolNode(toolNodeId, {
        toolName: tc.function.name,
        toolCallId: tc.id,
        args: parsedArgs,
        intent: assistantMessage.content ?? "",
        maxRetries: ctx.defaultToolRetries,
        step: this.step
      });

      ctx.dag.addNode({ id: toolNode.id, type: "tool", status: "pending" }, toolNode.freezeSnapshot());
      ctx.dag.addEdge(this.id, toolNode.id);
      ctx.dag.addDataEdge({
        fromNodeId: this.id,
        toNodeId: toolNode.id,
        fromKey: "content",
        toKey: "llmDecision"
      });
      ctx.nodeRegistry.set(toolNode.id, toolNode);
      toolNodeIds.push(toolNodeId);
    }

    if (this.step + 1 <= ctx.maxSteps) {
      // 添加下一个 LLM 节点，等待所有工具完成
      const nextLlmNode = new LlmNode(`llm-${this.step + 1}`, { step: this.step + 1 });
      ctx.dag.addNode({ id: nextLlmNode.id, type: "llm", status: "pending" }, nextLlmNode.freezeSnapshot());
      for (let i = 0; i < toolNodeIds.length; i++) {
        ctx.dag.addEdge(toolNodeIds[i], nextLlmNode.id);
        ctx.dag.addDataEdge({
          fromNodeId: toolNodeIds[i],
          toNodeId: nextLlmNode.id,
          fromKey: "content",
          toKey: `tool_${i + 1}`
        });
      }
      ctx.nodeRegistry.set(nextLlmNode.id, nextLlmNode);
    } else {
      // 达到最大步数 → 添加兜底 FinalNode
      const fallbackFinalId = `final-max-${this.step}`;
      const fallbackFinal = new FinalNode(fallbackFinalId, "已达到最大工具调用步数，请缩小问题范围后重试。");
      ctx.dag.addNode({ id: fallbackFinalId, type: "final", status: "pending" }, fallbackFinal.freezeSnapshot());
      for (const toolNodeId of toolNodeIds) {
        ctx.dag.addEdge(toolNodeId, fallbackFinalId);
        ctx.dag.addDataEdge({
          fromNodeId: toolNodeId,
          toNodeId: fallbackFinalId,
          fromKey: "content",
          toKey: toolNodeId
        });
      }
      ctx.nodeRegistry.set(fallbackFinalId, fallbackFinal);
    }

    ctx.dag.validateIntegrity();
    // return → BaseNode markSuccess
  }

  protected getSpecificFields(): Record<string, unknown> {
    return { step: this.step };
  }

  async getInputPorts(): Promise<GraphPort[]> {
    const ports: GraphPort[] = [];
    if (this.systemPrompt) {
      ports.push(await this.makePort("systemPrompt", "text", this.systemPrompt));
    }
    if (this.messages?.length) {
      ports.push(await this.makePort("messages", "messages", this.messages));
    }
    return ports;
  }

  async getOutputPorts(): Promise<GraphPort[]> {
    const ports: GraphPort[] = [];
    if (this.responseText !== undefined) {
      ports.push(await this.makePort("responseText", "text", this.responseText));
    }
    if (this.toolCalls?.length) {
      ports.push(await this.makePort("toolCalls", "json", this.toolCalls));
    }
    return ports;
  }
}

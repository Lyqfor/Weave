import { EventEmitter } from "node:events";
import type { LlmConfig } from "../types/config.js";
import { QwenClient } from "../llm/qwen-client.js";
import { MemoryStore } from "../memory/memory-store.js";
import { AppLogger } from "../logging/app-logger.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { DagExecutionGraph } from "../engine/dag-graph.js";
import { DagStateStore } from "../engine/state-store.js";
import type {
  RunOnceStreamOptions
} from "../engine/runner-types.js";
import type OpenAI from "openai";
import type {
  AgentLoopPlugin,
  AgentPluginRunContext
} from "./plugins/agent-plugin.js";
import { extractErrorMessage } from "../errors/agent-errors.js";
import {
  MAX_AGENT_STEPS,
  getDefaultToolRetries,
  getDefaultToolTimeoutMs
} from "../config/defaults.js";
import {
  executeOnRunStart,
  executeOnRunCompleted,
  executeOnRunError
} from "./plugin-executor.js";
import { executeDag } from "../engine/dag-executor.js";
import { LlmNode } from "../nodes/llm-node.js";
import { InputNode } from "../nodes/input-node.js";
import type { BaseNode } from "../nodes/base-node.js";
import { WeaveEventBus } from "../event/event-bus.js";
import { TurnEngineBusAdapter } from "./turn-engine-bus-adapter.js";
import type { RunContext, StepGateOptions } from "../session/run-context.js";
import { PendingPromiseRegistry } from "../weave/pending-promise-registry.js";
import { StepGateInterceptor } from "../weave/step-gate-interceptor.js";
import { SnapshotStore } from "../engine/snapshot-store.js";
import * as path from "node:path";

// 从 event-types 重新导出，保持向后兼容
export type { AgentRunEventType, AgentRunEvent } from "../event/event-types.js";
import type { AgentRunEvent } from "../event/event-types.js";

/**
 * 文件作用：提供 Agent 运行时最小抽象，承接上层输入并调用 LLM 客户端生成回复。
 */

export class AgentRuntime extends EventEmitter {
  private static readonly AGENT_EVENT_SCHEMA_VERSION = "dagent.agent.event.v1";
  private readonly llmClient: QwenClient;
  private readonly memoryStore: MemoryStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly logger = new AppLogger("agent-runtime");
  private sessionId = "";
  private turnIndex = 0;
  private readonly historyMessages: import("../llm/qwen-client.js").ChatHistoryMessage[] = [];
  private readonly streamChunkSize = 14;
  private readonly streamChunkDelayMs = 8;

  constructor(
    private readonly llmConfig: LlmConfig,
    memoryStore?: MemoryStore,
    toolRegistry?: ToolRegistry
  ) {
    super();
    this.llmClient = new QwenClient(this.llmConfig);
    this.memoryStore = memoryStore ?? new MemoryStore();
    this.toolRegistry = toolRegistry ?? new ToolRegistry();
    this.memoryStore.ensureMemoryFiles();

    this.logger.info("runtime.init", "AgentRuntime 初始化完成", {
      provider: this.llmConfig.provider,
      model: this.llmConfig.model
    });
  }

  startSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.turnIndex = 0;
    this.historyMessages.length = 0;
    this.logger.info("session.start", "会话已初始化", { sessionId });
  }

  async runOnce(userInput: string): Promise<string> {
    this.logger.info("run.once.start", "开始执行非流式调用", {
      userInputLength: userInput.length
    });

    const composedSystemPrompt = this.memoryStore.buildSystemPrompt(this.llmConfig.systemPrompt);
    const finalText = await this.llmClient.chat({
      userMessage: userInput,
      systemPrompt: composedSystemPrompt,
      historyMessages: this.historyMessages
    });

    this.historyMessages.push({ role: "user", content: userInput });
    this.historyMessages.push({ role: "assistant", content: finalText });

    this.logger.info("run.once.completed", "非流式调用完成", {
      responseLength: finalText.length
    });
    return finalText;
  }

  async runOnceStream(
    userInput: string,
    options?: RunOnceStreamOptions
  ): Promise<string> {
    return this.runOnceStreamCommon(userInput, options, (ctx) =>
      this.runAgentDagLoop(
        ctx.runId,
        userInput,
        ctx.composedSystemPrompt,
        ctx.plugins,
        ctx.basePluginContext,
        ctx.stepGate
      )
    );
  }

  /**
   * 流式执行框架：setup → 核心循环 → 收尾/错误处理。
   */
  private async runOnceStreamCommon(
    userInput: string,
    options: RunOnceStreamOptions | undefined,
    coreLoop: (ctx: {
      runId: string;
      composedSystemPrompt: string;
      plugins: AgentLoopPlugin[];
      basePluginContext: AgentPluginRunContext;
      stepGate: StepGateOptions;
    }) => Promise<string>
  ): Promise<string> {
    const runId = this.createRunId();
    this.turnIndex += 1;

    this.logger.info("run.stream.start", "开始执行流式调用", {
      runId,
      sessionId: this.sessionId,
      turnIndex: this.turnIndex,
      userInputLength: userInput.length
    });

    this.emitRunEvent({
      type: "run.start",
      runId,
      timestamp: new Date().toISOString(),
      payload: { userInput, sessionId: this.sessionId, turnIndex: this.turnIndex }
    });

    this.emitRunEvent({
      type: "llm.request",
      runId,
      timestamp: new Date().toISOString(),
      payload: { userInput, sessionId: this.sessionId, turnIndex: this.turnIndex }
    });

    try {
      const plugins = options?.plugins ?? [];
      const basePluginContext: AgentPluginRunContext = {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        userInput
      };

      await executeOnRunStart(plugins, basePluginContext, runId, this.emitPluginOutput.bind(this));

      const composedSystemPrompt = this.memoryStore.buildSystemPrompt(this.llmConfig.systemPrompt);
      const finalText = await coreLoop({
        runId,
        composedSystemPrompt,
        plugins,
        basePluginContext,
        stepGate: {
          enabled: options?.stepMode === true,
          autoMode: options?.autoMode === true,
          approveToolCall: options?.approveToolCall
        }
      });

      this.historyMessages.push({ role: "user", content: userInput });
      this.historyMessages.push({ role: "assistant", content: finalText });

      this.emitRunEvent({
        type: "llm.completed",
        runId,
        timestamp: new Date().toISOString(),
        payload: { finalText, sessionId: this.sessionId, turnIndex: this.turnIndex }
      });

      await executeOnRunCompleted(plugins, { ...basePluginContext, finalText }, runId, this.emitPluginOutput.bind(this));

      this.emitRunEvent({
        type: "run.completed",
        runId,
        timestamp: new Date().toISOString(),
        payload: { finalText, sessionId: this.sessionId, turnIndex: this.turnIndex }
      });

      this.logger.info("run.stream.completed", "流式调用完成", {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        responseLength: finalText.length
      });

      return finalText;
    } catch (error: unknown) {
      const errorMessage = extractErrorMessage(error);
      const plugins = options?.plugins ?? [];
      const basePluginContext: AgentPluginRunContext = {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        userInput
      };

      await executeOnRunError(plugins, { ...basePluginContext, errorMessage }, runId, this.emitPluginOutput.bind(this));

      this.logger.error("run.stream.error", "流式调用失败", {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        errorMessage
      });
      this.emitRunEvent({
        type: "run.error",
        runId,
        timestamp: new Date().toISOString(),
        payload: { errorMessage, sessionId: this.sessionId, turnIndex: this.turnIndex }
      });
      throw error;
    }
  }

  private async runAgentDagLoop(
    runId: string,
    userInput: string,
    systemPrompt: string,
    plugins: AgentLoopPlugin[],
    basePluginContext: AgentPluginRunContext,
    stepGate: StepGateOptions
  ): Promise<string> {
    const dag = new DagExecutionGraph();
    const stateStore = new DagStateStore();
    const nodeRegistry = new Map<string, BaseNode>();

    const workingMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...this.historyMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userInput }
    ];

    const bus = new WeaveEventBus(
      { runId, sessionId: this.sessionId, turnIndex: this.turnIndex },
      (evt) => this.emit("event", evt)
    );

    // 创建流式文本输出方法（闭包引用 bus 和 chunk 配置）
    const emitTextAsStream = async (text: string): Promise<void> => {
      if (!text) return;
      const chunks = this.splitText(text, this.streamChunkSize);
      for (const chunk of chunks) {
        bus.dispatch("llm.delta", { text: chunk });
        if (this.streamChunkDelayMs > 0) {
          await this.sleep(this.streamChunkDelayMs);
        }
      }
    };

    // Phase 2：全局 AbortController
    const abortController = new AbortController();

    // Phase 3：拦截器基础设施
    const pendingRegistry = new PendingPromiseRegistry();
    const interceptor = stepGate.enabled
      ? new StepGateInterceptor(pendingRegistry, { enabled: true })
      : undefined;

    // Phase 4：快照存储
    const snapshotDiskPath = path.join(process.cwd(), ".dagent", "snapshots", `${runId}.jsonl`);
    const snapshotStore = new SnapshotStore(snapshotDiskPath);

    // abortSignal 触发时清理挂起字典
    abortController.signal.addEventListener("abort", () => {
      pendingRegistry.rejectAll(new Error("DAG 中止"));
    }, { once: true });

    // Layer 3 适配器：将引擎事件桥接到 WeaveEventBus
    const turnAdapter = new TurnEngineBusAdapter(bus, runId, this.sessionId);
    dag.setEngineEventBus(turnAdapter);

    const ctx: RunContext = {
      runId,
      sessionId: this.sessionId,
      turnIndex: this.turnIndex,
      bus,
      llmClient: this.llmClient,
      toolRegistry: this.toolRegistry,
      memoryStore: this.memoryStore,
      dag,
      stateStore,
      nodeRegistry,
      workingMessages,
      systemPrompt,
      plugins,
      basePluginContext,
      stepGate,
      defaultToolRetries: stepGate.autoMode === true ? getDefaultToolRetries() : 0,
      defaultToolTimeoutMs: getDefaultToolTimeoutMs(),
      logger: this.logger,
      maxSteps: MAX_AGENT_STEPS,
      emitTextAsStream,
      abortController,
      abortSignal: abortController.signal,
      interceptor,
      pendingRegistry,
      snapshotStore
    };

    // 初始化 DAG：InputNode（终态广播）→ llm-1（调度起点）
    const inputNode = new InputNode("input", userInput);
    dag.addNode({ id: "input", type: "input", status: "success" }, inputNode.freezeSnapshot());
    inputNode.broadcastIo(ctx);

    const firstLlmNode = new LlmNode("llm-1", { step: 1 });
    dag.addNode({ id: "llm-1", type: "llm", status: "pending" }, firstLlmNode.freezeSnapshot());
    dag.addEdge("input", "llm-1");
    nodeRegistry.set("llm-1", firstLlmNode);
    dag.validateIntegrity();

    stateStore.setRunValue("userInput", userInput);

    try {
      return await executeDag(dag, ctx);
    } catch (error) {
      // DagDeadlockError 的 onSchedulerIssue 已在 dag-executor 广播，此处只加可视化 error 节点
      const errorMessage = extractErrorMessage(error);
      const errorNodeId = "error";
      try {
        dag.addNode(
          { id: errorNodeId, type: "system", status: "fail" },
          {
            nodeId: errorNodeId,
            kind: "system",
            title: `运行失败: ${errorMessage}`,
            status: "fail",
            error: { name: "RunError", message: errorMessage }
          }
        );
      } catch {
        // 忽略 error node 添加失败（例如节点 ID 已存在）
      }
      throw error;
    } finally {
      // 会话结束，快照完整落盘
      await snapshotStore.flush().catch(() => {});
    }
  }

  private splitText(text: string, chunkSize: number): string[] {
    const result: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      result.push(text.slice(i, i + chunkSize));
    }
    return result;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private emitRunEvent(event: AgentRunEvent): void {
    const enrichedEvent: AgentRunEvent = {
      ...event,
      schemaVersion: event.schemaVersion ?? AgentRuntime.AGENT_EVENT_SCHEMA_VERSION,
      eventType: event.eventType ?? event.type,
      eventId: event.eventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    };

    if (enrichedEvent.type !== "llm.delta") {
      this.logger.info("event.publish", "发布运行事件", {
        runId: enrichedEvent.runId,
        eventType: enrichedEvent.type,
        eventId: enrichedEvent.eventId,
        schemaVersion: enrichedEvent.schemaVersion
      });
    }
    this.emit("event", enrichedEvent);
  }

  private emitPluginOutput(runId: string, output: import("./plugins/agent-plugin.js").AgentPluginOutputs): void {
    if (!output) return;
    const outputs = Array.isArray(output) ? output : [output];
    for (const item of outputs) {
      this.emitRunEvent({
        type: "plugin.output",
        runId,
        timestamp: new Date().toISOString(),
        payload: {
          pluginName: item.pluginName,
          outputType: item.outputType,
          outputText: item.outputText
        }
      });
    }
  }

  private createRunId(): string {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `run_${Date.now()}_${randomPart}`;
  }
}

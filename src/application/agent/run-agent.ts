import { EventEmitter } from "node:events";
import type { LlmConfig } from "../../core/types/config.js";
import type { ILlmClient } from "../ports/llm-client.js";
import type { IMemoryStore } from "../../core/ports/memory-store.js";
import type { IToolRegistry } from "../../core/ports/tool-registry.js";
import type { ILogger } from "../../core/ports/logger.js";
import type { IBlobStore } from "../../core/ports/blob-store.js";
import type { IWalDao } from "../ports/wal-dao.js";
import { DagExecutionGraph } from "../../core/engine/dag-graph.js";
import { DagStateStore } from "../../core/engine/state-store.js";
import type { RunOnceStreamOptions } from "../../core/engine/runner-types.js";
import type OpenAI from "openai";
import type { AgentLoopPlugin, AgentPluginRunContext } from "./plugins/agent-plugin.js";
import { extractErrorMessage } from "../../core/errors/agent-errors.js";
import {
  MAX_AGENT_STEPS,
  getDefaultToolRetries,
  getDefaultToolTimeoutMs,
} from "../../core/config/defaults.js";
import { executeOnRunStart, executeOnRunCompleted, executeOnRunError } from "./plugin-executor.js";
import { executeDag } from "../../core/engine/dag-executor.js";
import { LlmNode } from "../../domain/nodes/llm-node.js";
import { InputNode } from "../../domain/nodes/input-node.js";
import type { BaseNode } from "../../domain/nodes/base-node.js";
import { WeaveEventBus } from "../../domain/event/event-bus.js";
import { TurnEngineBusAdapter } from "./turn-engine-bus-adapter.js";
import type { RunContext, StepGateOptions } from "../session/run-context.js";
import { PendingPromiseRegistry } from "../weave/pending-promise-registry.js";
import { StepGateInterceptor } from "../weave/step-gate-interceptor.js";
import { PluginManager } from "./plugin-manager.js";
import { WeaveWalManager } from "../../infrastructure/wal/weave-wal-manager.js";
import type { IPauseSignal } from "../../core/engine/engine-types.js";
import type { InterceptDecision } from "../weave/interceptor.js";

/**
 * 暂停控制器：实现引擎层的 IPauseSignal 协议
 */
class PauseController implements IPauseSignal {
  private _paused = false;
  private _promise: Promise<void> | null = null;
  private _resolve: (() => void) | null = null;

  async wait(): Promise<void> {
    if (this._paused) {
      if (!this._promise) {
        this._promise = new Promise<void>((res) => {
          this._resolve = res;
        });
      }
      return this._promise;
    }
  }

  pause(): void {
    this._paused = true;
  }
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
      this._promise = null;
    }
  }
  isPaused(): boolean {
    return this._paused;
  }
}

// 从 event-types 重新导出，保持向后兼容
export type { AgentRunEventType, AgentRunEvent } from "../../domain/event/event-types.js";
import type { AgentRunEvent } from "../../domain/event/event-types.js";
import type { AgentPluginOutputs } from "../../domain/event/event-types.js";

/**
 * 文件作用：提供 Agent 运行时最小抽象，承接上层输入并调用 LLM 客户端生成回复。
 */

export class AgentRuntime extends EventEmitter {
  private static readonly AGENT_EVENT_SCHEMA_VERSION = "dagent.agent.event.v1";
  private static readonly NOOP_LOGGER: ILogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  private static readonly NOOP_WAL_DAO: IWalDao = {
    upsertSession: () => {},
    getSession: () => undefined,
    updateSessionHead: () => {},
    getSessions: () => [],
    insertExecution: () => {},
    updateExecutionStatus: () => {},
    getExecution: () => undefined,
    getSessionExecutions: () => [],
    insertEdge: () => {},
    insertBlackboardMessage: () => {},
    getBlackboardMessage: () => undefined,
    insertWalEvent: () => {},
    getAncestorsWalEvents: () => [],
    getExecutionWalEvents: () => [],
  };

  private static readonly NOOP_LLM_CLIENT: ILlmClient = {
    async chat() {
      throw new Error("LLM client not configured");
    },
    async chatStream() {
      throw new Error("LLM client not configured");
    },
    async chatWithTools() {
      throw new Error("LLM client not configured");
    },
  };

  private sessionId = "";
  private turnIndex = 0;
  private readonly historyMessages: import("../../application/ports/llm-client.js").ChatHistoryMessage[] =
    [];

  private readonly llmClient: ILlmClient;
  private readonly memoryStore: IMemoryStore;
  private readonly toolRegistry: IToolRegistry;
  private readonly walDao: IWalDao;
  private readonly logger: ILogger;
  private readonly blobStore?: IBlobStore;

  /** 管理当前正在运行的任务的挂起字典，key 为 runId */
  private readonly pendingRegistryByRunId = new Map<string, PendingPromiseRegistry>();
  /** 管理当前正在运行的任务的暂停信号量，key 为 runId */
  private readonly pauseSignalByRunId = new Map<string, PauseController>();

  constructor(
    private readonly llmConfig: LlmConfig,
    llmClientOrMemoryStore: ILlmClient | IMemoryStore,
    memoryStoreOrToolRegistry?: IMemoryStore | IToolRegistry,
    toolRegistryOrUndefined?: IToolRegistry,
    walDao?: IWalDao,
    logger?: ILogger,
    blobStore?: IBlobStore
  ) {
    super();

    // 兼容旧签名：new AgentRuntime(config, memoryStore, toolRegistry)
    if (this.isMemoryStore(llmClientOrMemoryStore)) {
      this.llmClient = AgentRuntime.NOOP_LLM_CLIENT;
      this.memoryStore = llmClientOrMemoryStore;
      this.toolRegistry =
        (memoryStoreOrToolRegistry as IToolRegistry) ??
        ({
          register: () => {},
          resolve: () => undefined,
          listModelTools: () => [],
          execute: async () => ({ ok: false, content: "Tool registry not configured" }),
        } satisfies IToolRegistry);
      this.walDao = AgentRuntime.NOOP_WAL_DAO;
      this.logger = AgentRuntime.NOOP_LOGGER;
      this.blobStore = undefined;
    } else {
      this.llmClient = llmClientOrMemoryStore;
      this.memoryStore = memoryStoreOrToolRegistry as IMemoryStore;
      this.toolRegistry = toolRegistryOrUndefined as IToolRegistry;
      this.walDao = walDao ?? AgentRuntime.NOOP_WAL_DAO;
      this.logger = logger ?? AgentRuntime.NOOP_LOGGER;
      this.blobStore = blobStore;
    }

    this.logger.info("runtime.init", "AgentRuntime 初始化完成 (DIP 已就绪)", {
      provider: this.llmConfig.provider,
      model: this.llmConfig.model,
    });
  }

  private isMemoryStore(value: ILlmClient | IMemoryStore): value is IMemoryStore {
    return typeof (value as IMemoryStore).buildSystemPrompt === "function";
  }

  startSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.turnIndex = 0;
    this.historyMessages.length = 0;
    this.logger.info("session.start", "会话已初始化", { sessionId });
  }

  async runOnce(userInput: string): Promise<string> {
    this.logger.info("run.once.start", "开始执行非流式调用", {
      userInputLength: userInput.length,
    });

    const composedSystemPrompt = this.memoryStore.buildSystemPrompt(this.llmConfig.systemPrompt);
    const finalText = await this.llmClient.chat({
      userMessage: userInput,
      systemPrompt: composedSystemPrompt,
      historyMessages: this.historyMessages,
    });

    this.historyMessages.push({ role: "user", content: userInput });
    this.historyMessages.push({ role: "assistant", content: finalText });

    this.logger.info("run.once.completed", "非流式调用完成", {
      responseLength: finalText.length,
    });
    return finalText;
  }

  async runOnceStream(userInput: string, options?: RunOnceStreamOptions): Promise<string> {
    return this.runOnceStreamCommon(userInput, options, (ctx) =>
      this.runAgentDagLoop(
        ctx.runId,
        userInput,
        ctx.composedSystemPrompt,
        ctx.plugins,
        ctx.basePluginContext,
        ctx.stepGate,
        options?.abortSignal
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
      userInputLength: userInput.length,
    });

    this.emitRunEvent({
      type: "run.start",
      runId,
      payload: { userInput, sessionId: this.sessionId, turnIndex: this.turnIndex },
    });

    this.emitRunEvent({
      type: "llm.request",
      runId,
      payload: { userInput, sessionId: this.sessionId, turnIndex: this.turnIndex },
    });

    try {
      const plugins = options?.plugins ?? [];
      const basePluginContext: AgentPluginRunContext = {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        userInput,
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
          approveToolCall: options?.approveToolCall,
        },
      });

      this.historyMessages.push({ role: "user", content: userInput });
      this.historyMessages.push({ role: "assistant", content: finalText });

      this.emitRunEvent({
        type: "llm.completed",
        runId,
        payload: { finalText, sessionId: this.sessionId, turnIndex: this.turnIndex },
      });

      await executeOnRunCompleted(
        plugins,
        { ...basePluginContext, finalText },
        runId,
        this.emitPluginOutput.bind(this)
      );

      this.emitRunEvent({
        type: "run.completed",
        runId,
        payload: { finalText, sessionId: this.sessionId, turnIndex: this.turnIndex },
      });

      this.logger.info("run.stream.completed", "流式调用完成", {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        responseLength: finalText.length,
      });

      return finalText;
    } catch (error: unknown) {
      const errorMessage = extractErrorMessage(error);
      const plugins = options?.plugins ?? [];
      const basePluginContext: AgentPluginRunContext = {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        userInput,
      };

      await executeOnRunError(
        plugins,
        { ...basePluginContext, errorMessage },
        runId,
        this.emitPluginOutput.bind(this)
      );

      this.logger.error("run.stream.error", "流式调用失败", {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        errorMessage,
      });
      this.emitRunEvent({
        type: "run.error",
        runId,
        payload: { errorMessage, sessionId: this.sessionId, turnIndex: this.turnIndex },
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
    stepGate: StepGateOptions,
    externalAbortSignal?: AbortSignal
  ): Promise<string> {
    const dag = new DagExecutionGraph();
    const stateStore = new DagStateStore();
    const nodeRegistry = new Map<string, BaseNode>();

    const workingMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...this.historyMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userInput },
    ];

    // 👑 挂载 WAL 管理器（拦截器）
    const walManager = new WeaveWalManager(this.walDao, this.sessionId);

    // 👑 初始化数据库记录：Session 与 Execution
    this.walDao.upsertSession({
      id: this.sessionId,
      title: userInput.slice(0, 50), // 用第一句话做标题
      head_execution_id: runId,
    });
    this.walDao.insertExecution({
      id: runId,
      session_id: this.sessionId,
      status: "RUNNING",
    });

    const bus = new WeaveEventBus(
      { runId, sessionId: this.sessionId, turnIndex: this.turnIndex },
      (evt) => this.emit("event", evt),
      walManager // 👑 注入拦截器实现 Write-Ahead
    );

    this.activeEventBus = bus;

    // 👑 挂载插件管家（Layer 3 旁路观察者）
    new PluginManager(bus, plugins);

    // Phase 2：全局 AbortController
    const abortController = new AbortController();
    const abortFromExternal = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error("external abort signal"));
      }
    };
    if (externalAbortSignal) {
      if (externalAbortSignal.aborted) {
        abortFromExternal();
      } else {
        externalAbortSignal.addEventListener("abort", abortFromExternal, { once: true });
      }
    }

    // Phase 3：拦截器基础设施
    const pendingRegistry = new PendingPromiseRegistry();
    this.pendingRegistryByRunId.set(runId, pendingRegistry);

    const pauseSignal = new PauseController();
    this.pauseSignalByRunId.set(runId, pauseSignal);

    const interceptor = stepGate.enabled
      ? new StepGateInterceptor(pendingRegistry, { enabled: true })
      : undefined;

    // abortSignal 触发时清理挂起字典
    abortController.signal.addEventListener(
      "abort",
      () => {
        pendingRegistry.rejectAll(new Error("DAG 中止"));
      },
      { once: true }
    );

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
      stepGate,
      defaultToolRetries: stepGate.autoMode === true ? getDefaultToolRetries() : 0,
      defaultToolTimeoutMs: getDefaultToolTimeoutMs(),
      logger: this.logger,
      maxSteps: MAX_AGENT_STEPS,
      abortController,
      abortSignal: abortController.signal,
      interceptor,
      pendingRegistry,
      pauseSignal,
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
      const result = await executeDag(dag, ctx);
      this.walDao.updateExecutionStatus(runId, "COMPLETED");
      return result;
    } catch (error) {
      // DagDeadlockError 的 onSchedulerIssue 已在 dag-executor 广播，此处只加可视化 error 节点
      const errorMessage = extractErrorMessage(error);
      const errorNodeId = "error";
      this.walDao.updateExecutionStatus(runId, "FAILED");
      try {
        dag.addNode(
          { id: errorNodeId, type: "system", status: "fail" },
          {
            nodeId: errorNodeId,
            kind: "system",
            title: `运行失败: ${errorMessage}`,
            status: "fail",
            error: { name: "RunError", message: errorMessage },
          }
        );
      } catch {
        // 忽略 error node 添加失败（例如节点 ID 已存在）
      }
      throw error;
    } finally {
      if (externalAbortSignal) {
        externalAbortSignal.removeEventListener("abort", abortFromExternal);
      }
      this.activeEventBus = undefined;
      this.pendingRegistryByRunId.delete(runId);
      this.pauseSignalByRunId.delete(runId);
      // 👑 销毁 WAL 管理器，触发强制刷盘
      walManager.destroy();
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

  /** 暂停指定任务的调度 */
  pauseRun(runId: string): void {
    const signal = this.pauseSignalByRunId.get(runId);
    if (signal) signal.pause();
  }

  /** 恢复指定任务的调度 */
  resumeRun(runId: string): void {
    const signal = this.pauseSignalByRunId.get(runId);
    if (signal) signal.resume();
  }

  /** 恢复指定节点在特定任务中的审批状态（传入审批结果） */
  resumeNodeGate(runId: string, nodeId: string, decision: InterceptDecision): boolean {
    const registry = this.pendingRegistryByRunId.get(runId);
    if (!registry) return false;
    return registry.resume(nodeId, decision);
  }

  private activeEventBus?: WeaveEventBus;

  private emitRunEvent(
    event: Omit<AgentRunEvent, "schemaVersion" | "eventId" | "timestamp">
  ): void {
    const enrichedEvent: AgentRunEvent = {
      ...event,
      schemaVersion: AgentRuntime.AGENT_EVENT_SCHEMA_VERSION,
      eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
    } as AgentRunEvent;

    // 👑 关键：如果当前有活跃的总线，通过总线分发以触发 WAL 拦截
    if (this.activeEventBus && this.activeEventBus.runId === enrichedEvent.runId) {
      this.activeEventBus.dispatch(enrichedEvent.type, enrichedEvent.payload);
      return;
    }

    if (enrichedEvent.type !== "llm.delta") {
      this.logger.info("event.publish", "发布运行事件", {
        runId: enrichedEvent.runId,
        eventType: enrichedEvent.type,
        eventId: enrichedEvent.eventId,
        schemaVersion: enrichedEvent.schemaVersion,
      });
    }
    this.emit("event", enrichedEvent);
  }

  private emitPluginOutput(runId: string, output: AgentPluginOutputs): void {
    if (!output) return;
    const outputs = Array.isArray(output) ? output : [output];
    for (const item of outputs) {
      this.emitRunEvent({
        type: "plugin.output",
        runId,
        payload: {
          pluginName: item.pluginName,
          outputType: item.outputType,
          outputText: item.outputText,
        },
      });
    }
  }

  private createRunId(): string {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `run_${Date.now()}_${randomPart}`;
  }
}

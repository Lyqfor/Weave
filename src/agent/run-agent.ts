import { EventEmitter } from "node:events";
import type { LlmConfig } from "../types/config.js";
import { QwenClient, type ChatHistoryMessage } from "../llm/qwen-client.js";
import { MemoryStore } from "../memory/memory-store.js";
import { AppLogger } from "../logging/app-logger.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolExecuteResult } from "../tools/tool-types.js";
import { createRuntimeRunner, type RunnerMode } from "../runtime/runner-selector.js";
import { DagExecutionGraph } from "../runtime/dag-graph.js";
import { DagStateStore } from "../runtime/state-store.js";
import type {
  AgentRunner,
  RunOnceStreamOptions,
  ToolApprovalDecision,
  ToolApprovalRequest
} from "../runtime/runner-types.js";
import type OpenAI from "openai";
import type {
  AgentLoopPlugin,
  AgentPluginOutputs,
  AgentPluginOutput,
  AgentPluginRunContext
} from "./plugins/agent-plugin.js";
import { summarizeText, tryParseJson, safeJsonStringify } from "../utils/text-utils.js";
import { extractErrorMessage } from "../errors/agent-errors.js";
import {
  MAX_AGENT_STEPS,
  getDefaultToolRetries,
  getDefaultToolTimeoutMs
} from "../config/defaults.js";
import {
  executeOnRunStart,
  executeOnRunCompleted,
  executeOnRunError,
  executeBeforeLlmRequest,
  executeAfterLlmResponse,
  executeBeforeToolExecution,
  executeAfterToolExecution
} from "./plugin-executor.js";
import {
  deriveToolIntent,
  attachIntentToToolArgs,
  extractRuntimeToolMeta,
  stripRuntimeToolMeta,
  executeToolWithTimeout as executeToolWithTimeoutFn,
  extractJsonObject,
  repairToolArgsByIntent,
  type ToolIntentInfo,
  type ToolRetryTicket,
  type ToolRepairResult
} from "./tool-executor.js";
import {
  emitDagNodeTransition,
  emitWeaveDagNode,
  emitWeaveDagDetail,
  emitDagNodeDetail,
  emitDagSchedulerIssue
} from "./weave-emitter.js";

/**
 * 文件作用：提供 Agent 运行时最小抽象，承接上层输入并调用 LLM 客户端生成回复。
 */
export type AgentRunEventType =
  | "run.start"
  | "llm.request"
  | "llm.delta"
  | "llm.completed"
  | "node.pending_approval"
  | "node.approval.resolved"
  | "tool.execution.start"
  | "tool.retry.start"
  | "tool.retry.end"
  | "tool.execution.end"
  | "plugin.output"
  | "run.completed"
  | "run.error";

export interface AgentRunEvent {
  type: AgentRunEventType;
  schemaVersion?: string;
  eventId?: string;
  eventType?: string;
  runId: string;
  timestamp: string;
  payload?: {
    text?: string;
    userInput?: string;
    errorMessage?: string;
    finalText?: string;
    sessionId?: string;
    turnIndex?: number;
    toolName?: string;
    toolOk?: boolean;
    toolCallId?: string;
    toolArgsText?: string;
    toolArgsJsonText?: string;
    toolResultText?: string;
    toolStatus?: "success" | "fail";
    retryAttempt?: number;
    retryMax?: number;
    retryReason?: string;
    retryPrepared?: boolean;
    approvalAction?: "approve" | "edit" | "skip" | "abort";
    pluginName?: string;
    outputType?: string;
    outputText?: string;
  };
}

interface StepGateOptions {
  enabled: boolean;
  autoMode?: boolean;
  approveToolCall?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

export class AgentRuntime extends EventEmitter {
  private static readonly AGENT_EVENT_SCHEMA_VERSION = "dagent.agent.event.v1";
  private readonly llmClient: QwenClient;
  private readonly memoryStore: MemoryStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly logger = new AppLogger("agent-runtime");
  private sessionId = "";
  private turnIndex = 0;
  private readonly historyMessages: ChatHistoryMessage[] = [];
  private readonly streamChunkSize = 14;
  private readonly streamChunkDelayMs = 8;
  private readonly runnerMode: RunnerMode = "legacy";
  private readonly legacyRunner: AgentRunner;
  private readonly dagRunner: AgentRunner;

  constructor(
    private readonly llmConfig: LlmConfig,
    memoryStore?: MemoryStore,
    toolRegistry?: ToolRegistry
  ) {
    super();
    // 初始化核心依赖：LLM 客户端 + 记忆存储。
    this.llmClient = new QwenClient(this.llmConfig);
    this.memoryStore = memoryStore ?? new MemoryStore();
    this.toolRegistry = toolRegistry ?? new ToolRegistry();
    this.memoryStore.ensureMemoryFiles();
    this.legacyRunner = createRuntimeRunner({
      mode: "legacy",
      executeLegacy: async ({ userInput, options }) => {
        return await this.runOnceStreamLegacy(userInput, options);
      },
      executeDag: async ({ userInput, options }) => {
        return await this.runOnceStreamDag(userInput, options);
      }
    });
    this.dagRunner = createRuntimeRunner({
      mode: "dag",
      executeLegacy: async ({ userInput, options }) => {
        return await this.runOnceStreamLegacy(userInput, options);
      },
      executeDag: async ({ userInput, options }) => {
        return await this.runOnceStreamDag(userInput, options);
      }
    });

    this.logger.info("runtime.init", "AgentRuntime 初始化完成", {
      provider: this.llmConfig.provider,
      model: this.llmConfig.model,
      runnerMode: this.runnerMode
    });
  }

  startSession(sessionId: string): void {
    // 每次新会话都重置历史，保证上下文边界清晰。
    this.sessionId = sessionId;
    this.turnIndex = 0;
    this.historyMessages.length = 0;
    this.logger.info("session.start", "会话已初始化", { sessionId });
  }

  async runOnce(userInput: string): Promise<string> {
    // 当前为单轮调用：后续可在这里扩展为多轮循环、工具调用和记忆注入。
    this.logger.info("run.once.start", "开始执行非流式调用", {
      userInputLength: userInput.length
    });

    // 先将多源记忆合成为 system prompt，再发给模型。
    const composedSystemPrompt = this.memoryStore.buildSystemPrompt(this.llmConfig.systemPrompt);
    const finalText = await this.llmClient.chat({
      userMessage: userInput,
      systemPrompt: composedSystemPrompt,
      historyMessages: this.historyMessages
    });

    // 非流式也要沉淀多轮历史，确保后续提问可引用上下文。
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
    const runner = this.shouldUseDagRunner(options) ? this.dagRunner : this.legacyRunner;
    return await runner.run({ userInput, options });
  }

  /**
   * 公共流式执行框架：setup → 核心循环 → 收尾/错误处理。
   * Legacy 和 DAG 两条路径仅在核心循环实现上不同。
   */
  private async runOnceStreamCommon(
    userInput: string,
    mode: "legacy" | "dag",
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
    const modeLabel = mode === "dag" ? "DAG " : "";

    this.logger.info("run.stream.start", `开始执行${modeLabel}流式调用`, {
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

      this.emitRunEvent({
        type: "run.completed",
        runId,
        timestamp: new Date().toISOString(),
        payload: { finalText, sessionId: this.sessionId, turnIndex: this.turnIndex }
      });

      this.logger.info("run.stream.completed", `${modeLabel}流式调用完成`, {
        runId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        responseLength: finalText.length
      });

      await executeOnRunCompleted(plugins, { ...basePluginContext, finalText }, runId, this.emitPluginOutput.bind(this));

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

      this.logger.error("run.stream.error", `${modeLabel}流式调用失败`, {
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

  private async runOnceStreamLegacy(
    userInput: string,
    options?: RunOnceStreamOptions
  ): Promise<string> {
    return this.runOnceStreamCommon(userInput, "legacy", options, (ctx) =>
      this.runAgentLoop(
        ctx.runId, userInput, ctx.composedSystemPrompt,
        ctx.plugins, ctx.basePluginContext, ctx.stepGate
      )
    );
  }

  private async runOnceStreamDag(
    userInput: string,
    options?: RunOnceStreamOptions
  ): Promise<string> {
    return this.runOnceStreamCommon(userInput, "dag", options, (ctx) =>
      this.runAgentDagLoop(
        ctx.runId, userInput, ctx.composedSystemPrompt,
        ctx.plugins, ctx.basePluginContext, ctx.stepGate
      )
    );
  }

  private async runAgentDagLoop(
    runId: string,
    userInput: string,
    systemPrompt: string,
    plugins: AgentLoopPlugin[],
    basePluginContext: AgentPluginRunContext,
    stepGate: StepGateOptions
  ): Promise<string> {
    type ToolNodePayload = {
      step: number;
      displayNodeId: string;
      toolCallId: string;
      toolName: string;
      intentSummary: string;
      toolGoal: string;
      rawArgsText: string;
      maxRetries: number;
      timeoutMs: number;
    };

    type FinalNodePayload = {
      text: string;
    };

    const maxSteps = MAX_AGENT_STEPS;
    const defaultToolRetries = stepGate.autoMode === true ? getDefaultToolRetries() : 0;
    const defaultToolTimeoutMs = getDefaultToolTimeoutMs();
    const modelTools = this.toolRegistry.listModelTools();
    const graph = new DagExecutionGraph();
    const stateStore = new DagStateStore();
    const workingMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = this.historyMessages.map(
      (message) => ({
        role: message.role,
        content: message.content
      })
    );
    workingMessages.push({ role: "user", content: userInput });
    stateStore.setRunValue("userInput", userInput);

    let finalText = "";

    const transitionNode = (nodeId: string, toStatus: "ready" | "running" | "blocked" | "success" | "fail" | "skipped" | "aborted", reason?: string): void => {
      const nodeBefore = graph.getNode(nodeId);
      const transition = graph.transitionStatus(nodeId, toStatus, reason);
      emitDagNodeTransition(runId, {
        nodeId,
        nodeType: nodeBefore.type,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        reason: transition.reason
      }, this.emitPluginOutput.bind(this));
    };

    const addLlmNode = (step: number, dependsOnNodeIds: string[] = []): string => {
      const nodeId = `llm-${step}`;
      graph.addNode({
        id: nodeId,
        type: "llm",
        status: "pending",
        payload: { step }
      });

      for (let index = 0; index < dependsOnNodeIds.length; index += 1) {
        const depId = dependsOnNodeIds[index];
        graph.addEdge(depId, nodeId);
        graph.addDataEdge({
          fromNodeId: depId,
          toNodeId: nodeId,
          fromKey: "content",
          toKey: `tool_${index + 1}`
        });
      }

      return nodeId;
    };

    addLlmNode(1);
    graph.validateIntegrity();

    while (graph.hasPendingWork()) {
      const readyNodeIds = graph.getReadyNodeIds().sort();
      if (readyNodeIds.length === 0) {
        const remainingNodeIds = graph.getInProgressNodeIds();
        emitDagSchedulerIssue(runId, "dag.scheduler.deadlock", {
          message: "DAG 调度死锁：存在未完成节点但无可执行 ready 节点",
          remainingNodeIds
        }, this.emitPluginOutput.bind(this));
        throw new Error("DAG 调度死锁：存在未完成节点但无可执行 ready 节点");
      }

      const currentNodeId = readyNodeIds[0];
      const node = graph.getNode(currentNodeId);
      transitionNode(currentNodeId, "running", "scheduler-picked-ready-node");

      if (node.type === "llm") {
        const step = (node.payload as { step: number }).step;
        const dagInput = stateStore.resolveNodeInput(graph, currentNodeId);
        stateStore.setRunValue(`${currentNodeId}.input`, dagInput);

        this.logger.info("run.dag.step", "DAG 调度执行 LLM 节点", {
          runId,
          step,
          nodeId: currentNodeId,
          sessionId: this.sessionId,
          turnIndex: this.turnIndex,
          modelToolCount: modelTools.length,
          dagInputKeys: Object.keys(dagInput)
        });

        let effectiveSystemPrompt = systemPrompt;
        for (const plugin of plugins) {
          const changed = await plugin.beforeLlmRequest?.({
            ...basePluginContext,
            step,
            systemPrompt: effectiveSystemPrompt,
            messages: workingMessages
          });

          if (changed?.systemPrompt) {
            effectiveSystemPrompt = changed.systemPrompt;
          }

          this.emitPluginOutput(runId, changed?.output);
        }

        const assistantMessage = await this.invokeLlmWithTools({
          systemPrompt: effectiveSystemPrompt,
          messages: workingMessages,
          tools: modelTools
        });

        stateStore.setNodeOutput(currentNodeId, {
          ok: true,
          content: assistantMessage.content ?? "",
          metadata: {
            toolCallCount: assistantMessage.tool_calls?.length ?? 0,
            step
          }
        });

        for (const plugin of plugins) {
          const output = await plugin.afterLlmResponse?.({
            ...basePluginContext,
            step,
            assistantMessage
          });
          this.emitPluginOutput(runId, output);
        }

        const toolCalls = assistantMessage.tool_calls ?? [];
        if (toolCalls.length === 0) {
          const finalNodeId = `final-${step}`;
          graph.addNode({
            id: finalNodeId,
            type: "final",
            status: "pending",
            payload: {
              text: assistantMessage.content ?? ""
            } satisfies FinalNodePayload
          });
          graph.addEdge(currentNodeId, finalNodeId);
          graph.addDataEdge({
            fromNodeId: currentNodeId,
            toNodeId: finalNodeId,
            fromKey: "content",
            toKey: "finalText"
          });

          transitionNode(currentNodeId, "success", "llm-final-answer");
          continue;
        }

        workingMessages.push({
          role: "assistant",
          content: assistantMessage.content ?? "",
          tool_calls: toolCalls
        });

        const toolNodeIds: string[] = [];
        for (let index = 0; index < toolCalls.length; index += 1) {
          const toolCall = toolCalls[index];
          const parsedToolArgs = tryParseJson(toolCall.function.arguments || "{}") ?? {};
          const intent = deriveToolIntent(
            assistantMessage.content,
            toolCall.function.name,
            parsedToolArgs,
            userInput
          );
          const toolNodeId = `tool-${step}-${index + 1}`;
          const displayNodeId = `${step}.${index + 1}`;
          graph.addNode({
            id: toolNodeId,
            type: "tool",
            status: "pending",
            payload: {
              step,
              displayNodeId,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              intentSummary: intent.summary,
              toolGoal: intent.goal,
              rawArgsText: safeJsonStringify(attachIntentToToolArgs(parsedToolArgs, intent)),
              maxRetries: defaultToolRetries,
              timeoutMs: defaultToolTimeoutMs
            } satisfies ToolNodePayload
          });
          graph.addEdge(currentNodeId, toolNodeId);
          graph.addDataEdge({
            fromNodeId: currentNodeId,
            toNodeId: toolNodeId,
            fromKey: "content",
            toKey: "llmDecision"
          });
          toolNodeIds.push(toolNodeId);
        }

        if (step + 1 <= maxSteps) {
          addLlmNode(step + 1, toolNodeIds);
        } else {
          const finalNodeId = `final-max-${step}`;
          graph.addNode({
            id: finalNodeId,
            type: "final",
            status: "pending",
            payload: {
              text: "已达到最大工具调用步数，请缩小问题范围后重试。"
            } satisfies FinalNodePayload
          });
          for (const toolNodeId of toolNodeIds) {
            graph.addEdge(toolNodeId, finalNodeId);
            graph.addDataEdge({
              fromNodeId: toolNodeId,
              toNodeId: finalNodeId,
              fromKey: "content",
              toKey: toolNodeId
            });
          }
        }

        graph.validateIntegrity();
        transitionNode(currentNodeId, "success", "llm-scheduled-next-nodes");
        continue;
      }

      if (node.type === "tool") {
        const payload = node.payload as ToolNodePayload;
        const step = payload.step;
        const detailNodeId = payload.displayNodeId || currentNodeId;
        const dagInput = stateStore.resolveNodeInput(graph, currentNodeId);
        stateStore.setRunValue(`${currentNodeId}.input`, dagInput);

        const parsedArgs = tryParseJson(payload.rawArgsText || "{}") ?? {};
        const runtimeMeta = extractRuntimeToolMeta(parsedArgs);
        const intentSummary = runtimeMeta.intentSummary || payload.intentSummary;
        const toolGoal = runtimeMeta.toolGoal || payload.toolGoal;

        let effectiveArgs = parsedArgs;
        let skipByApproval = false;

        if (intentSummary) {
          emitDagNodeDetail(runId, {
            nodeId: detailNodeId,
            text: `intent=${intentSummary}`
          }, this.emitPluginOutput.bind(this));
        }
        if (toolGoal) {
          emitDagNodeDetail(runId, {
            nodeId: detailNodeId,
            text: `goal=${toolGoal}`
          }, this.emitPluginOutput.bind(this));
        }

        if (stepGate.enabled && stepGate.approveToolCall) {
          transitionNode(currentNodeId, "blocked", "waiting-user-approval");
          this.emitRunEvent({
            type: "node.pending_approval",
            runId,
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: this.sessionId,
              turnIndex: this.turnIndex,
              toolName: payload.toolName,
              toolCallId: payload.toolCallId,
              toolArgsText: summarizeText(parsedArgs),
              toolArgsJsonText: safeJsonStringify(parsedArgs)
            }
          });

          const decision = await stepGate.approveToolCall({
            runId,
            step,
            toolName: payload.toolName,
            toolCallId: payload.toolCallId,
            args: parsedArgs,
            argsText: safeJsonStringify(parsedArgs)
          });

          if (decision.action === "abort") {
            this.emitRunEvent({
              type: "node.approval.resolved",
              runId,
              timestamp: new Date().toISOString(),
              payload: {
                sessionId: this.sessionId,
                turnIndex: this.turnIndex,
                toolName: payload.toolName,
                toolCallId: payload.toolCallId,
                approvalAction: "abort"
              }
            });
            transitionNode(currentNodeId, "aborted", "approval-aborted");
            throw new Error("用户终止了当前回合执行");
          }

          if (decision.action === "edit" && decision.editedArgs !== undefined) {
            effectiveArgs =
              decision.editedArgs && typeof decision.editedArgs === "object"
                ? (decision.editedArgs as Record<string, unknown>)
                : {};
          }

          if (decision.action === "skip") {
            skipByApproval = true;
          }

          this.emitRunEvent({
            type: "node.approval.resolved",
            runId,
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: this.sessionId,
              turnIndex: this.turnIndex,
              toolName: payload.toolName,
              toolCallId: payload.toolCallId,
              approvalAction: decision.action,
              toolArgsText: summarizeText(effectiveArgs),
              toolArgsJsonText: safeJsonStringify(effectiveArgs)
            }
          });

          if (skipByApproval) {
            stateStore.setNodeOutput(currentNodeId, {
              ok: false,
              content: "[SKIPPED by approval gate]",
              metadata: {
                skippedByUser: true,
                dagInput
              }
            });
            transitionNode(currentNodeId, "skipped", "approval-skipped");
            continue;
          }

          transitionNode(currentNodeId, "running", "approval-resumed");
        }

        this.emitRunEvent({
          type: "tool.execution.start",
          runId,
          timestamp: new Date().toISOString(),
          payload: {
            sessionId: this.sessionId,
            turnIndex: this.turnIndex,
            toolName: payload.toolName,
            toolCallId: payload.toolCallId,
            toolArgsText: summarizeText(effectiveArgs),
            toolArgsJsonText: safeJsonStringify(effectiveArgs)
          }
        });

        for (const plugin of plugins) {
          const output = await plugin.beforeToolExecution?.({
            ...basePluginContext,
            step,
            toolName: payload.toolName,
            toolCallId: payload.toolCallId,
            args: effectiveArgs
          });
          this.emitPluginOutput(runId, output);
        }

        let attempt = 0;
        const totalAttempts = payload.maxRetries + 1;
        let result: ToolExecuteResult = {
          ok: false,
          content: "工具执行失败",
          metadata: {}
        };

        while (attempt <= payload.maxRetries) {
          attempt += 1;
          const attemptNodeId = `${detailNodeId}.${attempt * 2 - 1}`;
          const attemptLabel = attempt === 1 ? `工具执行尝试 #${attempt}` : `自动重试执行 #${attempt}`;
          emitWeaveDagNode(runId, {
            nodeId: attemptNodeId,
            parentId: detailNodeId,
            label: attemptLabel,
            status: "running"
          }, this.emitPluginOutput.bind(this));
          emitWeaveDagDetail(runId, {
            nodeId: attemptNodeId,
            text: `attempt=${attempt}/${totalAttempts}`
          }, this.emitPluginOutput.bind(this));

          const attemptStartedAt = Date.now();
          result = await executeToolWithTimeoutFn(this.toolRegistry, {
            toolName: payload.toolName,
            args: effectiveArgs,
            timeoutMs: payload.timeoutMs,
            runId,
            step,
            toolCallId: payload.toolCallId,
            sessionId: this.sessionId
          }, this.logger);
          const attemptElapsedMs = Math.max(0, Date.now() - attemptStartedAt);

          if (result.ok) {
            emitWeaveDagNode(runId, {
              nodeId: attemptNodeId,
              parentId: detailNodeId,
              label: attemptLabel,
              status: "success"
            }, this.emitPluginOutput.bind(this));
            emitWeaveDagDetail(runId, {
              nodeId: attemptNodeId,
              text: `ok elapsed=${attemptElapsedMs}ms result=${summarizeText(result.content, 160)}`
            }, this.emitPluginOutput.bind(this));
            break;
          }

          emitWeaveDagNode(runId, {
            nodeId: attemptNodeId,
            parentId: detailNodeId,
            label: attemptLabel,
            status: "fail"
          }, this.emitPluginOutput.bind(this));
          emitWeaveDagDetail(runId, {
            nodeId: attemptNodeId,
            text: `fail elapsed=${attemptElapsedMs}ms reason=${summarizeText(result.content, 160)}`
          }, this.emitPluginOutput.bind(this));

          if (attempt <= payload.maxRetries) {
            this.emitRunEvent({
              type: "tool.retry.start",
              runId,
              timestamp: new Date().toISOString(),
              payload: {
                sessionId: this.sessionId,
                turnIndex: this.turnIndex,
                toolName: payload.toolName,
                toolCallId: payload.toolCallId,
                retryAttempt: attempt,
                retryMax: payload.maxRetries,
                retryReason: summarizeText(result.content)
              }
            });

            const repairNodeId = `${detailNodeId}.${attempt * 2}`;
            emitWeaveDagNode(runId, {
              nodeId: repairNodeId,
              parentId: detailNodeId,
              label: `局部修复参数 #${attempt}`,
              status: "running"
            }, this.emitPluginOutput.bind(this));
            const repairTicket: ToolRetryTicket = {
              toolName: payload.toolName,
              intentSummary,
              previousArgs: stripRuntimeToolMeta(effectiveArgs),
              lastResult: summarizeText(result.content, 300)
            };
            const repairResult = await repairToolArgsByIntent(repairTicket, this.memoryStore.buildSystemPrompt(this.llmConfig.systemPrompt), (input) => this.invokeLlmText(input));
            if (repairResult.repairedArgs) {
              effectiveArgs = attachIntentToToolArgs(repairResult.repairedArgs, {
                summary: intentSummary,
                goal: toolGoal
              });
            }

            emitWeaveDagNode(runId, {
              nodeId: repairNodeId,
              parentId: detailNodeId,
              label: `局部修复参数 #${attempt}`,
              status: "success"
            }, this.emitPluginOutput.bind(this));
            emitWeaveDagDetail(runId, {
              nodeId: repairNodeId,
              text: `llm_output=${summarizeText(repairResult.llmOutput, 200)}`
            }, this.emitPluginOutput.bind(this));
            emitWeaveDagDetail(runId, {
              nodeId: repairNodeId,
              text: repairResult.repairedArgs
                ? `repaired_args=${safeJsonStringify(stripRuntimeToolMeta(repairResult.repairedArgs))}`
                : `repaired_args=${safeJsonStringify(stripRuntimeToolMeta(effectiveArgs))}`
            }, this.emitPluginOutput.bind(this));

            this.emitRunEvent({
              type: "tool.retry.end",
              runId,
              timestamp: new Date().toISOString(),
              payload: {
                sessionId: this.sessionId,
                turnIndex: this.turnIndex,
                toolName: payload.toolName,
                toolCallId: payload.toolCallId,
                retryAttempt: attempt,
                retryMax: payload.maxRetries,
                retryPrepared: repairResult.repairedArgs !== null
              }
            });

            emitDagNodeDetail(runId, {
              nodeId: detailNodeId,
              text: `retries=${attempt}/${payload.maxRetries} ${repairResult.repairedArgs ? "args=updated" : "args=unchanged"}`
            }, this.emitPluginOutput.bind(this));
          }
        }

        if (!result.ok && payload.maxRetries > 0) {
          this.emitRunEvent({
            type: "tool.retry.end",
            runId,
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: this.sessionId,
              turnIndex: this.turnIndex,
              toolName: payload.toolName,
              toolCallId: payload.toolCallId,
              retryAttempt: attempt,
              retryMax: payload.maxRetries,
              retryPrepared: false,
              retryReason: "重试次数已耗尽"
            }
          });
        }

        for (const plugin of plugins) {
          const output = await plugin.afterToolExecution?.({
            ...basePluginContext,
            step,
            toolName: payload.toolName,
            toolCallId: payload.toolCallId,
            args: effectiveArgs,
            result
          });
          this.emitPluginOutput(runId, output);
        }

        this.emitRunEvent({
          type: "tool.execution.end",
          runId,
          timestamp: new Date().toISOString(),
          payload: {
            sessionId: this.sessionId,
            turnIndex: this.turnIndex,
            toolName: payload.toolName,
            toolCallId: payload.toolCallId,
            toolOk: result.ok,
            toolStatus: result.ok ? "success" : "fail",
            toolResultText: summarizeText(result.content)
          }
        });

        stateStore.setNodeOutput(currentNodeId, {
          ok: result.ok,
          content: result.content,
          metadata: {
            ...result.metadata,
            attempt,
            dagInput
          }
        });

        workingMessages.push({
          role: "tool",
          tool_call_id: payload.toolCallId,
          content: JSON.stringify({
            ok: result.ok,
            content: result.content,
            metadata: {
              ...result.metadata,
              attempt,
              dagInput
            }
          })
        });

        transitionNode(currentNodeId, result.ok ? "success" : "fail", result.ok ? "tool-ok" : "tool-failed");
        continue;
      }

      if (node.type === "final") {
        const payload = node.payload as FinalNodePayload;
        const resolvedFinalInput = stateStore.resolveNodeInput(graph, currentNodeId);
        finalText = payload.text || (typeof resolvedFinalInput.finalText === "string" ? resolvedFinalInput.finalText : "");
        await this.emitTextAsStream(runId, finalText);
        stateStore.setNodeOutput(currentNodeId, {
          ok: true,
          content: finalText
        });
        transitionNode(currentNodeId, "success", "final-emitted");
        return finalText;
      }
    }

    if (!finalText) {
      finalText = "已达到最大工具调用步数，请缩小问题范围后重试。";
      await this.emitTextAsStream(runId, finalText);
    }

    return finalText;
  }

  private async runAgentLoop(
    runId: string,
    userInput: string,
    systemPrompt: string,
    plugins: AgentLoopPlugin[],
    basePluginContext: AgentPluginRunContext,
    stepGate: StepGateOptions
  ): Promise<string> {
    // 每轮最多执行 maxSteps 次，防止模型和工具之间出现无限循环。
    const maxSteps = MAX_AGENT_STEPS;
    const modelTools = this.toolRegistry.listModelTools();

    // 构建本轮工作消息：历史用户/助手对话 + 本轮用户输入。
    const workingMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = this.historyMessages.map(
      (message) => ({
        role: message.role,
        content: message.content
      })
    );
    workingMessages.push({ role: "user", content: userInput });

    for (let step = 1; step <= maxSteps; step += 1) {
      this.logger.info("run.loop.step", "Agent loop 执行中", {
        runId,
        step,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        modelToolCount: modelTools.length
      });

      // 在 LLM 输入前执行插件钩子（Weave 可在此改写提示词）。
      let effectiveSystemPrompt = systemPrompt;
      for (const plugin of plugins) {
        const changed = await plugin.beforeLlmRequest?.({
          ...basePluginContext,
          step,
          systemPrompt: effectiveSystemPrompt,
          messages: workingMessages
        });

        if (changed?.systemPrompt) {
          effectiveSystemPrompt = changed.systemPrompt;
        }

        this.emitPluginOutput(runId, changed?.output);
      }

      // 调用模型获取回复，包含文本和工具调用指令。
      const assistantMessage = await this.invokeLlmWithTools({
        systemPrompt: effectiveSystemPrompt,
        messages: workingMessages,
        tools: modelTools
      });

      // 在 LLM 输出后执行插件钩子（Weave 可记录 DAG 节点）。
      for (const plugin of plugins) {
        const output = await plugin.afterLlmResponse?.({
          ...basePluginContext,
          step,
          assistantMessage
        });
        this.emitPluginOutput(runId, output);
      }

      const toolCalls = assistantMessage.tool_calls ?? [];
      // 模型回复中不包含工具调用时，认为本轮对话完成，输出最终文本。
      if (toolCalls.length === 0) {
        const finalText = assistantMessage.content ?? "";
        // 无工具调用时，按分片发送最终文本，恢复终端可见的流式体验。
        await this.emitTextAsStream(runId, finalText);
        return finalText;
      }

      // 将 assistant 的工具调用消息写入上下文，供后续 tool 消息正确关联。
      workingMessages.push({
        role: "assistant",
        content: assistantMessage.content ?? "",
        tool_calls: toolCalls
      });

      // 逐个执行工具；工具结果回填给模型继续推理。
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolIntent = deriveToolIntent(
          assistantMessage.content,
          toolName,
          tryParseJson(toolCall.function.arguments || "{}") ?? {},
          userInput
        );

        const parsedArgs: unknown = attachIntentToToolArgs(
          tryParseJson(toolCall.function.arguments || "{}") ?? {},
          toolIntent
        );

        let effectiveArgs = parsedArgs;
        let skipByApproval = false;
        if (stepGate.enabled && stepGate.approveToolCall) {
          this.emitRunEvent({
            type: "node.pending_approval",
            runId,
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: this.sessionId,
              turnIndex: this.turnIndex,
              toolName,
              toolCallId: toolCall.id,
              toolArgsText: summarizeText(parsedArgs),
              toolArgsJsonText: safeJsonStringify(parsedArgs)
            }
          });

          const decision = await stepGate.approveToolCall({
            runId,
            step,
            toolName,
            toolCallId: toolCall.id,
            args: parsedArgs,
            argsText: safeJsonStringify(parsedArgs)
          });

          if (decision.action === "abort") {
            this.emitRunEvent({
              type: "node.approval.resolved",
              runId,
              timestamp: new Date().toISOString(),
              payload: {
                sessionId: this.sessionId,
                turnIndex: this.turnIndex,
                toolName,
                toolCallId: toolCall.id,
                approvalAction: "abort"
              }
            });
            throw new Error("用户终止了当前回合执行");
          }

          if (decision.action === "edit" && decision.editedArgs !== undefined) {
            effectiveArgs =
              decision.editedArgs && typeof decision.editedArgs === "object"
                ? (decision.editedArgs as Record<string, unknown>)
                : {};
          }

          if (decision.action === "skip") {
            skipByApproval = true;
          }

          this.emitRunEvent({
            type: "node.approval.resolved",
            runId,
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: this.sessionId,
              turnIndex: this.turnIndex,
              toolName,
              toolCallId: toolCall.id,
              approvalAction: decision.action,
              toolArgsText: summarizeText(effectiveArgs),
              toolArgsJsonText: safeJsonStringify(effectiveArgs)
            }
          });
        }

        this.emitRunEvent({
          type: "tool.execution.start",
          runId,
          timestamp: new Date().toISOString(),
          payload: {
            sessionId: this.sessionId,
            turnIndex: this.turnIndex,
            toolName,
            toolCallId: toolCall.id,
            toolArgsText: summarizeText(effectiveArgs),
            toolArgsJsonText: safeJsonStringify(effectiveArgs)
          }
        });

        for (const plugin of plugins) {
          const output = await plugin.beforeToolExecution?.({
            ...basePluginContext,
            step,
            toolName,
            toolCallId: toolCall.id,
            args: effectiveArgs
          });
          this.emitPluginOutput(runId, output);
        }

        const maxRetries = stepGate.autoMode === true ? getDefaultToolRetries() : 0;
        let result: ToolExecuteResult =
          skipByApproval
            ? {
                ok: false,
                content: "[SKIPPED by approval gate]",
                metadata: { skippedByUser: true }
              }
            : {
                ok: false,
                content: "工具执行失败",
                metadata: {}
              };

        if (!skipByApproval) {
          let attempt = 0;
          while (attempt <= maxRetries) {
            attempt += 1;
            result = await this.toolRegistry.execute(toolName, stripRuntimeToolMeta(effectiveArgs), {
              sessionId: this.sessionId,
              runId,
              workspaceRoot: process.cwd()
            });

            if (result.ok || attempt > maxRetries) {
              break;
            }

            const repairResult = await repairToolArgsByIntent(
              {
                toolName,
                intentSummary: toolIntent.summary,
                previousArgs: stripRuntimeToolMeta(effectiveArgs),
                lastResult: summarizeText(result.content, 300)
              },
              systemPrompt,
              (input) => this.invokeLlmText(input)
            );
            if (repairResult.repairedArgs) {
              effectiveArgs = attachIntentToToolArgs(repairResult.repairedArgs, toolIntent);
            }
          }
        }

        for (const plugin of plugins) {
          const output = await plugin.afterToolExecution?.({
            ...basePluginContext,
            step,
            toolName,
            toolCallId: toolCall.id,
            args: effectiveArgs,
            result
          });
          this.emitPluginOutput(runId, output);
        }

        this.emitRunEvent({
          type: "tool.execution.end",
          runId,
          timestamp: new Date().toISOString(),
          payload: {
            sessionId: this.sessionId,
            turnIndex: this.turnIndex,
            toolName,
            toolCallId: toolCall.id,
            toolOk: result.ok,
            toolStatus: result.ok ? "success" : "fail",
            toolResultText: summarizeText(result.content)
          }
        });

        workingMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            ok: result.ok,
            content: result.content,
            metadata: result.metadata
          })
        });
      }

    }

    const fallback = "已达到最大工具调用步数，请缩小问题范围后重试。";
    await this.emitTextAsStream(runId, fallback);
    return fallback;
  }

  private async emitTextAsStream(runId: string, text: string): Promise<void> {
    // 统一分片发射器：供“最终回答输出”与“工具过程提示”复用，避免多处重复实现。
    if (!text) {
      return;
    }

    const chunks = this.splitText(text, this.streamChunkSize);
    for (const chunk of chunks) {
      this.emitRunEvent({
        type: "llm.delta",
        runId,
        timestamp: new Date().toISOString(),
        payload: { text: chunk }
      });

      if (this.streamChunkDelayMs > 0) {
        await this.sleep(this.streamChunkDelayMs);
      }
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

  private async invokeLlmWithTools(input: {
    systemPrompt: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  }): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> {
    return await this.llmClient.chatWithTools(input);
  }

  private async invokeLlmText(input: {
    systemPrompt: string;
    userMessage: string;
  }): Promise<string> {
    return await this.llmClient.chat({
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      historyMessages: []
    });
  }

  private shouldUseDagRunner(options?: RunOnceStreamOptions): boolean {
    if (!options?.plugins || options.plugins.length === 0) {
      return false;
    }

    return options.plugins.some((plugin) => plugin.name === "weave");
  }


  private emitRunEvent(event: AgentRunEvent): void {
    // 统一在事件发布点做日志打标，保证链路可追踪。
    // delta 事件数量较大，避免刷屏，仅记录关键阶段事件。
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

  private emitPluginOutput(runId: string, output: AgentPluginOutputs): void {
    if (!output) {
      return;
    }

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

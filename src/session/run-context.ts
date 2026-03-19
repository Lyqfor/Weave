/**
 * 文件作用：RunContext 接口 — 注入到每个 DAG 节点执行方法中的运行时上下文。
 * RunContext extends EngineContext，在引擎最小依赖集之上叠加智能体层依赖。
 * EngineContext：runId/dag/abortSignal/abortController/nodeRegistry/stateStore/snapshotStore/logger
 * RunContext 额外：LLM/工具/插件/记忆/Step Gate/流式输出等
 */
import type { QwenClient } from "../llm/qwen-client.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { BaseNode } from "../nodes/base-node.js";
import type { WeaveEventBus } from "../event/event-bus.js";
import type { AgentLoopPlugin, AgentPluginRunContext } from "../agent/plugins/agent-plugin.js";
import type OpenAI from "openai";
import type { ToolApprovalRequest, ToolApprovalDecision } from "../engine/runner-types.js";
import type { INodeInterceptor } from "../weave/interceptor.js";
import type { PendingPromiseRegistry } from "../weave/pending-promise-registry.js";
import type { EngineContext } from "../engine/engine-types.js";

export interface StepGateOptions {
  enabled: boolean;
  autoMode?: boolean;
  approveToolCall?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

export interface RunContext extends EngineContext {
  // ── 覆盖 EngineContext.nodeRegistry 为更精确的类型 ──────────────────────────
  nodeRegistry: Map<string, BaseNode>;

  // ── 智能体层依赖 ─────────────────────────────────────────────────────────────
  sessionId: string;
  turnIndex: number;
  bus: WeaveEventBus;
  llmClient: QwenClient;
  toolRegistry: ToolRegistry;
  memoryStore: MemoryStore;
  workingMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  systemPrompt: string;
  plugins: AgentLoopPlugin[];
  basePluginContext: AgentPluginRunContext;
  stepGate: StepGateOptions;
  defaultToolRetries: number;
  defaultToolTimeoutMs: number;
  maxSteps: number;
  /** 流式文本输出（分片 emit llm.delta 事件） */
  emitTextAsStream: (text: string) => Promise<void>;

  // ── Step Gate 人机交互层 ────────────────────────────────────────────────────
  /** 节点拦截器（独立双轨制：Plugin = 被动观察，Interceptor = 主动控制） */
  interceptor?: INodeInterceptor;
  /** 挂起字典（超时保护 + rejectAll 清空）— ⛔️ 不得下沉到 EngineContext */
  pendingRegistry?: PendingPromiseRegistry;
}

import type OpenAI from "openai";
import type { ToolExecuteResult } from "../../tools/tool-types.js";

/**
 * 文件作用：定义 Agent-loop 插件接口与钩子上下文，支持在关键执行点扩展能力（如 Weave）。
 */
export interface AgentPluginOutput {
  pluginName: string;
  outputType: string;
  outputText: string;
}

export type AgentPluginOutputs = AgentPluginOutput | AgentPluginOutput[] | void;

export interface AgentPluginRunContext {
  runId: string;
  sessionId: string;
  turnIndex: number;
  userInput: string;
}

export interface BeforeLlmRequestContext extends AgentPluginRunContext {
  step: number;
  systemPrompt: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}

export interface AfterLlmResponseContext extends AgentPluginRunContext {
  step: number;
  assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessage;
}

export interface BeforeToolExecutionContext extends AgentPluginRunContext {
  step: number;
  toolName: string;
  toolCallId: string;
  args: unknown;
  /** 工具调用意图摘要（来自 LLM 输出或 deriveToolIntent 推导） */
  intentSummary?: string;
  /** 当前尝试次数（1-indexed，第一次为 1） */
  attempt: number;
  /** 最大重试次数（0 表示不重试，仅执行一次） */
  maxRetries: number;
  /** 上次失败原因（仅 attempt > 1 时有值） */
  previousError?: string;
  /** 修复前的参数（仅 attempt > 1 且参数已被 RepairLLM 修复时有值） */
  repairedFrom?: Record<string, unknown>;
}

export interface AfterToolExecutionContext extends AgentPluginRunContext {
  step: number;
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: ToolExecuteResult;
  /** 工具调用意图摘要 */
  intentSummary?: string;
  /** 本次尝试次数（1-indexed） */
  attempt: number;
  /** 总尝试次数上限（maxRetries + 1） */
  totalAttempts: number;
  /** 参数是否经过 RepairLLM 修复 */
  wasRepaired: boolean;
  /** 是否所有尝试均失败（最后一次失败时为 true，触发 Escalation） */
  allFailed?: boolean;
}

export interface RunCompletedContext extends AgentPluginRunContext {
  finalText: string;
}

export interface RunErrorContext extends AgentPluginRunContext {
  errorMessage: string;
}

export interface AgentLoopPlugin {
  name: string;
  onRunStart?: (context: AgentPluginRunContext) => Promise<AgentPluginOutputs> | AgentPluginOutputs;
  beforeLlmRequest?: (
    context: BeforeLlmRequestContext
  ) =>
    | Promise<{ systemPrompt?: string; output?: AgentPluginOutput | AgentPluginOutput[] } | void>
    | { systemPrompt?: string; output?: AgentPluginOutput | AgentPluginOutput[] }
    | void;
  afterLlmResponse?: (context: AfterLlmResponseContext) => Promise<AgentPluginOutputs> | AgentPluginOutputs;
  beforeToolExecution?: (
    context: BeforeToolExecutionContext
  ) => Promise<AgentPluginOutputs> | AgentPluginOutputs;
  afterToolExecution?: (
    context: AfterToolExecutionContext
  ) => Promise<AgentPluginOutputs> | AgentPluginOutputs;
  onRunCompleted?: (context: RunCompletedContext) => Promise<AgentPluginOutputs> | AgentPluginOutputs;
  onRunError?: (context: RunErrorContext) => Promise<AgentPluginOutputs> | AgentPluginOutputs;
}

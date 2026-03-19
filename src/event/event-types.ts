/**
 * 文件作用：所有 Agent 运行事件类型定义（纯类型，零依赖）。
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
  | "node.validation_error"
  | "run.completed"
  | "run.error"
  | "engine.node.created"
  | "engine.edge.created"
  | "engine.data.edge.created"
  | "engine.node.transition"
  | "engine.node.io"
  | "engine.scheduler.issue"
  | "engine.node.stream.delta";

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
    nodeId?: string;
    errors?: string[];
    // engine.* 事件字段
    nodeType?: string;
    fromId?: string;
    toId?: string;
    kind?: string;
    fromNodeId?: string;
    toNodeId?: string;
    fromKey?: string;
    toKey?: string;
    fromStatus?: string;
    toStatus?: string;
    reason?: string;
    updatedPayload?: Record<string, unknown>;
    issueType?: string;
    message?: string;
    nodeIds?: string[];
    payload?: Record<string, unknown>;
    // engine.node.io 端口字段
    inputPorts?: unknown[];
    outputPorts?: unknown[];
    error?: unknown;
    metrics?: unknown;
    // engine.node.stream.delta 字段
    chunkText?: string;
  };
}

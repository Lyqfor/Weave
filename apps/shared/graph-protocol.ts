/**
 * 文件作用：二维图投影协议类型定义（前后端唯一权威来源）。
 * 所有消费方（graph-server、graph-web）统一从此文件导入。
 */

export const GRAPH_SCHEMA_VERSION = "weave.graph.v1" as const;

export type GraphEventType =
  | "run.start"
  | "node.upsert"
  | "edge.upsert"
  | "node.status"
  | "node.io"
  | "layout.hint"
  | "run.end"
  | "node.pending_approval"
  | "node.approval.resolved";

export interface GraphEnvelope<TPayload = unknown> {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  seq: number;
  runId: string;
  dagId: string;
  eventType: GraphEventType;
  timestamp: string;
  payload: TPayload;
}

// ─── 统一节点 Kind / Status 枚举 ────────────────────────────────────────────

export type NodeKind =
  | "input"
  | "llm"
  | "tool"
  | "attempt"
  | "repair"
  | "escalation"
  | "gate"
  | "final"
  | "system"
  | "condition";

export type NodeStatus =
  | "pending"
  | "ready"
  | "blocked"
  | "running"
  | "waiting"
  | "retrying"
  | "success"
  | "fail"
  | "skipped"
  | "aborted";

// ─── 观测与错误类型 ──────────────────────────────────────────────────────────

export interface NodeMetrics {
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  [key: string]: unknown;
}

export interface NodeError {
  name: string;
  message: string;
  stack?: string;
}

// ─── GraphPort（支持原生 content + blobRef 大数据引用） ──────────────────────

export interface GraphPort {
  name: string;
  type: "text" | "json" | "messages" | "number";
  /**
   * 原生内容（直接传 Object/Array，无双重序列化）。
   * 超过 50KB 时为 null，由 blobRef 替代。
   */
  content: unknown;
  blobRef?: string;
}

// ─── BaseNodePayload（权威前后端 DTO） ───────────────────────────────────────

export interface BaseNodePayload {
  nodeId: string;
  kind: NodeKind;
  title: string;
  parentId?: string;
  /** DAG 执行依赖，前端据此连线 */
  dependencies?: string[];
  status: NodeStatus;
  tags?: string[];
  startedAt?: string;
  completedAt?: string;
  /** status=fail 时前端红色高亮 */
  error?: NodeError;
  metrics?: NodeMetrics;
  inputPorts?: GraphPort[];
  outputPorts?: GraphPort[];
  [key: string]: unknown;
}

// ─── 各节点子类型（特有字段） ─────────────────────────────────────────────────

export interface LlmNodePayload extends BaseNodePayload {
  kind: "llm";
  step: number;
}

export interface ToolNodePayload extends BaseNodePayload {
  kind: "tool";
  toolName: string;
  intentSummary: string;
  toolGoal: string;
  maxRetries: number;
  currentAttempt: number;
}

export interface AttemptNodePayload extends BaseNodePayload {
  kind: "attempt";
  attemptIndex: number;
}

export interface FinalNodePayload extends BaseNodePayload {
  kind: "final";
  text?: string;
}

// ─── 图协议事件 Payload ──────────────────────────────────────────────────────

export interface RunStartPayload {
  dagId: string;
  sessionId?: string;
  turnIndex?: number;
  userInputSummary: string;
}

export interface NodeUpsertPayload {
  nodeId: string;
  parentId?: string;
  kind: NodeKind;
  title: string;
  tags?: string[];
  dependencies?: string[];
}

export interface EdgeUpsertPayload {
  edgeId: string;
  source: string;
  target: string;
  /** 来源节点输出端口名 */
  fromPort?: string;
  /** 目标节点输入端口名 */
  toPort?: string;
  /**
   * 边类型语义：
   * - dependency: 顺序依赖（默认）
   * - data: 数据流（fromPort → toPort）
   * - retry: 重试链（Attempt → Repair → Attempt）
   * - condition_true / condition_false: 条件分支（预留）
   */
  edgeKind?: "dependency" | "data" | "retry" | "condition_true" | "condition_false";
  label?: string;
}

export interface NodeStatusPayload {
  nodeId: string;
  status: NodeStatus;
  reason?: string;
}

export interface NodeIoPayload {
  nodeId: string;
  inputPorts?: GraphPort[];
  outputPorts?: GraphPort[];
  error?: NodeError;
  metrics?: NodeMetrics;
}

export interface LayoutHintPayload {
  direction: "TB" | "LR";
  ranker?: "network-simplex" | "tight-tree" | "longest-path";
  batchWindowMs?: number;
}

export interface RunEndPayload {
  ok: boolean;
  finalSummary?: string;
}

export interface NodePendingApprovalPayload {
  nodeId: string;
  toolName: string;
  toolParams: string;
}

export interface NodeApprovalResolvedPayload {
  nodeId: string;
  action: "approve" | "edit" | "skip" | "abort";
}

/** 前端向服务端发送的 RPC 请求信封 */
export interface ClientMessageEnvelope<T = unknown> {
  type: "gate.action" | "node.update_params" | "command.fork" | "snapshot.query";
  reqId?: string;
  payload: T;
}

/** 服务端对前端 RPC 请求的响应信封 */
export interface ServerResponseMessageEnvelope<T = unknown> {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  eventType: "server.response";
  reqId: string;
  ok: boolean;
  error?: string;
  payload?: T;
}

/** 审批操作负载 */
export interface GateActionPayload {
  gateId: string;
  action: "approve" | "edit" | "skip" | "abort";
  params?: string;
}

/** 兼容旧版的审批操作消息（逐步迁移到 ClientMessageEnvelope） */
export interface GateActionMessage extends GateActionPayload {
  type: "gate.action";
  reqId?: string; // 加入 reqId 以支持 RPC 响应
}

/** 前端节点数据（ReactFlow 节点使用） */
export interface GraphNodeData {
  title: string;
  kind: NodeKind | string;
  status?: NodeStatus | string;
  subtitle?: string;
  inputPorts?: GraphPort[];
  outputPorts?: GraphPort[];
  error?: NodeError;
  metrics?: NodeMetrics;
  dependencies?: string[];
  startedAt?: string;
  completedAt?: string;
  pendingApproval?: boolean;
  approvalPayload?: { toolName: string; toolParams: string };
}

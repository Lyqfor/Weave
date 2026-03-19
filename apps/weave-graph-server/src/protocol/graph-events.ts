/**
 * 文件作用：从共享协议重新导出，保持向后兼容的导入路径。
 */
export {
  GRAPH_SCHEMA_VERSION,
  type GraphEventType,
  type GraphEnvelope,
  type GraphPort,
  type NodeKind,
  type NodeStatus,
  type NodeMetrics,
  type NodeError,
  type BaseNodePayload,
  type LlmNodePayload,
  type ToolNodePayload,
  type AttemptNodePayload,
  type FinalNodePayload,
  type RunStartPayload,
  type NodeUpsertPayload,
  type EdgeUpsertPayload,
  type NodeStatusPayload,
  type NodeIoPayload,
  type LayoutHintPayload,
  type RunEndPayload,
  type GraphNodeData,
  type NodePendingApprovalPayload,
  type NodeApprovalResolvedPayload,
  type GateActionMessage,
  type ClientMessageEnvelope,
  type ServerResponseMessageEnvelope,
  type GateActionPayload
} from "../../../shared/graph-protocol.js";

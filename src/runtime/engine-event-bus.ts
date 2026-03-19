/**
 * 文件作用：Layer 1 引擎事件总线接口 — 纯接口，零外部依赖。
 * DagExecutionGraph 持有此接口引用，在节点/边/状态变更时自动广播。
 * 实现由 Layer 3（run-agent.ts）注入，遵循依赖反转原则。
 */

import type { DagDataEdge } from "./dag-graph.js";

export interface IEngineEventBus {
  onNodeCreated(nodeId: string, nodeType: string, frozen: Record<string, unknown>): void;
  onEdgeCreated(fromId: string, toId: string, kind: "dependency" | "data" | "retry"): void;
  onDataEdgeCreated(edge: DagDataEdge): void;
  /** updatedPayload 携带状态流转时的最新节点快照，用于刷新前端 Inspector 面板 */
  onNodeTransition(
    nodeId: string,
    nodeType: string,
    fromStatus: string,
    toStatus: string,
    reason?: string,
    updatedPayload?: Record<string, unknown>
  ): void;
  onSchedulerIssue(type: "deadlock" | "integrity", message: string, nodeIds?: string[]): void;
}

/**
 * 文件作用：定义 DAG 运行时事件契约与版本化策略，供运行层与展示层稳定对接。
 */

export const DAG_EVENT_SCHEMA_VERSION = "weave.dag.event.v1";

export type DagEventType =
  | "dag.node.transition"
  | "dag.node.detail"
  | "dag.scheduler.deadlock"
  | "dag.scheduler.integrity";

export interface DagEventEnvelope<TPayload = Record<string, unknown>> {
  schemaVersion: typeof DAG_EVENT_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  timestamp: string;
  eventType: DagEventType;
  payload: TPayload;
}

export interface DagNodeTransitionPayload {
  nodeId: string;
  nodeType: "llm" | "tool" | "final";
  fromStatus: string;
  toStatus: string;
  reason?: string;
}

export interface DagNodeDetailPayload {
  nodeId: string;
  text: string;
}

export interface DagSchedulerIssuePayload {
  message: string;
  remainingNodeIds?: string[];
}

export function createDagEventEnvelope<TPayload>(
  runId: string,
  eventType: DagEventType,
  payload: TPayload
): DagEventEnvelope<TPayload> {
  return {
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    eventId: `dag_evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    runId,
    timestamp: new Date().toISOString(),
    eventType,
    payload
  };
}

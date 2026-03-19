/**
 * 文件作用：TurnEngineBusAdapter — 将引擎层事件桥接到 WeaveEventBus。
 * 从 run-agent.ts 抽取的内联匿名对象，提升为具名类以便测试和复用。
 * Layer 3 适配器：引擎事件 → WeaveEventBus.dispatch → AgentRunEvent
 * 注：runId 由 WeaveEventBus 元数据自动注入事件信封，payload 中无需重复携带。
 */

import type { IEngineEventBus } from "../engine/engine-event-bus.js";
import type { DagDataEdge } from "../engine/dag-graph.js";
import type { GraphPort, NodeError, NodeMetrics } from "../nodes/node-types.js";
import { WeaveEventBus } from "../event/event-bus.js";

export class TurnEngineBusAdapter implements IEngineEventBus {
  constructor(
    private readonly bus: WeaveEventBus,
    private readonly runId: string,
    private readonly sessionId: string
  ) {}

  onNodeCreated(nodeId: string, nodeType: string, frozen: Record<string, unknown>): void {
    this.bus.dispatch("engine.node.created", {
      sessionId: this.sessionId,
      nodeId,
      nodeType,
      payload: frozen
    });
  }

  onEdgeCreated(fromId: string, toId: string, kind: "dependency" | "data" | "retry"): void {
    this.bus.dispatch("engine.edge.created", {
      sessionId: this.sessionId,
      fromId,
      toId,
      kind
    });
  }

  onDataEdgeCreated(edge: DagDataEdge): void {
    this.bus.dispatch("engine.data.edge.created", {
      sessionId: this.sessionId,
      ...edge
    });
  }

  onNodeTransition(
    nodeId: string,
    nodeType: string,
    fromStatus: string,
    toStatus: string,
    reason?: string,
    updatedPayload?: Record<string, unknown>
  ): void {
    this.bus.dispatch("engine.node.transition", {
      sessionId: this.sessionId,
      nodeId,
      nodeType,
      fromStatus,
      toStatus,
      reason,
      updatedPayload
    });
  }

  onNodeIo(
    nodeId: string,
    inputPorts?: GraphPort[],
    outputPorts?: GraphPort[],
    error?: NodeError,
    metrics?: NodeMetrics
  ): void {
    this.bus.dispatch("engine.node.io", {
      sessionId: this.sessionId,
      nodeId,
      inputPorts,
      outputPorts,
      error,
      metrics
    });
  }

  onSchedulerIssue(type: "deadlock" | "integrity", message: string, nodeIds?: string[]): void {
    this.bus.dispatch("engine.scheduler.issue", {
      sessionId: this.sessionId,
      issueType: type,
      message,
      nodeIds
    });
  }

  onNodeStreamDelta(nodeId: string, chunkText: string): void {
    this.bus.dispatch("engine.node.stream.delta", {
      sessionId: this.sessionId,
      nodeId,
      chunkText
    });
  }
}

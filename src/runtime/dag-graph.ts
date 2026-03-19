/**
 * 文件作用：提供 DAG 图模型，内置节点状态机约束、数据边与调度校验。
 * DagExecutionGraph 同时充当广播站：addNode/addEdge/transitionStatus 自动通过
 * IEngineEventBus 发射引擎事件，业务节点无需关心可视化通知。
 */
import type { IEngineEventBus } from "./engine-event-bus.js";

export type DagNodeType = "llm" | "tool" | "final" | "repair" | "escalation" | "input" | "system";
export type DagNodeStatus =
  | "pending"
  | "ready"
  | "blocked"
  | "running"
  | "success"
  | "fail"
  | "skipped"
  | "aborted";

export interface DagNode<TPayload = unknown> {
  id: string;
  type: DagNodeType;
  status: DagNodeStatus;
  payload?: TPayload;
}

export interface DagDataEdge {
  fromNodeId: string;
  toNodeId: string;
  toKey: string;
  fromKey?: string;
}

export interface DagStatusTransition {
  nodeId: string;
  fromStatus: DagNodeStatus;
  toStatus: DagNodeStatus;
  reason?: string;
}

const TERMINAL_STATUSES = new Set<DagNodeStatus>(["success", "fail", "skipped", "aborted"]);

const ALLOWED_TRANSITIONS: Record<DagNodeStatus, Set<DagNodeStatus>> = {
  pending: new Set(["ready", "aborted"]),
  ready: new Set(["running", "blocked", "aborted", "fail"]),
  blocked: new Set(["running", "skipped", "aborted", "fail"]),
  running: new Set(["blocked", "success", "fail", "skipped", "aborted"]),
  success: new Set(),
  fail: new Set(),
  skipped: new Set(),
  aborted: new Set()
};

export class DagExecutionGraph {
  private readonly nodes = new Map<string, DagNode>();
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();
  private readonly dataEdgesByTarget = new Map<string, DagDataEdge[]>();
  private engineEventBus?: IEngineEventBus;

  setEngineEventBus(bus: IEngineEventBus): void {
    this.engineEventBus = bus;
  }

  getEngineEventBus(): IEngineEventBus | undefined {
    return this.engineEventBus;
  }

  addNode(node: DagNode, frozenPayload?: Record<string, unknown>): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`节点已存在: ${node.id}`);
    }

    this.nodes.set(node.id, { ...node });
    this.outgoing.set(node.id, new Set());
    this.incoming.set(node.id, new Set());
    this.dataEdgesByTarget.set(node.id, []);

    // AOP 广播：业务节点只调 addNode，由 DagGraph 统一通知前端
    this.engineEventBus?.onNodeCreated(
      node.id,
      node.type,
      frozenPayload ?? { id: node.id, type: node.type, status: node.status }
    );
  }

  addEdge(fromNodeId: string, toNodeId: string, kind?: "dependency" | "data" | "retry"): void {
    if (!this.nodes.has(fromNodeId) || !this.nodes.has(toNodeId)) {
      throw new Error(`边引用了不存在的节点: ${fromNodeId} -> ${toNodeId}`);
    }

    if (fromNodeId === toNodeId) {
      throw new Error(`检测到自环依赖: ${fromNodeId}`);
    }

    const fromSet = this.outgoing.get(fromNodeId) as Set<string>;
    if (fromSet.has(toNodeId)) {
      return;
    }

    // 增加边前做一次环路检测。
    if (this.canReach(toNodeId, fromNodeId)) {
      throw new Error(`检测到环路依赖: ${fromNodeId} -> ${toNodeId}`);
    }

    fromSet.add(toNodeId);
    (this.incoming.get(toNodeId) as Set<string>).add(fromNodeId);

    this.engineEventBus?.onEdgeCreated(fromNodeId, toNodeId, kind ?? "dependency");
  }

  addDataEdge(edge: DagDataEdge): void {
    if (!this.nodes.has(edge.fromNodeId) || !this.nodes.has(edge.toNodeId)) {
      throw new Error(`数据边引用了不存在的节点: ${edge.fromNodeId} -> ${edge.toNodeId}`);
    }

    if (!edge.toKey.trim()) {
      throw new Error(`数据边 toKey 不能为空: ${edge.fromNodeId} -> ${edge.toNodeId}`);
    }

    const list = this.dataEdgesByTarget.get(edge.toNodeId) ?? [];
    const exists = list.some(
      (item) => item.fromNodeId === edge.fromNodeId && item.toKey === edge.toKey && item.fromKey === edge.fromKey
    );
    if (exists) {
      return;
    }

    list.push({ ...edge });
    this.dataEdgesByTarget.set(edge.toNodeId, list);

    this.engineEventBus?.onDataEdgeCreated({ ...edge });
  }

  getDataEdgesTo(nodeId: string): DagDataEdge[] {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`节点不存在: ${nodeId}`);
    }

    return [...(this.dataEdgesByTarget.get(nodeId) ?? [])];
  }

  transitionStatus(
    nodeId: string,
    toStatus: DagNodeStatus,
    reason?: string,
    frozenPayload?: Record<string, unknown>
  ): DagStatusTransition {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`节点不存在: ${nodeId}`);
    }

    const fromStatus = node.status;
    if (fromStatus === toStatus) {
      return { nodeId, fromStatus, toStatus, reason };
    }

    const allowed = ALLOWED_TRANSITIONS[fromStatus];
    if (!allowed.has(toStatus)) {
      throw new Error(`非法状态迁移: ${nodeId} ${fromStatus} -> ${toStatus}`);
    }

    node.status = toStatus;
    this.nodes.set(nodeId, node);

    this.engineEventBus?.onNodeTransition(nodeId, node.type, fromStatus, toStatus, reason, frozenPayload);

    return { nodeId, fromStatus, toStatus, reason };
  }

  // 兼容旧调用入口，内部统一走状态机迁移校验。
  setStatus(nodeId: string, status: DagNodeStatus): void {
    this.transitionStatus(nodeId, status);
  }

  getNode<TPayload = unknown>(nodeId: string): DagNode<TPayload> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`节点不存在: ${nodeId}`);
    }

    return node as DagNode<TPayload>;
  }

  getNodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  getReadyNodeIds(): string[] {
    const result: string[] = [];

    for (const [nodeId, node] of this.nodes.entries()) {
      if (node.status !== "pending" && node.status !== "ready") {
        continue;
      }

      const deps = this.incoming.get(nodeId) as Set<string>;
      const satisfied = [...deps].every((depId) => {
        const depNode = this.nodes.get(depId);
        return depNode ? TERMINAL_STATUSES.has(depNode.status) : false;
      });

      if (satisfied) {
        if (node.status !== "ready") {
          this.transitionStatus(nodeId, "ready", "all-dependencies-satisfied");
        }
        result.push(nodeId);
      }
    }

    return result;
  }

  getInProgressNodeIds(): string[] {
    return [...this.nodes.values()]
      .filter((node) => node.status === "pending" || node.status === "ready" || node.status === "running" || node.status === "blocked")
      .map((node) => node.id);
  }

  hasPendingWork(): boolean {
    return this.getInProgressNodeIds().length > 0;
  }

  validateIntegrity(): void {
    for (const [nodeId, deps] of this.incoming.entries()) {
      for (const depId of deps) {
        if (!this.nodes.has(depId)) {
          throw new Error(`节点依赖缺失: ${nodeId} <- ${depId}`);
        }
      }
    }

    for (const [targetNodeId, edges] of this.dataEdgesByTarget.entries()) {
      if (!this.nodes.has(targetNodeId)) {
        throw new Error(`数据边目标节点不存在: ${targetNodeId}`);
      }

      for (const edge of edges) {
        if (!this.nodes.has(edge.fromNodeId)) {
          throw new Error(`数据边源节点不存在: ${edge.fromNodeId} -> ${targetNodeId}`);
        }
      }
    }
  }

  private canReach(fromNodeId: string, targetNodeId: string): boolean {
    const visited = new Set<string>();
    const stack = [fromNodeId];

    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === targetNodeId) {
        return true;
      }

      if (visited.has(current)) {
        continue;
      }

      visited.add(current);
      const nextSet = this.outgoing.get(current);
      if (!nextSet) {
        continue;
      }

      for (const next of nextSet) {
        stack.push(next);
      }
    }

    return false;
  }
}

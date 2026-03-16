/**
 * 文件作用：提供最小 DAG 图模型，支持节点依赖、就绪判断与环路检测。
 */
export type DagNodeType = "llm" | "tool" | "final";
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

const TERMINAL_STATUSES = new Set<DagNodeStatus>(["success", "fail", "skipped", "aborted"]);

export class DagExecutionGraph {
  private readonly nodes = new Map<string, DagNode>();
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();

  addNode(node: DagNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`节点已存在: ${node.id}`);
    }

    this.nodes.set(node.id, { ...node });
    this.outgoing.set(node.id, new Set());
    this.incoming.set(node.id, new Set());
  }

  addEdge(fromNodeId: string, toNodeId: string): void {
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
  }

  setStatus(nodeId: string, status: DagNodeStatus): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`节点不存在: ${nodeId}`);
    }

    node.status = status;
    this.nodes.set(nodeId, node);
  }

  getNode<TPayload = unknown>(nodeId: string): DagNode<TPayload> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`节点不存在: ${nodeId}`);
    }

    return node as DagNode<TPayload>;
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
          this.setStatus(nodeId, "ready");
        }
        result.push(nodeId);
      }
    }

    return result;
  }

  hasPendingWork(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === "pending" || node.status === "ready" || node.status === "running" || node.status === "blocked") {
        return true;
      }
    }

    return false;
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

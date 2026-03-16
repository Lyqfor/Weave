/**
 * 文件作用：提供 DAG 运行时最小状态总线，统一管理节点输入输出与共享上下文。
 */
import type { DagExecutionGraph } from "./dag-graph.js";

export interface DagNodeOutputRecord {
  ok: boolean;
  content: unknown;
  metadata?: Record<string, unknown>;
}

export interface DagRunSnapshot {
  runContext: Record<string, unknown>;
  nodeOutputs: Record<string, DagNodeOutputRecord>;
}

export class DagStateStore {
  private readonly runContext = new Map<string, unknown>();
  private readonly nodeOutputs = new Map<string, DagNodeOutputRecord>();

  setRunValue(key: string, value: unknown): void {
    this.runContext.set(key, value);
  }

  getRunValue<TValue = unknown>(key: string): TValue | undefined {
    return this.runContext.get(key) as TValue | undefined;
  }

  setNodeOutput(nodeId: string, output: DagNodeOutputRecord): void {
    this.nodeOutputs.set(nodeId, output);
  }

  getNodeOutput(nodeId: string): DagNodeOutputRecord | undefined {
    return this.nodeOutputs.get(nodeId);
  }

  resolveNodeInput(graph: DagExecutionGraph, nodeId: string): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    const edges = graph.getDataEdgesTo(nodeId);

    // 通过数据边声明将上游输出映射到当前节点输入，避免隐式耦合。
    for (const edge of edges) {
      const source = this.nodeOutputs.get(edge.fromNodeId);
      if (!source) {
        continue;
      }

      const sourceValue = edge.fromKey ? this.pickNestedValue(source, edge.fromKey) : source.content;
      resolved[edge.toKey] = sourceValue;
    }

    return resolved;
  }

  snapshot(): DagRunSnapshot {
    return {
      runContext: Object.fromEntries(this.runContext.entries()),
      nodeOutputs: Object.fromEntries(this.nodeOutputs.entries())
    };
  }

  private pickNestedValue(source: DagNodeOutputRecord, path: string): unknown {
    const root = {
      ok: source.ok,
      content: source.content,
      metadata: source.metadata
    } as Record<string, unknown>;

    return path.split(".").reduce<unknown>((acc, key) => {
      if (!acc || typeof acc !== "object") {
        return undefined;
      }
      return (acc as Record<string, unknown>)[key];
    }, root);
  }
}

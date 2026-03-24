import { WalDao } from "./wal-dao.js";
import { DagExecutionGraph, type DagNodeStatus } from "../../core/engine/dag-graph.js";
import { DagStateStore, type DagNodeOutputRecord } from "../../core/engine/state-store.js";
import { parse } from "flatted";

/**
 * 状态快照 DTO，用于向前端传输轻量化的图状态。
 */
export interface DagSnapshotDTO {
  nodes: Array<{ id: string; type: string; status: string; payload?: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string; kind: string }>;
  dataEdges: Array<{ fromNodeId: string; toNodeId: string; toKey: string; fromKey?: string }>;
  globalContext: Record<string, unknown>;
}

/**
 * 文件作用：DagReplayEngine — 时空穿梭与状态重构引擎。
 * 负责从 SQLite WAL 日志中通过“拓扑重放”技术，
 * 在内存中精准还原或分叉出一个特定时刻的 DAG 状态。
 */
export class DagReplayEngine {
  constructor(private readonly dao: WalDao) {}

  /**
   * 👑 核心魔法：从历史节点分叉出一个新的执行实例。
   * @param parentExecId 原执行 ID (DAG_V1)
   * @param forkAtNodeId 分叉点（从哪个节点开始重跑）
   * @param newExecId 新执行 ID (DAG_V2)
   */
  public async fork(
    parentExecId: string,
    forkAtNodeId: string,
    newExecId: string
  ): Promise<{ dag: DagExecutionGraph; stateStore: DagStateStore }> {
    // 1. 获取血缘关联的祖先日志（排除并行无关分支的干扰）
    const events = this.dao.getAncestorsWalEvents(parentExecId, forkAtNodeId);

    // 2. 内存状态机重构（静默模式，不挂载 EventBus）
    const dag = new DagExecutionGraph();
    const stateStore = new DagStateStore();

    // 3. 按序重放（Replay）
    for (const record of events) {
      const payload = parse(record.payload) as Record<string, unknown>;

      // 还原大文本引用（从黑板拉回数据）
      const dehydratedPayload = await this.rehydratePayload(payload);

      // 根据事件类型驱动状态机生长
      this.replayEvent(dag, stateStore, record.event_type, dehydratedPayload);
    }

    // 4. 持久化新的 Execution 记录（标记血缘）
    const parentExec = this.dao.getExecution(parentExecId);
    if (parentExec) {
      this.dao.insertExecution({
        id: newExecId,
        session_id: parentExec.session_id,
        parent_execution_id: parentExecId,
        forked_at_node: forkAtNodeId,
        status: "RUNNING",
      });
      // 更新 Session 的 Head 指针到新分支
      this.dao.updateSessionHead(parentExec.session_id, newExecId);
    }

    return { dag, stateStore };
  }

  /**
   * 无损还原某个完整的历史执行流（只读重构，供前端查询或 UI 渲染）。
   */
  public async reconstruct(
    executionId: string
  ): Promise<{ dag: DagExecutionGraph; stateStore: DagStateStore }> {
    const events = this.dao.getExecutionWalEvents(executionId);

    const dag = new DagExecutionGraph();
    const stateStore = new DagStateStore();

    for (const record of events) {
      const payload = parse(record.payload);
      const dehydratedPayload = await this.rehydratePayload(payload);
      this.replayEvent(dag, stateStore, record.event_type, dehydratedPayload);
    }

    return { dag, stateStore };
  }

  /**
   * 将内存中的图和状态序列化为轻量级 DTO。
   * 注意：本方法仅序列化内存中的状态，Edges 建议通过获取 WAL 事件中的 topology 信息或直接查表获取。
   */
  public toSnapshotDTO(
    dag: DagExecutionGraph,
    stateStore: DagStateStore,
    executionId: string
  ): DagSnapshotDTO {
    const nodes = dag.getNodeIds().map((id: string) => {
      const node = dag.getNode(id);
      return {
        id: node.id,
        type: node.type,
        status: node.status,
        payload: node.payload as Record<string, unknown> | undefined,
      };
    });

    const dataEdges: DagSnapshotDTO["dataEdges"] = [];
    for (const id of dag.getNodeIds()) {
      dataEdges.push(...dag.getDataEdgesTo(id));
    }

    // 从数据库中拉取拓扑边，因为内存 DagGraph 未暴露 outgoing 遍历接口
    const dbEdges = this.dao.getEdges(executionId);

    return {
      nodes,
      edges: dbEdges,
      dataEdges,
      globalContext: stateStore.snapshot().runContext as Record<string, unknown>,
    };
  }

  /**
   * 递归还原 Payload 中的黑板大文本引用。
   */
  private async rehydratePayload(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!payload || typeof payload !== "object") return payload;

    for (const key in payload) {
      const val = payload[key];
      if (typeof val === "string" && val.startsWith("[[REF:bb_")) {
        const bbId = val.replace("[[REF:", "").replace("]]", "");
        const msg = this.dao.getBlackboardMessage(bbId);
        if (msg) {
          payload[key] = msg.content;
        }
      } else if (typeof val === "object" && val !== null) {
        await this.rehydratePayload(val as Record<string, unknown>);
      }
    }
    return payload;
  }

  /**
   * 状态机还原逻辑：将单个 WAL 事件映射回内存对象状态。
   */
  private replayEvent(
    dag: DagExecutionGraph,
    stateStore: DagStateStore,
    type: string,
    p: Record<string, unknown>
  ): void {
    switch (type) {
      case "engine.node.created": {
        const nodeId = p.nodeId as string;
        const nodeType = p.nodeType as string;
        const frozenPayload = p.payload as Record<string, unknown> | undefined;
        const initStatus = (frozenPayload?.status as string | undefined) ?? "pending";
        dag.addNode(
          {
            id: nodeId,
            type: nodeType as import("../../core/engine/dag-graph.js").DagNodeType,
            status: initStatus as DagNodeStatus,
          },
          frozenPayload
        );
        break;
      }
      case "engine.edge.created":
        // 防御性：只有当两个节点都已在重构的图中存在时才添加边
        try {
          const from = p.fromId as string;
          const to = p.toId as string;
          const kind = p.kind as "dependency" | "data" | "retry" | undefined;
          if (dag.getNodeIds().includes(from) && dag.getNodeIds().includes(to)) {
            dag.addEdge(from, to, kind);
          }
        } catch {
          // 忽略非法边
        }
        break;
      case "engine.data.edge.created":
        try {
          const fromNodeId = p.fromNodeId as string;
          const toNodeId = p.toNodeId as string;
          if (dag.getNodeIds().includes(fromNodeId) && dag.getNodeIds().includes(toNodeId)) {
            dag.addDataEdge(p as unknown as import("../../core/engine/dag-graph.js").DagDataEdge);
          }
        } catch {
          // 忽略非法数据边
        }
        break;
      case "engine.node.transition":
        // 直接操作内存节点，避免触发 transitionStatus 的状态机校验和二次广播
        try {
          const nodeId = p.nodeId as string;
          const node = dag.getNode(nodeId);
          if (node) {
            node.status = p.toStatus as DagNodeStatus;
            const updated = p.updatedPayload as Record<string, unknown> | undefined;
            if (updated) {
              // 恢复 StateStore 中的输出
              if (updated.output) {
                stateStore.setNodeOutput(nodeId, updated.output as DagNodeOutputRecord);
              }
              // 恢复节点内部快照数据
              node.payload = { ...(node.payload ?? {}), ...updated };
            }
          }
        } catch {
          // 容错：如果节点在重放流中由于某种原因不存在，忽略该迁移事件
        }
        break;
      case "run.start":
        if (p.userInput) {
          stateStore.setRunValue("userInput", p.userInput as string);
        }
        break;
    }
  }
}

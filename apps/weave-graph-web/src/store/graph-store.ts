/*
 * 文件作用：图状态单一真相源，负责按 dagId 分桶存储图数据并支持时间轴切换。
 */

import { create } from "zustand";
import { applyNodeChanges, type NodeChange } from "reactflow";
import type { Edge, Node } from "reactflow";
import type {
  GraphEnvelope,
  GraphNodeData,
  GraphPort,
  NodePendingApprovalPayload,
  NodeApprovalResolvedPayload,
  RunStartPayload
} from "../types/graph-events";

export interface DagGraph {
  dagId: string;
  runId: string;
  sessionId?: string;
  turnIndex?: number;
  userInputSummary?: string;
  nodes: Node<GraphNodeData>[];
  edges: Edge[];
  latestSeq: number;
  selectedNodeId?: string;
  lockedNodeIds: string[];
  updatedAt: string;
}

interface GraphState {
  dags: Record<string, DagGraph>;
  dagOrder: string[];
  activeDagId: string;
  pendingApprovalNodeId: string | null;
  pendingApprovalPayload: { toolName: string; toolParams: string } | null;
  ensureDag: (dagId: string, runId: string, timestamp: string) => DagGraph;
  applyEnvelope: (evt: GraphEnvelope<unknown>) => void;
  setActiveDag: (dagId: string) => void;
  selectNode: (nodeId?: string) => void;
  applyActiveNodeChanges: (changes: NodeChange[]) => void;
  clearPendingApproval: () => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  dags: {},
  dagOrder: [],
  activeDagId: "",
  pendingApprovalNodeId: null,
  pendingApprovalPayload: null,
  ensureDag(dagId, runId, timestamp) {
    const existing = get().dags[dagId];
    if (existing) {
      return existing;
    }

    const next: DagGraph = {
      dagId,
      runId,
      nodes: [],
      edges: [],
      latestSeq: 0,
      lockedNodeIds: [],
      updatedAt: timestamp
    };

    set((state) => ({
      dags: { ...state.dags, [dagId]: next },
      dagOrder: state.dagOrder.includes(dagId) ? state.dagOrder : [dagId, ...state.dagOrder],
      activeDagId: state.activeDagId || dagId
    }));

    return next;
  },
  applyEnvelope(evt) {
    const current = get().dags[evt.dagId] ?? get().ensureDag(evt.dagId, evt.runId, evt.timestamp);
    if (evt.seq <= current.latestSeq) {
      return;
    }

    set((state) => {
      const prev = state.dags[evt.dagId] ?? current;
      const dag: DagGraph = {
        ...prev,
        runId: evt.runId,
        latestSeq: evt.seq,
        updatedAt: evt.timestamp,
        nodes: [...prev.nodes],
        edges: [...prev.edges]
      };

      if (evt.eventType === "run.start") {
        const payload = evt.payload as RunStartPayload;
        dag.sessionId = payload.sessionId;
        dag.turnIndex = payload.turnIndex;
        dag.userInputSummary = payload.userInputSummary;
      }

      if (evt.eventType === "node.upsert") {
        const payload = evt.payload as { nodeId: string; parentId?: string; title: string; kind: string };
        const nodeIndex = dag.nodes.findIndex((n) => n.id === payload.nodeId);

        if (nodeIndex < 0) {
          dag.nodes.push({
            id: payload.nodeId,
            position: { x: 0, y: 0 },
            data: {
              title: payload.title,
              kind: payload.kind
            }
          });
        } else {
          dag.nodes[nodeIndex] = {
            ...dag.nodes[nodeIndex],
            data: {
              ...dag.nodes[nodeIndex].data,
              title: payload.title,
              kind: payload.kind
            }
          };
        }

        if (payload.parentId) {
          const edgeId = `${payload.parentId}->${payload.nodeId}`;
          if (!dag.edges.some((e) => e.id === edgeId)) {
            dag.edges.push({
              id: edgeId,
              source: payload.parentId,
              target: payload.nodeId
            });
          }
        }
      }

      if (evt.eventType === "edge.upsert") {
        const payload = evt.payload as { edgeId: string; source: string; target: string; label?: string; edgeKind?: string };
        if (!dag.edges.some((e) => e.id === payload.edgeId)) {
          dag.edges.push({
            id: payload.edgeId,
            source: payload.source,
            target: payload.target,
            label: payload.label,
            data: payload.edgeKind ? { edgeKind: payload.edgeKind } : undefined,
            // retry 边使用虚线样式区分
            style: payload.edgeKind === "retry" ? { strokeDasharray: "4 4", stroke: "#f59e0b" } : undefined,
            animated: payload.edgeKind === "data"
          });
        }
      }

      if (evt.eventType === "node.status") {
        const payload = evt.payload as { nodeId: string; status: string };
        dag.nodes = dag.nodes.map((n) =>
          n.id === payload.nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  status: payload.status
                }
              }
            : n
        );
      }

      if (evt.eventType === "node.io") {
        const payload = evt.payload as { nodeId: string; inputPorts?: GraphPort[]; outputPorts?: GraphPort[] };
        dag.nodes = dag.nodes.map((n) =>
          n.id === payload.nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  inputPorts: payload.inputPorts
                    ? [...(n.data.inputPorts ?? []), ...payload.inputPorts]
                    : n.data.inputPorts,
                  outputPorts: payload.outputPorts
                    ? [...(n.data.outputPorts ?? []), ...payload.outputPorts]
                    : n.data.outputPorts,
                  // subtitle 取最新一条 detail（追加模式下始终用新到的 port 摘要覆盖）
                  subtitle: payload.outputPorts?.[0]?.summary ?? n.data.subtitle
                }
              }
            : n
        );
      }

      // Step Gate 审批等待：更新节点数据并设置全局 pendingApprovalNodeId
      let nextPendingApprovalNodeId = state.pendingApprovalNodeId;
      let nextPendingApprovalPayload = state.pendingApprovalPayload;

      if (evt.eventType === "node.pending_approval") {
        const payload = evt.payload as NodePendingApprovalPayload;
        dag.nodes = dag.nodes.map((n) =>
          n.id === payload.nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  pendingApproval: true,
                  approvalPayload: { toolName: payload.toolName, toolParams: payload.toolParams }
                }
              }
            : n
        );
        nextPendingApprovalNodeId = payload.nodeId;
        nextPendingApprovalPayload = { toolName: payload.toolName, toolParams: payload.toolParams };
      }

      // Step Gate 审批完成：清除节点动画和全局状态
      if (evt.eventType === "node.approval.resolved") {
        const payload = evt.payload as NodeApprovalResolvedPayload;
        dag.nodes = dag.nodes.map((n) =>
          n.id === payload.nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  pendingApproval: false,
                  approvalPayload: undefined
                }
              }
            : n
        );
        if (state.pendingApprovalNodeId === payload.nodeId) {
          nextPendingApprovalNodeId = null;
          nextPendingApprovalPayload = null;
        }
      }

      const nextOrder = state.dagOrder.includes(evt.dagId) ? state.dagOrder : [evt.dagId, ...state.dagOrder];
      // node.pending_approval 时自动激活对应的 dagId
      const nextActiveDagId =
        evt.eventType === "run.start" || evt.eventType === "node.pending_approval"
          ? evt.dagId
          : state.activeDagId || evt.dagId;

      return {
        dags: { ...state.dags, [evt.dagId]: dag },
        dagOrder: nextOrder,
        activeDagId: nextActiveDagId,
        pendingApprovalNodeId: nextPendingApprovalNodeId,
        pendingApprovalPayload: nextPendingApprovalPayload
      };
    });
  },
  setActiveDag(dagId) {
    if (!get().dags[dagId]) {
      return;
    }
    set({ activeDagId: dagId });
  },
  selectNode(nodeId) {
    const activeDagId = get().activeDagId;
    if (!activeDagId) {
      return;
    }

    set((state) => {
      const dag = state.dags[activeDagId];
      if (!dag) {
        return state;
      }

      return {
        dags: {
          ...state.dags,
          [activeDagId]: {
            ...dag,
            selectedNodeId: nodeId
          }
        }
      };
    });
  },
  applyActiveNodeChanges(changes) {
    const activeDagId = get().activeDagId;
    if (!activeDagId || changes.length === 0) {
      return;
    }

    set((state) => {
      const dag = state.dags[activeDagId];
      if (!dag) {
        return state;
      }

      const movedIds = changes
        .filter((change) => change.type === "position" && Boolean(change.position))
        .map((change) => ("id" in change ? change.id : undefined))
        .filter((id): id is string => Boolean(id));

      let nextSelectedNodeId = dag.selectedNodeId;
      const explicitSelected = changes.find((change) => change.type === "select" && change.selected);
      if (explicitSelected && "id" in explicitSelected) {
        nextSelectedNodeId = explicitSelected.id;
      }

      return {
        dags: {
          ...state.dags,
          [activeDagId]: {
            ...dag,
            selectedNodeId: nextSelectedNodeId,
            nodes: applyNodeChanges(changes, dag.nodes),
            lockedNodeIds: Array.from(new Set([...dag.lockedNodeIds, ...movedIds]))
          }
        }
      };
    });
  },
  clearPendingApproval() {
    set({ pendingApprovalNodeId: null, pendingApprovalPayload: null });
  }
}));

function summarizeNodeIo(inputPorts?: GraphPort[], outputPorts?: GraphPort[]): string | undefined {
  const source = [...(inputPorts ?? []), ...(outputPorts ?? [])];
  const first = source.find((port) => port.summary?.trim());
  if (!first) {
    return undefined;
  }
  // 保留较长摘要用于节点卡片副标题（不过度截断）
  const text = first.summary.trim();
  if (text.length <= 72) {
    return text;
  }
  return `${text.slice(0, 72)}…`;
}

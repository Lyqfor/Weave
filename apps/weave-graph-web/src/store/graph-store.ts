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
  RunSubscribePayload,
  RunStartPayload,
  NodeIoPayload
} from "../types/graph-events";
import { RpcPendingManager } from "../lib/rpc-pending-manager";

export interface DagGraph {
  dagId: string;
  runId: string;
  sessionId?: string;
  turnIndex?: number;
  userInputSummary?: string;
  lastEventId?: string;
  nodes: Node<GraphNodeData>[];
  edges: Edge[];
  latestSeq: number;
  seenEventIds: Record<string, true>;
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
  resetRunForResync: (runId: string) => void;
  createDraftRun: (dagId: string, runId: string, userInputSummary: string, sessionId?: string) => void;
  sendRpc: <T = unknown>(type: string, payload: unknown) => Promise<T>;
}

// ─── 全局 RPC 状态 ──────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 15000;
const pendingManager = new RpcPendingManager(RPC_TIMEOUT_MS);

/** 标记 RPC 已经真正写入 WS，超时从这一刻开始计算，避免离线排队误超时。 */
export const markRpcDispatched = (reqId: string) => {
  pendingManager.markDispatched(reqId);
};

/** 主动取消待处理 RPC（例如队列溢出、页面销毁）。 */
export const cancelRpcRequest = (reqId: string, reason = "RPC Canceled") => {
  pendingManager.cancel(reqId, reason);
};

/** 暴露给 App.tsx 处理 WS 返回消息 */
export const resolveRpc = (reqId: string, ok: boolean, error?: string, payload?: any) => {
  const req = pendingManager.consume(reqId);
  if (!req) return;
  
  if (ok) {
    req.resolve(payload);
  } else {
    const errorCode = typeof payload?.code === "string" ? payload.code : undefined;
    const message = error || payload?.message || "Unknown RPC error";

    // run.subscribe 游标失效自动恢复：清理本地游标并无游标重订阅。
    if (errorCode === "RESYNC_REQUIRED" && req.type === "run.subscribe" && !req.resyncRetried) {
      const subscribePayload = req.payload as Partial<RunSubscribePayload> | undefined;
      const runId = subscribePayload?.runId?.trim();
      if (runId) {
        useGraphStore.getState().resetRunForResync(runId);

        const retryReqId = crypto.randomUUID();
        const retryPayload: RunSubscribePayload = { runId };
        const retryEnvelope = {
          type: "run.subscribe",
          reqId: retryReqId,
          payload: retryPayload
        };

        pendingManager.register(retryReqId, {
          resolve: req.resolve,
          reject: req.reject,
          type: "run.subscribe",
          payload: retryPayload,
          resyncRetried: true
        });

        window.dispatchEvent(new CustomEvent("weave:rpc:send", { detail: { envelope: retryEnvelope } }));
        return;
      }
    }

    req.reject(errorCode ? `${errorCode}: ${message}` : message);
  }
};

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
      seenEventIds: {},
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
  createDraftRun(dagId, runId, userInputSummary, sessionId) {
    const now = new Date().toISOString();
    set((state) => {
      // 开屏提交后先创建草稿 run，保证三栏布局立即有可绑定会话。
      const existing = state.dags[dagId];
      const next: DagGraph = existing
        ? {
            ...existing,
            runId,
            sessionId: sessionId ?? existing.sessionId,
            userInputSummary,
            updatedAt: now
          }
        : {
            dagId,
            runId,
            sessionId,
            userInputSummary,
            nodes: [],
            edges: [],
            latestSeq: 0,
            seenEventIds: {},
            lockedNodeIds: [],
            updatedAt: now
          };

      return {
        dags: { ...state.dags, [dagId]: next },
        dagOrder: state.dagOrder.includes(dagId) ? state.dagOrder : [dagId, ...state.dagOrder],
        activeDagId: dagId
      };
    });
  },
  applyEnvelope(evt) {
    if (evt.eventType === "run.start" && evt.dagId !== evt.runId) {
      // 当后端将 dagId 归一化后，把前端草稿 runId 键迁移到正式 dagId，避免出现双会话分裂。
      const currentState = get();
      const draft = currentState.dags[evt.runId];
      const target = currentState.dags[evt.dagId];
      if (draft && !target) {
        set((state) => {
          const nextDags = { ...state.dags };
          const draftDag = nextDags[evt.runId];
          if (!draftDag || nextDags[evt.dagId]) {
            return state;
          }

          nextDags[evt.dagId] = { ...draftDag, dagId: evt.dagId };
          delete nextDags[evt.runId];

          const nextOrder = state.dagOrder.map((id) => (id === evt.runId ? evt.dagId : id));
          return {
            dags: nextDags,
            dagOrder: nextOrder,
            activeDagId: state.activeDagId === evt.runId ? evt.dagId : state.activeDagId
          };
        });
      }
    }

    const current = get().dags[evt.dagId] ?? get().ensureDag(evt.dagId, evt.runId, evt.timestamp);
    if (evt.eventId && current.seenEventIds[evt.eventId]) {
      return;
    }
    if (evt.seq <= current.latestSeq) {
      return;
    }

    set((state) => {
      const prev = state.dags[evt.dagId] ?? current;
      const dag: DagGraph = {
        ...prev,
        runId: evt.runId,
        latestSeq: evt.seq,
        lastEventId: evt.eventId,
        seenEventIds: {
          ...prev.seenEventIds,
          ...(evt.eventId ? { [evt.eventId]: true } : {})
        },
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
        const payload = evt.payload as {
          nodeId: string;
          parentId?: string;
          title: string;
          kind: string;
          tags?: string[];
          dependencies?: string[];
        };
        const nodeIndex = dag.nodes.findIndex((n) => n.id === payload.nodeId);

        if (nodeIndex < 0) {
          dag.nodes.push({
            id: payload.nodeId,
            position: { x: 0, y: 0 },
            data: {
              title: payload.title,
              kind: payload.kind,
              dependencies: payload.dependencies
            }
          });
        } else {
          dag.nodes[nodeIndex] = {
            ...dag.nodes[nodeIndex],
            data: {
              ...dag.nodes[nodeIndex].data,
              title: payload.title,
              kind: payload.kind,
              dependencies: payload.dependencies ?? dag.nodes[nodeIndex].data.dependencies
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
            style: payload.edgeKind === "retry" ? { strokeDasharray: "4 4", stroke: "#f59e0b" } : undefined
          });
        }
      }

      if (evt.eventType === "node.status") {
        const payload = evt.payload as { nodeId: string; status: string };
        dag.nodes = dag.nodes.map((n) =>
          n.id === payload.nodeId
            ? { ...n, data: { ...n.data, status: payload.status } }
            : n
        );
      }

      if (evt.eventType === "node.io") {
        const payload = evt.payload as NodeIoPayload;
        dag.nodes = dag.nodes.map((n) => {
          if (n.id !== payload.nodeId) return n;

          // 端口：合并追加（避免重复写入相同端口名）
          const mergedIn = mergePorts(n.data.inputPorts, payload.inputPorts);
          const mergedOut = mergePorts(n.data.outputPorts, payload.outputPorts);

          // subtitle 取最新输出端口的文本摘要
          const subtitle = getPortSubtitle(payload.outputPorts) ?? n.data.subtitle;

          return {
            ...n,
            data: {
              ...n.data,
              inputPorts: mergedIn,
              outputPorts: mergedOut,
              subtitle,
              error: payload.error ?? n.data.error,
              metrics: payload.metrics ? { ...n.data.metrics, ...payload.metrics } : n.data.metrics
            }
          };
        });
      }

      // Step Gate 审批
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

      if (evt.eventType === "node.approval.resolved") {
        const payload = evt.payload as NodeApprovalResolvedPayload;
        dag.nodes = dag.nodes.map((n) =>
          n.id === payload.nodeId
            ? { ...n, data: { ...n.data, pendingApproval: false, approvalPayload: undefined } }
            : n
        );
        if (state.pendingApprovalNodeId === payload.nodeId) {
          nextPendingApprovalNodeId = null;
          nextPendingApprovalPayload = null;
        }
      }

      const nextOrder = state.dagOrder.includes(evt.dagId) ? state.dagOrder : [evt.dagId, ...state.dagOrder];
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
    if (!get().dags[dagId]) return;
    set({ activeDagId: dagId });
  },
  selectNode(nodeId) {
    const activeDagId = get().activeDagId;
    if (!activeDagId) return;

    set((state) => {
      const dag = state.dags[activeDagId];
      if (!dag) return state;
      return {
        dags: {
          ...state.dags,
          [activeDagId]: { ...dag, selectedNodeId: nodeId }
        }
      };
    });
  },
  applyActiveNodeChanges(changes) {
    const activeDagId = get().activeDagId;
    if (!activeDagId || changes.length === 0) return;

    set((state) => {
      const dag = state.dags[activeDagId];
      if (!dag) return state;

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
  },
  resetRunForResync(runId) {
    set((state) => {
      const nextDags: GraphState["dags"] = { ...state.dags };
      let hasChanges = false;

      for (const [dagId, dag] of Object.entries(state.dags)) {
        if (dag.runId !== runId) continue;
        hasChanges = true;
        nextDags[dagId] = {
          ...dag,
          lastEventId: undefined,
          latestSeq: 0,
          seenEventIds: {},
          nodes: [],
          edges: [],
          selectedNodeId: undefined,
          lockedNodeIds: [],
          updatedAt: new Date().toISOString()
        };
      }

      if (!hasChanges) {
        return state;
      }

      return {
        dags: nextDags,
        pendingApprovalNodeId: null,
        pendingApprovalPayload: null
      };
    });
  },
  async sendRpc(type, payload) {
    const reqId = crypto.randomUUID();
    const envelope = { type, reqId, payload };

    return new Promise((resolve, reject) => {
      pendingManager.register(reqId, {
        resolve,
        reject,
        type,
        payload,
        resyncRetried: false
      });

      // 触发自定义事件，由 App.tsx 中的 WebSocket 监听并发送（真正发出后再开始超时计时）。
      window.dispatchEvent(new CustomEvent("weave:rpc:send", { detail: { envelope } }));
    });
  }
}));

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 合并端口列表：
 * - 若同名端口已存在且 incoming 带有 is_delta 标记，则执行字符串追加。
 * - 否则，执行覆盖。
 */
function mergePorts(existing?: GraphPort[], incoming?: GraphPort[]): GraphPort[] | undefined {
  if (!incoming?.length) return existing;
  if (!existing?.length) return incoming;

  const map = new Map(existing.map((p) => [p.name, p]));
  for (const port of incoming) {
    const existingPort = map.get(port.name);
    if (existingPort && port.metadata?.is_delta === true) {
      // 执行流式追加
      map.set(port.name, {
        ...existingPort,
        content: String(existingPort.content ?? "") + String(port.content ?? ""),
        metadata: { ...existingPort.metadata, ...port.metadata }
      });
    } else {
      // 普通覆盖
      map.set(port.name, port);
    }
  }
  return [...map.values()];
}

/**
 * 从端口列表中提取第一条适合做副标题的文本摘要。
 */
function getPortSubtitle(ports?: GraphPort[]): string | undefined {
  if (!ports?.length) return undefined;
  const first = ports[0];
  if (!first) return undefined;

  const text = portContentToString(first.content);
  if (!text) return undefined;
  return text.length <= 72 ? text : `${text.slice(0, 72)}…`;
}

/**
 * 将端口 content 转为可读字符串（用于节点卡片副标题）。
 */
export function portContentToString(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

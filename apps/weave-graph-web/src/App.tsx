/*
 * 文件作用：二维图主界面，Chat-DAG 融合三栏布局。
 * 左侧：聊天面板（ChatPanel）；中间：DAG 画布；右侧：节点 Inspector。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeChange
} from "reactflow";
import "reactflow/dist/style.css";
import "./app.css";
import { useGraphStore } from "./store/graph-store";
import { applyDagreLayoutAsync } from "./layout/dagre-layout";
import type { GateActionMessage, GraphEnvelope, GraphNodeData } from "./types/graph-events";
import { SemanticNode } from "./nodes/semantic-node";
import { FlowEdge } from "./edges/FlowEdge";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ChatPanel } from "./components/ChatPanel";
import { WeaveIcon } from "./components/WeaveIcon";
import { InspectorTextBlock } from "./components/InspectorTextBlock";

const nodeTypes = { semantic: SemanticNode };
const edgeTypes = { flow: FlowEdge };

function renderPortSummary(summary: string) {
  return <InspectorTextBlock text={summary} />;
}

// ── 内层组件（在 ReactFlowProvider 内，可使用 useReactFlow）──────────────────

function GraphCanvas() {
  const dags = useGraphStore((s) => s.dags);
  const dagOrder = useGraphStore((s) => s.dagOrder);
  const activeDagId = useGraphStore((s) => s.activeDagId);
  const setActiveDag = useGraphStore((s) => s.setActiveDag);
  const selectNode = useGraphStore((s) => s.selectNode);
  const applyActiveNodeChanges = useGraphStore((s) => s.applyActiveNodeChanges);
  const applyEnvelope = useGraphStore((s) => s.applyEnvelope);
  const pendingApprovalNodeId = useGraphStore((s) => s.pendingApprovalNodeId);
  const clearPendingApproval = useGraphStore((s) => s.clearPendingApproval);

  const { setCenter, fitView } = useReactFlow();

  const activeDag = activeDagId ? dags[activeDagId] : undefined;
  const nodes = activeDag?.nodes ?? [];
  const edges = activeDag?.edges ?? [];
  const lockedNodeIds = activeDag?.lockedNodeIds ?? [];
  const selectedNode = activeDag?.selectedNodeId ? nodes.find((n) => n.id === activeDag.selectedNodeId) : undefined;
  const [layoutedNodes, setLayoutedNodes] = useState<Node<GraphNodeData>[]>([]);

  // WebSocket 连接状态
  const wsRef = useRef<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const userInteractedRef = useRef(false);
  const layoutCancelRef = useRef(false);

  const styledEdges = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return edges.map((edge) => {
      const target = nodeById.get(edge.target);
      const status = target?.data.status;
      let stroke = "rgba(255, 255, 255, 0.2)";
      if (status === "success") {
        stroke = "rgba(16, 185, 129, 0.9)";
      } else if (status === "fail") {
        stroke = "rgba(239, 68, 68, 0.95)";
      } else if (status === "running" || status === "retrying") {
        stroke = "rgba(59, 130, 246, 0.95)";
      }
      const isAnimated = status === "running" || status === "retrying";
      return {
        ...edge,
        type: isAnimated ? ("flow" as const) : ("smoothstep" as const),
        animated: isAnimated,
        style: { stroke, strokeWidth: 1.8 }
      };
    });
  }, [edges, nodes]);

  // WebSocket 连接
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") ?? "";
    const port = params.get("port") ?? "8787";

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    wsRef.current = ws;
    setWsStatus("connecting");

    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("disconnected");

    ws.onmessage = (message) => {
      const evt = JSON.parse(String(message.data)) as GraphEnvelope<unknown>;
      applyEnvelope(evt);
    };

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [applyEnvelope]);

  const semanticNodes = useMemo(() => {
    return nodes.map((node) => ({ ...node, type: "semantic" })) as Node<GraphNodeData>[];
  }, [nodes]);

  // 异步布局（Worker 线程）
  useEffect(() => {
    layoutCancelRef.current = false;

    const timer = window.setTimeout(() => {
      void applyDagreLayoutAsync(semanticNodes as Node[], styledEdges as Edge[], "TB", new Set(lockedNodeIds)).then(
        (result) => {
          if (!layoutCancelRef.current) {
            setLayoutedNodes(result as Node<GraphNodeData>[]);
          }
        }
      );
    }, 100);

    return () => {
      window.clearTimeout(timer);
      layoutCancelRef.current = true;
    };
  }, [semanticNodes, styledEdges, lockedNodeIds]);

  useEffect(() => {
    if (!activeDagId) setLayoutedNodes([]);
  }, [activeDagId]);

  // 执行焦点跟踪：自动居中到正在运行的节点
  useEffect(() => {
    if (userInteractedRef.current) return;

    const runningNode = layoutedNodes.find(
      (n) => n.data.status === "running" || n.data.status === "retrying"
    );
    if (runningNode?.position) {
      setCenter(runningNode.position.x + 130, runningNode.position.y + 40, { zoom: 0.95, duration: 500 });
    }
  }, [layoutedNodes, setCenter]);

  // pending_approval 节点：自动选中、居中、重置交互锁
  useEffect(() => {
    if (!pendingApprovalNodeId) return;

    userInteractedRef.current = false;
    selectNode(pendingApprovalNodeId);

    const timer = window.setTimeout(() => {
      const gateNode = layoutedNodes.find((n) => n.id === pendingApprovalNodeId);
      if (gateNode?.position) {
        setCenter(gateNode.position.x + 130, gateNode.position.y + 40, { zoom: 1.1, duration: 600 });
      } else {
        fitView({ padding: 0.2, duration: 600 });
      }
    }, 200);

    return () => window.clearTimeout(timer);
  }, [pendingApprovalNodeId, layoutedNodes, selectNode, setCenter, fitView]);

  const onNodesChange = (changes: NodeChange[]) => {
    const hasPositionChange = changes.some((c) => c.type === "position" && Boolean(c.dragging));
    if (hasPositionChange) userInteractedRef.current = true;
    applyActiveNodeChanges(changes);
  };

  const onPaneClick = () => {
    selectNode(undefined);
    userInteractedRef.current = false;
  };

  const handleApprovalAction = useCallback(
    (action: "approve" | "edit" | "skip" | "abort", params?: string) => {
      if (!wsRef.current || !pendingApprovalNodeId) return;

      const msg: GateActionMessage = { type: "gate.action", gateId: pendingApprovalNodeId, action, params };
      wsRef.current.send(JSON.stringify(msg));
      clearPendingApproval();
    },
    [pendingApprovalNodeId, clearPendingApproval]
  );

  const displayedNodes = layoutedNodes.length > 0 ? layoutedNodes : semanticNodes;

  const emptyCanvasNode = useMemo(() => {
    if (displayedNodes.length > 0 || activeDagId) return displayedNodes;

    return [
      {
        id: "placeholder",
        type: "semantic",
        position: { x: 120, y: 120 },
        draggable: false,
        selectable: false,
        data: { title: "等待会话事件", kind: "system", status: "pending", subtitle: "在 CLI 输入问题后，这里会生成 DAG" }
      }
    ] as Node<GraphNodeData>[];
  }, [displayedNodes, activeDagId]);

  // Inspector 内容
  const inspectorContent = useMemo(() => {
    if (!selectedNode) {
      return (
        <div className="inspector-empty">
          <div className="inspector-empty-icon">◌</div>
          <div className="inspector-value">请在画布中选择一个节点查看 DAG 详情...</div>
        </div>
      );
    }

    const isPendingApproval = selectedNode.data.pendingApproval === true;

    if (isPendingApproval && selectedNode.data.approvalPayload) {
      return (
        <div>
          <ApprovalPanel
            toolName={selectedNode.data.approvalPayload.toolName}
            toolParams={selectedNode.data.approvalPayload.toolParams}
            gateId={selectedNode.id}
            onAction={handleApprovalAction}
          />
          <div className="inspector-group" style={{ marginTop: 12 }}>
            <div className="inspector-label">节点</div>
            <div className="inspector-value">{selectedNode.data.title}</div>
            <div className="inspector-code">{selectedNode.id}</div>
          </div>
        </div>
      );
    }

    return (
      <div>
        <div className="inspector-group">
          <div className="inspector-label">节点</div>
          <div className="inspector-value">{selectedNode.data.title}</div>
          <div className="inspector-code">{selectedNode.id}</div>
        </div>

        <div className="inspector-group">
          <div className="inspector-label">类型 / 状态</div>
          <div className="inspector-value">
            {selectedNode.data.kind} / {selectedNode.data.status ?? "pending"}
          </div>
        </div>

        <div className="inspector-group">
          <div className="inspector-label">输入端口</div>
          {(selectedNode.data.inputPorts ?? []).length === 0 ? (
            <div className="inspector-value">无</div>
          ) : (
            (selectedNode.data.inputPorts ?? []).map((port) => (
              <div key={`in-${port.name}`} className="inspector-value" style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600 }}>{port.name}</div>
                {renderPortSummary(port.summary)}
              </div>
            ))
          )}
        </div>

        <div className="inspector-group">
          <div className="inspector-label">输出端口</div>
          {(selectedNode.data.outputPorts ?? []).length === 0 ? (
            <div className="inspector-value">无</div>
          ) : (
            (selectedNode.data.outputPorts ?? []).map((port) => (
              <div key={`out-${port.name}`} className="inspector-value" style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600 }}>{port.name}</div>
                {renderPortSummary(port.summary)}
              </div>
            ))
          )}
        </div>
      </div>
    );
  }, [selectedNode, handleApprovalAction]);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const wsStatusDot = wsStatus === "connected" ? "ws-dot-connected" : wsStatus === "connecting" ? "ws-dot-connecting" : "ws-dot-disconnected";
  const wsStatusLabel = wsStatus === "connected" ? "已连接" : wsStatus === "connecting" ? "连接中" : "已断开";

  const gridCols = `${leftCollapsed ? "36px" : "24%"} 1fr ${rightCollapsed ? "36px" : "26%"}`;

  const panelStyle: React.CSSProperties = {
    background: "rgba(17,17,17,0.82)",
    backdropFilter: "blur(18px)",
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        gridTemplateColumns: gridCols,
        gridTemplateRows: "40px 1fr",
        background: "var(--bg-app)",
        transition: "grid-template-columns 0.26s cubic-bezier(0.4,0,0.2,1)",
      }}
    >
      {/* ── Header Bar ─────────────────────────────────────────────── */}
      <header
        style={{
          gridColumn: "1 / -1",
          gridRow: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          ...panelStyle,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <WeaveIcon size={26} />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.18em", color: "#e2e8f0" }}>WEAVE</span>
          {dagOrder.length > 0 && (
            <span style={{ fontSize: 10, color: "#9ca3af", background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 10, marginLeft: 4 }}>
              {dagOrder.length} 轮对话
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className={`ws-dot ${wsStatusDot}`} />
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{wsStatusLabel}</span>
        </div>
      </header>

      {/* ── Chat Panel Wrapper ──────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          gridRow: 2,
          overflow: "hidden",
          borderRight: "1px solid rgba(255,255,255,0.08)",
          ...panelStyle,
          ...(leftCollapsed ? { display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6px 0" } : {}),
        }}
      >
        <button
          onClick={() => setLeftCollapsed(!leftCollapsed)}
          style={{
            position: "absolute",
            top: "50%",
            right: -9,
            transform: "translateY(-50%)",
            width: 18,
            height: 44,
            background: "rgba(31,41,55,0.95)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 3,
            color: "#9ca3af",
            fontSize: 12,
            cursor: "pointer",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          {leftCollapsed ? "›" : "‹"}
        </button>
        {!leftCollapsed && (
          <ChatPanel
            dagOrder={dagOrder}
            dags={dags}
            activeDagId={activeDagId}
            onSelectDag={setActiveDag}
          />
        )}
        {leftCollapsed && (
          <span style={{ writingMode: "vertical-rl", fontSize: 10, letterSpacing: "0.1em", color: "#6b7280", marginTop: 48 }}>
            CHAT
          </span>
        )}
      </div>

      {/* ── DAG Canvas ─────────────────────────────────────────────── */}
      <main className="canvas-panel">
        <ReactFlow
          nodes={emptyCanvasNode}
          edges={styledEdges}
          fitView
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => {
            userInteractedRef.current = true;
            selectNode(node.id);
          }}
          onPaneClick={onPaneClick}
          defaultEdgeOptions={{ type: "smoothstep" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="rgba(255,255,255,0.08)" />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </main>

      {/* ── Inspector Wrapper ───────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          gridRow: 2,
          overflow: "hidden",
          borderLeft: "1px solid #1f2937",
          background: "linear-gradient(180deg, #0f0f10 0%, #131314 100%)",
          ...(rightCollapsed ? { display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6px 0" } : {}),
        }}
      >
        <button
          onClick={() => setRightCollapsed(!rightCollapsed)}
          style={{
            position: "absolute",
            top: "50%",
            left: -9,
            transform: "translateY(-50%)",
            width: 18,
            height: 44,
            background: "rgba(31,41,55,0.95)",
            border: "1px solid #1f2937",
            borderRadius: 3,
            color: "#9ca3af",
            fontSize: 12,
            cursor: "pointer",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          {rightCollapsed ? "‹" : "›"}
        </button>
        {!rightCollapsed && (
          <aside className="inspector-panel">
            <h3 className="panel-title">Inspector</h3>
            <div className="inspector-content">
              {inspectorContent}
            </div>

            {/* 编排占位区 */}
            <div className="orchestrate-section">
              <div className="orchestrate-title">
                编排 <span>🔒</span>
              </div>
              <button className="orchestrate-btn" disabled>＋ 添加节点</button>
              <button className="orchestrate-btn" disabled>⌗ 编辑图结构</button>
              <button className="orchestrate-btn" disabled>⟲ 从此节点重跑</button>
              <p className="orchestrate-hint">功能开发中</p>
            </div>
          </aside>
        )}
        {rightCollapsed && (
          <span style={{ writingMode: "vertical-rl", fontSize: 10, letterSpacing: "0.1em", color: "#6b7280", marginTop: 48 }}>
            INFO
          </span>
        )}
      </div>
    </div>
  );
}

// ── 外层：注入 ReactFlowProvider ────────────────────────────────────────────

export default function App() {
  return (
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  );
}

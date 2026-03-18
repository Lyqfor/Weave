/*
 * 文件作用：二维图主界面，Chat-DAG 融合三栏布局（深空控制台主题）。
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
import { useGraphStore, portContentToString } from "./store/graph-store";
import { applyDagreLayoutAsync } from "./layout/dagre-layout";
import type { GateActionMessage, GraphEnvelope, GraphNodeData, GraphPort } from "./types/graph-events";
import { SemanticNode } from "./nodes/semantic-node";
import { FlowEdge } from "./edges/FlowEdge";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ChatPanel } from "./components/ChatPanel";
import { WeaveIcon } from "./components/WeaveIcon";
import { InspectorTextBlock } from "./components/InspectorTextBlock";
import { LlmIcon } from "./icons/LlmIcon";
import { ToolIcon } from "./icons/ToolIcon";
import { GateIcon } from "./icons/GateIcon";
import { FinalIcon } from "./icons/FinalIcon";
import { InputIcon } from "./icons/InputIcon";
import { SystemIcon } from "./icons/SystemIcon";
import { RepairIcon } from "./icons/RepairIcon";
import { ConditionIcon } from "./icons/ConditionIcon";

const nodeTypes = { semantic: SemanticNode };
const edgeTypes = { flow: FlowEdge };

// Kind → Icon mapping (for Inspector header)
const KIND_ICON_MAP: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  llm: LlmIcon, tool: ToolIcon, attempt: ToolIcon, escalation: ToolIcon,
  condition: ConditionIcon, gate: GateIcon, repair: RepairIcon,
  final: FinalIcon, system: SystemIcon, input: InputIcon,
};

const KIND_COLOR_MAP: Record<string, string> = {
  llm: "#bc8cff", tool: "#58a6ff", attempt: "#58a6ff", escalation: "#58a6ff",
  condition: "#79c0ff", gate: "#ffa657", repair: "#f85149",
  final: "#3fb950", system: "#6e7681", input: "#39d3f5",
};

// Port type badge helper
function getPortTypeBadgeClass(portType?: string): string {
  if (portType === "json") return "json";
  if (portType === "messages") return "messages";
  if (portType === "number") return "number";
  if (portType === "text") return "text";
  return "default";
}

function renderPort(port: GraphPort) {
  if (port.blobRef) {
    return <BlobPortBlock blobRef={port.blobRef} portName={port.name} />;
  }
  const text = portContentToString(port.content);
  return <InspectorTextBlock text={text} />;
}

/** 懒加载 Blob 端口内容 */
function BlobPortBlock({ blobRef, portName }: { blobRef: string; portName: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    if (loading || content !== null) return;
    setLoading(true);
    const params = new URLSearchParams(window.location.search);
    const port = params.get("port") ?? "8787";
    fetch(`http://127.0.0.1:${port}/api/blob/${blobRef}`)
      .then((r) => r.text())
      .then((text) => { setContent(text); setLoading(false); })
      .catch(() => { setContent("[加载失败]"); setLoading(false); });
  };

  if (content !== null) {
    return <InspectorTextBlock text={content} />;
  }

  return (
    <button
      className="inspector-btn"
      style={{ marginTop: 4 }}
      onClick={load}
      disabled={loading}
    >
      {loading ? "加载中..." : `⬇ 大内容 · 点击加载 (${portName})`}
    </button>
  );
}

/** 端口区块（可折叠） */
function PortSection({
  title,
  ports,
  defaultOpen = true,
}: {
  title: string;
  ports: GraphPort[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (ports.length === 0) return null;

  return (
    <div className="port-section">
      <div className="port-section-header" onClick={() => setOpen(!open)}>
        <span className={`port-section-chevron ${open ? "" : "collapsed"}`}>▼</span>
        <span>{title}</span>
        <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
          ({ports.length})
        </span>
      </div>
      <div className={`port-section-body ${open ? "" : "collapsed"}`} style={{ maxHeight: open ? "none" : "0" }}>
        {ports.map((port) => (
          <div key={port.name} className="port-entry">
            <div className="port-entry-header">
              <span className={`port-type-badge ${getPortTypeBadgeClass((port as { type?: string }).type)}`}>
                {((port as { type?: string }).type ?? "text").toUpperCase().slice(0, 4)}
              </span>
              <span className="port-entry-name">{port.name}</span>
              <button
                className="inspector-btn"
                style={{ padding: "1px 6px", fontSize: 9 }}
                onClick={() => {
                  const text = portContentToString(port.content);
                  void navigator.clipboard.writeText(text).catch(() => {});
                }}
              >
                复制
              </button>
            </div>
            <div className="port-entry-content">
              {renderPort(port)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
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
      let stroke = "rgba(48, 54, 61, 0.7)";
      if (status === "success") {
        stroke = "rgba(63, 185, 80, 0.75)";
      } else if (status === "fail") {
        stroke = "rgba(248, 81, 73, 0.9)";
      } else if (status === "running" || status === "retrying") {
        stroke = "rgba(88, 166, 255, 0.95)";
      } else if (status === "skipped") {
        stroke = "rgba(110, 118, 129, 0.4)";
      }
      const isAnimated = status === "running" || status === "retrying";
      return {
        ...edge,
        type: isAnimated ? ("flow" as const) : ("flow" as const),
        animated: isAnimated,
        style: { stroke, strokeWidth: isAnimated ? 2 : 1.4 }
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
      setCenter(runningNode.position.x + 120, runningNode.position.y + 36, { zoom: 0.95, duration: 500 });
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
        setCenter(gateNode.position.x + 120, gateNode.position.y + 36, { zoom: 1.1, duration: 600 });
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

  // Inspector 内容（重构：节点头部 + 指标卡片 + 端口折叠区）
  const inspectorContent = useMemo(() => {
    if (!selectedNode) {
      return (
        <div className="inspector-empty">
          <div className="inspector-empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
              <circle cx="12" cy="12" r="9" stroke="#6e7681" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="3" stroke="#6e7681" strokeWidth="1.5" />
              <line x1="3" y1="12" x2="9" y2="12" stroke="#6e7681" strokeWidth="1.5" />
              <line x1="15" y1="12" x2="21" y2="12" stroke="#6e7681" strokeWidth="1.5" />
            </svg>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            选择节点查看详情
          </div>
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
          <NodeDetailSection node={selectedNode} />
        </div>
      );
    }

    return (
      <div>
        <NodeDetailSection node={selectedNode} />
      </div>
    );
  }, [selectedNode, handleApprovalAction]);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const wsStatusDot = wsStatus === "connected" ? "ws-dot-connected" : wsStatus === "connecting" ? "ws-dot-connecting" : "ws-dot-disconnected";
  const wsStatusLabel = wsStatus === "connected" ? "已连接" : wsStatus === "connecting" ? "连接中" : "已断开";

  const gridCols = `${leftCollapsed ? "36px" : "24%"} 1fr ${rightCollapsed ? "36px" : "26%"}`;

  // Header stats
  const activeDagNodes = activeDag?.nodes ?? [];
  const successCount = activeDagNodes.filter((n) => n.data.status === "success").length;
  const totalCount = activeDagNodes.length;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        gridTemplateColumns: gridCols,
        gridTemplateRows: "48px 1fr",
        background: "var(--bg-app)",
        transition: "grid-template-columns 0.26s cubic-bezier(0.4,0,0.2,1)",
      }}
    >
      {/* ── Header Bar（48px 三区布局）────────────────────────────────── */}
      <header
        style={{
          gridColumn: "1 / -1",
          gridRow: 1,
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          padding: "0 16px",
          background: "rgba(13,17,23,0.9)",
          backdropFilter: "blur(18px)",
          borderBottom: "1px solid var(--border-dim)",
          zIndex: 10,
        }}
      >
        {/* 左区：品牌 + 轮次徽章 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <WeaveIcon size={26} />
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.2em", color: "#e6edf3" }}>WEAVE</span>
          <span style={{ fontSize: 10, color: "#6e7681", letterSpacing: "0.05em" }}>v0.2</span>
          {dagOrder.length > 0 && (
            <span style={{
              fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
              color: "#58a6ff", background: "rgba(88,166,255,0.1)",
              border: "1px solid rgba(88,166,255,0.2)",
              padding: "2px 7px", borderRadius: 10,
            }}>
              {dagOrder.length} 轮
            </span>
          )}
        </div>

        {/* 中区：活跃 runId 摘要 + 进度统计 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
          {activeDagId && (
            <>
              <span style={{ fontSize: 10, color: "#6e7681", fontFamily: "'JetBrains Mono', monospace", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {activeDagId.slice(0, 16)}...
              </span>
              {totalCount > 0 && (
                <span style={{
                  fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                  color: successCount === totalCount ? "#3fb950" : "#8b949e",
                }}>
                  {successCount}/{totalCount} 节点完成
                </span>
              )}
            </>
          )}
        </div>

        {/* 右区：fitView + WS 状态 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={() => fitView({ padding: 0.15, duration: 400 })}
            style={{
              background: "rgba(88,166,255,0.08)",
              border: "1px solid var(--border-dim)",
              color: "#8b949e",
              borderRadius: 5,
              padding: "3px 10px",
              fontSize: 10,
              cursor: "pointer",
              fontFamily: "inherit",
              letterSpacing: "0.04em",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(88,166,255,0.15)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(88,166,255,0.08)")}
          >
            FitView
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span className={`ws-dot ${wsStatusDot}`} />
            <span style={{ fontSize: 10, color: "#6e7681" }}>{wsStatusLabel}</span>
          </div>
        </div>
      </header>

      {/* ── Chat Panel Wrapper ──────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          gridRow: 2,
          overflow: "hidden",
          borderRight: "1px solid var(--border-dim)",
          background: "rgba(13,17,23,0.88)",
          backdropFilter: "blur(18px)",
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
            height: 40,
            background: "rgba(22,27,34,0.95)",
            border: "1px solid var(--border-dim)",
            borderRadius: 3,
            color: "#6e7681",
            fontSize: 11,
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
          <span style={{ writingMode: "vertical-rl", fontSize: 9, letterSpacing: "0.12em", color: "#484f58", marginTop: 48, fontWeight: 700 }}>
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
          defaultEdgeOptions={{ type: "flow" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(88,166,255,0.06)" />
          <MiniMap
            style={{ background: "rgba(13,17,23,0.9)", border: "1px solid var(--border-dim)" }}
            maskColor="rgba(7,11,16,0.7)"
          />
          <Controls style={{ background: "rgba(13,17,23,0.9)", border: "1px solid var(--border-dim)" }} />
        </ReactFlow>
      </main>

      {/* ── Inspector Wrapper ───────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          gridRow: 2,
          overflow: "hidden",
          borderLeft: "1px solid var(--border-dim)",
          background: "linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-base) 100%)",
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
            height: 40,
            background: "rgba(22,27,34,0.95)",
            border: "1px solid var(--border-dim)",
            borderRadius: 3,
            color: "#6e7681",
            fontSize: 11,
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
              <div className="orchestrate-title">编排 🔒</div>
              <button className="orchestrate-btn" disabled>＋ 添加节点</button>
              <button className="orchestrate-btn" disabled>⌗ 编辑图结构</button>
              <button className="orchestrate-btn" disabled>⟲ 从此节点重跑</button>
              <p className="orchestrate-hint">功能开发中</p>
            </div>
          </aside>
        )}
        {rightCollapsed && (
          <span style={{ writingMode: "vertical-rl", fontSize: 9, letterSpacing: "0.12em", color: "#484f58", marginTop: 48, fontWeight: 700 }}>
            INFO
          </span>
        )}
      </div>
    </div>
  );
}

/** 节点详情分区（用于普通节点 Inspector） */
function NodeDetailSection({ node }: { node: Node<GraphNodeData> }) {
  const { error, metrics, kind, status } = node.data;
  const hasMetrics = metrics && Object.keys(metrics).some((k) => metrics[k as keyof typeof metrics] !== undefined);
  const IconComp = KIND_ICON_MAP[kind ?? "tool"] ?? ToolIcon;
  const kindColor = KIND_COLOR_MAP[kind ?? "tool"] ?? "#58a6ff";

  const statusBadgeStyle = getStatusBadgeStyle(status);

  const inputPorts = node.data.inputPorts ?? [];
  const outputPorts = node.data.outputPorts ?? [];

  return (
    <div>
      {/* 错误区域 */}
      {error && (
        <div className="inspector-group" style={{ borderLeft: "3px solid #f85149", paddingLeft: 8 }}>
          <div className="inspector-label" style={{ color: "#f85149" }}>错误</div>
          <div className="inspector-value" style={{ color: "#f85149", fontWeight: 600 }}>
            {error.name}: {error.message}
          </div>
          {error.stack && <InspectorTextBlock text={error.stack} />}
        </div>
      )}

      {/* ① 节点头部卡片 */}
      <div className="inspector-node-header">
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
          <IconComp size={20} color={kindColor} />
          <span style={{ fontSize: 10, color: kindColor, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {kind ?? "node"}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
          {node.data.title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {node.id}
          </span>
          <span
            className="status-badge"
            style={{ background: statusBadgeStyle.bg, color: statusBadgeStyle.color, border: `1px solid ${statusBadgeStyle.color}40` }}
          >
            {statusBadgeStyle.text}
          </span>
        </div>
      </div>

      {/* ③ 指标卡片 */}
      {hasMetrics && (
        <div className="stat-cards">
          {metrics?.durationMs !== undefined && (
            <div className="stat-card">
              <div className="stat-card-value">{metrics.durationMs}<span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>ms</span></div>
              <div className="stat-card-label">执行耗时</div>
            </div>
          )}
          {(metrics?.promptTokens !== undefined || metrics?.completionTokens !== undefined) && (
            <div className="stat-card">
              <div className="stat-card-value" style={{ fontSize: 14 }}>
                {metrics?.promptTokens ?? "?"}<span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}>+</span>{metrics?.completionTokens ?? "?"}
              </div>
              <div className="stat-card-label">输入 / 输出 Token</div>
            </div>
          )}
        </div>
      )}

      {/* 依赖区域 */}
      {(node.data.dependencies ?? []).length > 0 && (
        <div className="inspector-group">
          <div className="inspector-label">依赖节点</div>
          {(node.data.dependencies ?? []).map((depId) => (
            <div key={depId} className="inspector-code" style={{ marginBottom: 2, color: "var(--text-muted)" }}>{depId}</div>
          ))}
        </div>
      )}

      {/* ④ 输入端口区 */}
      <PortSection title="输入端口" ports={inputPorts} />

      {/* ⑤ 输出端口区 */}
      <PortSection title="输出端口" ports={outputPorts} />
    </div>
  );
}

function getStatusBadgeStyle(status?: string) {
  switch (status) {
    case "running":   return { text: "RUNNING", bg: "rgba(240,165,0,0.18)",   color: "#f0a500" };
    case "retrying":  return { text: "RETRY",   bg: "rgba(232,133,42,0.18)",  color: "#e8852a" };
    case "success":   return { text: "DONE",    bg: "rgba(63,185,80,0.15)",   color: "#3fb950" };
    case "fail":      return { text: "FAIL",    bg: "rgba(248,81,73,0.18)",   color: "#f85149" };
    case "skipped":   return { text: "SKIP",    bg: "rgba(110,118,129,0.15)", color: "#6e7681" };
    default:          return { text: "WAIT",    bg: "rgba(48,54,61,0.4)",     color: "#6e7681" };
  }
}

// ── 外层：注入 ReactFlowProvider ────────────────────────────────────────────

export default function App() {
  return (
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  );
}

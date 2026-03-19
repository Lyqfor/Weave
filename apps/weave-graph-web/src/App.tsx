/*
 * 文件作用：二维图主界面，Chat-DAG 融合三栏布局（高级暗色工作室主题）。
 * 左侧：聊天面板（ChatPanel）；中间：DAG 画布；右侧：节点 Inspector（纵向 Accordion 布局）。
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
import { useGraphStore, portContentToString, resolveRpc } from "./store/graph-store";
import { applyDagreLayoutAsync } from "./layout/dagre-layout";
import type { GraphEnvelope, GraphNodeData, GraphPort } from "./types/graph-events";
import { SemanticNode } from "./nodes/semantic-node";
import { FlowEdge } from "./edges/FlowEdge";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ChatPanel } from "./components/ChatPanel";
import { WeaveIcon } from "./components/WeaveIcon";
import { InspectorTextBlock } from "./components/InspectorTextBlock";
import { LlmIcon } from "./icons/LlmIcon";
import { ToolIcon } from "./icons/ToolIcon";
import { AttemptIcon } from "./icons/AttemptIcon";
import { EscalationIcon } from "./icons/EscalationIcon";
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
  llm: LlmIcon, tool: ToolIcon, attempt: AttemptIcon, escalation: EscalationIcon,
  condition: ConditionIcon, gate: GateIcon, repair: RepairIcon,
  final: FinalIcon, system: SystemIcon, input: InputIcon,
};

const KIND_COLOR_MAP: Record<string, string> = {
  llm: "#b48aff", tool: "#5aadff", attempt: "#5aadff", escalation: "#ff6057",
  condition: "#7ec8ff", gate: "#ffab5e", repair: "#ff6057",
  final: "#3dc653", system: "#6e7a90", input: "#38d8f8",
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

/** 端口区块（Accordion 折叠） */
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
        <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
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
      // 状态颜色系统（升级版）
      let stroke = "rgba(255, 255, 255, 0.07)";  // pending：中性极弱白线
      if (status === "success") {
        stroke = "rgba(61, 198, 83, 0.22)";   // 成功：低调暗绿，不抢戏
      } else if (status === "fail") {
        stroke = "rgba(255, 96, 87, 0.7)";    // 失败：暗红
      } else if (status === "running" || status === "retrying") {
        stroke = "rgba(90, 173, 255, 0.95)";  // 运行中：亮蓝（彗星流光覆盖）
      } else if (status === "skipped") {
        stroke = "rgba(90, 102, 120, 0.35)";  // 跳过：淡灰
      } else if (!status || status === "pending") {
        stroke = "rgba(255, 255, 255, 0.08)"; // 排队：极弱白线
      }
      const isAnimated = status === "running" || status === "retrying";
      const isFail = status === "fail";
      return {
        ...edge,
        type: "flow" as const,
        animated: isAnimated,
        style: {
          stroke,
          strokeWidth: isAnimated ? 1.7 : 1.4,
          ...(isFail ? { strokeDasharray: "4 4" } : {}),
        }
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
      try {
        const data = JSON.parse(String(message.data));
        // 轨道区分：server.response (RPC) vs 广播 (Graph)
        if (data.eventType === "server.response") {
          resolveRpc(data.reqId, data.ok, data.error, data.payload);
        } else {
          applyEnvelope(data);
        }
      } catch (e) {
        console.error("Failed to parse WS message", e);
      }
    };

    const handleRpcSend = (e: any) => {
      const { envelope } = e.detail;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(envelope));
      }
    };
    window.addEventListener("weave:rpc:send", handleRpcSend);

    return () => {
      window.removeEventListener("weave:rpc:send", handleRpcSend);
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
      setCenter(runningNode.position.x + 124, runningNode.position.y + 36, { zoom: 0.95, duration: 500 });
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
        setCenter(gateNode.position.x + 124, gateNode.position.y + 36, { zoom: 1.1, duration: 600 });
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

  const displayedNodes = layoutedNodes.length > 0 ? layoutedNodes : semanticNodes;

  const emptyCanvasNode = displayedNodes;

  // Inspector 内容（纵向 Accordion 布局，无 Tabs）
  const inspectorContent = useMemo(() => {
    if (!selectedNode) {
      return (
        <div className="inspector-empty">
          <div className="inspector-empty-icon">🔍</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
            点击 DAG 节点
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", opacity: 0.7 }}>
            查看输入 / 输出 / 指标
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
  }, [selectedNode]);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const wsStatusDot = wsStatus === "connected" ? "ws-dot-connected" : wsStatus === "connecting" ? "ws-dot-connecting" : "ws-dot-disconnected";
  const wsStatusLabel = wsStatus === "connected" ? "已连接" : wsStatus === "connecting" ? "连接中" : "已断开";

  const gridCols = `${leftCollapsed ? "36px" : "24%"} 1fr ${rightCollapsed ? "36px" : "26%"}`;

  // Header 进度统计
  const activeDagNodes = activeDag?.nodes ?? [];
  const successCount = activeDagNodes.filter((n) => n.data.status === "success").length;
  const totalCount = activeDagNodes.length;
  const progressPct = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;
  const isComplete = totalCount > 0 && successCount === totalCount;

  // Canvas 是否为空（显示空状态水印）
  const isCanvasEmpty = displayedNodes.length === 0 && !activeDagId;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        gridTemplateColumns: gridCols,
        gridTemplateRows: "52px 1fr",
        background: "var(--bg-app)",
        transition: "grid-template-columns 0.26s cubic-bezier(0.4,0,0.2,1)",
      }}
    >
      {/* ── Header Bar（52px 三区布局）────────────────────────────────── */}
      <header
        style={{
          gridColumn: "1 / -1",
          gridRow: 1,
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          padding: "0 18px",
          background: "rgba(11, 14, 22, 0.88)",
          backdropFilter: "blur(24px) saturate(1.3)",
          WebkitBackdropFilter: "blur(24px) saturate(1.3)",
          boxShadow: "0 1px 0 rgba(100, 140, 220, 0.12)",
          zIndex: 10,
        }}
      >
        {/* 左区：品牌 + 轮次徽章 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <WeaveIcon size={24} />
          <span 
              className="weave-galaxy-text"
              style={{
            fontSize: 14, fontWeight: 800,
            letterSpacing: "0.25em",
            // color: "rgba(221, 230, 240, 0.92)",
            fontFamily: "var(--font-ui)",
          }}>WEAVE</span>
          {/* 版本号药丸 */}
          <span style={{
            fontSize: 9,
            color: "#b48aff",
            background: "rgba(180, 138, 255, 0.1)",
            border: "1px solid rgba(180, 138, 255, 0.2)",
            borderRadius: 12,
            padding: "1px 7px",
            letterSpacing: "0.04em",
          }}>v0.2</span>
          {dagOrder.length > 0 && (
            <span style={{
              fontSize: 9, fontFamily: "var(--font-mono)",
              color: "#5aadff", background: "rgba(90,173,255,0.1)",
              border: "1px solid rgba(90,173,255,0.2)",
              padding: "2px 7px", borderRadius: 10,
            }}>
              {dagOrder.length} 轮
            </span>
          )}
        </div>

        {/* 中区：活跃 runId 摘要 + 进度条 */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, justifyContent: "center" }}>
          {activeDagId ? (
            <>
              <span style={{
                fontSize: 10, color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                maxWidth: 140, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                🔗 {activeDagId.slice(0, 16)}...
              </span>
              {totalCount > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {/* 进度条 */}
                  <div style={{
                    width: 72, height: 3,
                    background: "rgba(255,255,255,0.08)",
                    borderRadius: 2, overflow: "hidden",
                  }}>
                    <div style={{
                      height: "100%",
                      width: `${progressPct}%`,
                      background: isComplete
                        ? "linear-gradient(90deg, #3dc653, #38d8f8)"
                        : "linear-gradient(90deg, #5aadff, #b48aff)",
                      borderRadius: 2,
                      transition: "width 0.4s var(--ease-out-quart)",
                    }} />
                  </div>
                  <span style={{
                    fontSize: 10, fontFamily: "var(--font-mono)",
                    color: isComplete ? "#3dc653" : "var(--text-secondary)",
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {successCount}/{totalCount}
                  </span>
                </div>
              )}
            </>
          ) : (
            <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em" }}>
              🌌 Weave Graph
            </span>
          )}
        </div>

        {/* 右区：fitView + WS 状态 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={() => fitView({ padding: 0.15, duration: 400 })}
            style={{
              background: "rgba(90,173,255,0.08)",
              border: "1px solid var(--border-dim)",
              color: "var(--text-secondary)",
              borderRadius: 8,
              padding: "4px 12px",
              fontSize: 10,
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
              letterSpacing: "0.04em",
              transition: "background var(--duration-fast), box-shadow var(--duration-fast), transform var(--duration-fast) var(--ease-out-quart)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(90,173,255,0.16)";
              (e.currentTarget as HTMLElement).style.boxShadow = "0 0 0 1px rgba(90,173,255,0.3)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(90,173,255,0.08)";
              (e.currentTarget as HTMLElement).style.boxShadow = "";
              (e.currentTarget as HTMLElement).style.transform = "";
            }}
          >
            ⊞ 居中视图
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span className={`ws-dot ${wsStatusDot}`} />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{wsStatusLabel}</span>
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
          background: "rgba(11, 14, 22, 0.88)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          ...(leftCollapsed ? { display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6px 0" } : {}),
        }}
      >
        {/* 折叠按钮 */}
        <button
          onClick={() => setLeftCollapsed(!leftCollapsed)}
          style={{
            position: "absolute",
            top: "50%",
            right: -10,
            transform: "translateY(-50%)",
            width: 20,
            height: 48,
            background: "rgba(18, 22, 38, 0.92)",
            border: "1px solid rgba(58, 68, 92, 0.5)",
            borderRadius: 10,
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            backdropFilter: "blur(8px)",
            transition: "background var(--duration-fast), color var(--duration-fast)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(30, 38, 60, 0.95)";
            (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(18, 22, 38, 0.92)";
            (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
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
          <span style={{
            writingMode: "vertical-rl",
            fontSize: 8, letterSpacing: "0.14em",
            color: "#3a4458", marginTop: 48, fontWeight: 700,
          }}>
            CHAT
          </span>
        )}
      </div>

      {/* ── DAG Canvas ─────────────────────────────────────────────── */}
      <main className="canvas-panel" style={{ position: "relative" }}>
        {/* 环境氛围光：中性钛灰 + 微暖琥珀，配合曜石黑不扰色 */}
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden",
        }}>
          {/* 左上角：钛灰/极弱冷白光（模拟屏幕高光反射）*/}
          <div style={{
            position: "absolute", top: "-30%", left: "-15%",
            width: "60%", height: "70%",
            background: "radial-gradient(ellipse, rgba(255,255,255,0.03) 0%, transparent 70%)",
            filter: "blur(60px)",
          }} />
          {/* 右下角：极微弱暖琥珀光（增加物理温度感）*/}
          <div style={{
            position: "absolute", bottom: "-25%", right: "-10%",
            width: "55%", height: "65%",
            background: "radial-gradient(ellipse, rgba(210,180,140,0.02) 0%, transparent 70%)",
            filter: "blur(60px)",
          }} />
        </div>

        {/* Canvas 空状态：Weave 品牌化启动画面 */}
        {isCanvasEmpty && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            pointerEvents: "none", zIndex: 1, gap: 0,
          }}>
            <div style={{ fontSize: 188, opacity: 0.8, userSelect: "none", lineHeight: 1 }}>🌌</div>
            <div 
              className="weave-galaxy-text"
              style={{
                fontFamily: "var(--font-mono)", 
                fontSize: 64, 
                fontWeight: 800,
                letterSpacing: "0.25em",
                marginTop: 16, 
                userSelect: "none",
              }}
            >
              WEAVE
            </div>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 24,
              color: "rgba(255,255,255,0.8)",
              marginTop: 12, letterSpacing: "0.12em",
            }}>
              DAG 可视化引擎 · 等待执行<span className="cursor-blink">_</span>
            </div>
          </div>
        )}

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
          <Background
            variant={BackgroundVariant.Dots}
            gap={28}
            size={1}
            color="rgba(255, 255, 255, 0.05)"
          />
          <MiniMap
            style={{ background: "var(--bg-surface)" }}
            maskColor="rgba(8, 11, 20, 0.75)"
          />
          <Controls />
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
        {/* 折叠按钮 */}
        <button
          onClick={() => setRightCollapsed(!rightCollapsed)}
          style={{
            position: "absolute",
            top: "50%",
            left: -10,
            transform: "translateY(-50%)",
            width: 20,
            height: 48,
            background: "rgba(18, 22, 38, 0.92)",
            border: "1px solid rgba(58, 68, 92, 0.5)",
            borderRadius: 10,
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            backdropFilter: "blur(8px)",
            transition: "background var(--duration-fast), color var(--duration-fast)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(30, 38, 60, 0.95)";
            (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(18, 22, 38, 0.92)";
            (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
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
              <div className="orchestrate-title">🔒 编排</div>
              <button className="orchestrate-btn" disabled>➕ 添加节点</button>
              <button className="orchestrate-btn" disabled>✏️ 编辑结构</button>
              <button className="orchestrate-btn" disabled>🔁 从此节点重跑</button>
              <p className="orchestrate-hint">🔒 即将推出</p>
            </div>
          </aside>
        )}
        {rightCollapsed && (
          <span style={{
            writingMode: "vertical-rl",
            fontSize: 8, letterSpacing: "0.14em",
            color: "#3a4458", marginTop: 48, fontWeight: 700,
          }}>
            INFO
          </span>
        )}
      </div>
    </div>
  );
}

/** 节点详情分区（纵向 Accordion，无 Tabs）*/
function NodeDetailSection({ node }: { node: Node<GraphNodeData> }) {
  const { error, metrics, kind, status } = node.data;
  const hasMetrics = metrics && Object.keys(metrics).some((k) => metrics[k as keyof typeof metrics] !== undefined);
  const IconComp = KIND_ICON_MAP[kind ?? "tool"] ?? ToolIcon;
  const kindColor = KIND_COLOR_MAP[kind ?? "tool"] ?? "#5aadff";

  const statusBadgeStyle = getStatusBadgeStyle(status);

  const inputPorts = node.data.inputPorts ?? [];
  const outputPorts = node.data.outputPorts ?? [];

  return (
    <div>
      {/* 错误区域 */}
      {error && (
        <div className="inspector-group" style={{
          borderLeft: "3px solid #ff6057",
          paddingLeft: 10,
          background: "rgba(255, 96, 87, 0.05)",
          borderRadius: "0 6px 6px 0",
        }}>
          <div className="inspector-label" style={{ color: "#ff6057" }}>⚠️ 错误</div>
          <div className="inspector-value" style={{ color: "#ff6057", fontWeight: 600 }}>
            {error.name}: {error.message}
          </div>
          {error.stack && <InspectorTextBlock text={error.stack} />}
        </div>
      )}

      {/* ① 节点头部卡片（Sticky，向下滚动时固定）*/}
      <div className="inspector-sticky-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          {/* emoji 图标背景圆圈 */}
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: `${kindColor}18`,
            border: `1px solid ${kindColor}30`,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <IconComp size={18} color={kindColor} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 10, color: kindColor,
              fontWeight: 700, letterSpacing: "0.07em",
              textTransform: "uppercase", marginBottom: 2,
            }}>
              {kind ?? "node"}
            </div>
            <div style={{
              fontSize: 14, fontWeight: 700,
              color: "var(--text-primary)",
              overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {node.data.title}
            </div>
          </div>
          <span
            className="status-badge"
            style={{
              background: statusBadgeStyle.bg,
              color: statusBadgeStyle.color,
              border: `1px solid ${statusBadgeStyle.color}40`,
              flexShrink: 0,
            }}
          >
            {statusBadgeStyle.text}
          </span>
        </div>
        {/* 节点 ID */}
        <div style={{
          fontSize: 10, color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}>
          {node.id}
        </div>
      </div>

      {/* ② 指标卡片（Vercel Dashboard 风格）*/}
      {hasMetrics && (
        <div className="stat-cards">
          {metrics?.durationMs !== undefined && (
            <div className="stat-card">
              <div className="stat-card-value">
                {metrics.durationMs}
                <span style={{
                  fontSize: 12, fontWeight: 400,
                  WebkitTextFillColor: "var(--text-muted)",
                  background: "none",
                }}>ms</span>
              </div>
              <div className="stat-card-label">执行耗时</div>
            </div>
          )}
          {(metrics?.promptTokens !== undefined || metrics?.completionTokens !== undefined) && (
            <div className="stat-card">
              <div className="stat-card-value" style={{ fontSize: 16 }}>
                {metrics?.promptTokens ?? "?"}
                <span style={{
                  fontSize: 11, fontWeight: 400,
                  WebkitTextFillColor: "var(--text-muted)",
                  background: "none",
                }}>+</span>
                {metrics?.completionTokens ?? "?"}
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

      {/* ③ 输入端口区（Accordion，默认展开）*/}
      <PortSection title="🔢 输入" ports={inputPorts} />

      {/* ④ 输出端口区（Accordion，默认展开）*/}
      <PortSection title="📤 输出" ports={outputPorts} />
    </div>
  );
}

function getStatusBadgeStyle(status?: string) {
  switch (status) {
    case "running":   return { text: "RUNNING", bg: "rgba(245,166,35,0.18)",  color: "#f5a623" };
    case "retrying":  return { text: "RETRY",   bg: "rgba(232,135,42,0.18)",  color: "#e8872a" };
    case "success":   return { text: "DONE",    bg: "rgba(61,198,83,0.15)",   color: "#3dc653" };
    case "fail":      return { text: "FAIL",    bg: "rgba(255,96,87,0.18)",   color: "#ff6057" };
    case "skipped":   return { text: "SKIP",    bg: "rgba(110,122,144,0.15)", color: "#6e7a90" };
    default:          return { text: "WAIT",    bg: "rgba(48,54,61,0.4)",     color: "#5a6b82" };
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

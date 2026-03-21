/*
 * 文件作用：二维图主界面，Chat-DAG 融合三栏布局（顶级设计重构版）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange
} from "reactflow";
import "reactflow/dist/style.css";
import "./app.css";
import { useGraphStore, portContentToString, resolveRpc } from "./store/graph-store";
import { applyDagreLayoutAsync } from "./layout/dagre-layout";
import type { GraphNodeData, GraphPort } from "./types/graph-events";
import { SemanticNode } from "./nodes/semantic-node";
import { FlowEdge } from "./edges/FlowEdge";
import { ApprovalPanel } from "./components/ApprovalPanel";
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

// New Layout Components
import { Header } from "./components/layout/Header";
import { LeftPanel } from "./components/layout/LeftPanel";
import { RightPanel } from "./components/layout/RightPanel";
import { CosmicBackground } from "./effects/CosmicBackground";
import { usePerformance } from "./hooks/usePerformance";
import { Incarnation } from "./components/Incarnation";

const nodeTypes = { semantic: SemanticNode };
const edgeTypes = { flow: FlowEdge };

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
              <span className={`port-type-badge ${getPortTypeBadgeClass((port as any).type)}`}>
                {((port as any).type ?? "text").toUpperCase().slice(0, 4)}
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

function GraphCanvas({ isWeavingStarted, setIsWeavingStarted }: { isWeavingStarted: boolean, setIsWeavingStarted: (val: boolean) => void }) {
  const dags = useGraphStore((s) => s.dags);
  const dagOrder = useGraphStore((s) => s.dagOrder);
  const activeDagId = useGraphStore((s) => s.activeDagId);
  const setActiveDag = useGraphStore((s) => s.setActiveDag);
  const selectNode = useGraphStore((s) => s.selectNode);
  const applyActiveNodeChanges = useGraphStore((s) => s.applyActiveNodeChanges);
  const applyEnvelope = useGraphStore((s) => s.applyEnvelope);
  const pendingApprovalNodeId = useGraphStore((s) => s.pendingApprovalNodeId);

  const { fitView } = useReactFlow();

  const activeDag = activeDagId ? dags[activeDagId] : undefined;
  const nodes = useMemo(() => activeDag?.nodes ?? [], [activeDag?.nodes]);
  const edges = useMemo(() => activeDag?.edges ?? [], [activeDag?.edges]);
  const lockedNodeIds = useMemo(() => activeDag?.lockedNodeIds ?? [], [activeDag?.lockedNodeIds]);
  const selectedNodeId = activeDag?.selectedNodeId;

  // 1. 核心状态：本地节点与视角控制状态
  const [localNodes, setLocalNodes] = useState<Node<GraphNodeData>[]>([]);
  const localNodesRef = useRef<Node<GraphNodeData>[]>([]);
  localNodesRef.current = localNodes;

  const isDraggingRef = useRef(false);
  const userInteractedRef = useRef(false);
  const sessionManager = useRef<Record<string, { autoCentered: boolean; userInteracted: boolean }>>({});
  
  // 用于追踪由于尺寸变化需要重新布局的标志
  const [layoutTriggerStamp, setLayoutTriggerStamp] = useState(0);
  const dimensionsCacheRef = useRef<Record<string, { w: number, h: number }>>({});
  const prevDagIdRef = useRef(activeDagId);

  // 2. 响应式同步：全局 nodes 变化时立即更新 localNodes，确保状态秒出，同时隐藏未布局的新节点
  useEffect(() => {
    if (isDraggingRef.current) return;

    setLocalNodes(nds => {
      const isSwitching = prevDagIdRef.current !== activeDagId;
      if (isSwitching) {
        prevDagIdRef.current = activeDagId;
      }

      return nodes.map(n => {
        // 关键修复：跨会话时不复用 existing，避免出现将上一个会话的节点移动到新会话的问题，解决节点丢失 Bug。
        const existing = isSwitching ? undefined : nds.find(ln => ln.id === n.id);
        const isNewNode = !existing;
        
        return {
          ...n,
          type: 'semantic',
          // 关键修复：显式同步 store 里的选中状态到 React Flow 节点属性上
          selected: n.id === selectedNodeId,
          position: existing?.position ?? n.position,
          hidden: isNewNode ? true : existing?.hidden,
          width: existing?.width,
          height: existing?.height,
        };
      });
    });
  }, [nodes, activeDagId, selectedNodeId]); // 增加 selectedNodeId 依赖确保选中态实时同步

  // 3. 布局就绪逻辑：更新坐标，解除隐藏
  const handleLayoutReady = useCallback((layouted: Node[]) => {
    setLocalNodes(nds => nds.map(n => {
      const match = layouted.find(l => l.id === n.id);
      return match ? { ...n, position: match.position, hidden: false } : n;
    }));

    // 4. 视角管理中心
    if (activeDagId) {
      if (!sessionManager.current[activeDagId]) {
        sessionManager.current[activeDagId] = { autoCentered: false, userInteracted: false };
      }
      const state = sessionManager.current[activeDagId];
      // 关键修复：逻辑中 autoCentered 依然作为开关，但在 session switch 时我们会重置 state
      if (!state.userInteracted && !state.autoCentered) {
        window.setTimeout(() => {
          fitView({ padding: 0.3, duration: 800, maxZoom: 0.85 });
          state.autoCentered = true;
        }, 150); // 略微增加延迟确保节点已经 render 完毕
      }
    }
  }, [activeDagId, fitView]);

  // 5. 切换会话时重置对焦状态，确保每次切换都能执行一次居中
  const lastDagId = useRef(activeDagId);
  useEffect(() => {
    if (lastDagId.current !== activeDagId) {
      lastDagId.current = activeDagId;
      if (activeDagId) {
        if (!sessionManager.current[activeDagId]) {
          sessionManager.current[activeDagId] = { autoCentered: false, userInteracted: false };
        } else {
          // 关键修复：切换回旧会话时，同时重置对焦标识和用户交互标识，允许再次触发 fitView
          sessionManager.current[activeDagId].autoCentered = false;
          sessionManager.current[activeDagId].userInteracted = false;
        }
      }
    }
  }, [activeDagId]);

  const wsRef = useRef<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const layoutCancelRef = useRef(false);

  // 4. 连线样式：拖拽时极简模式（Ghost 模式）
  const styledEdges = useMemo(() => {
    const isDragging = isDraggingRef.current;
    if (isDragging) return []; // 拖拽时不渲染连线
    
    return edges.map((edge) => ({
      ...edge,
      type: "flow" as const,
      data: { ...edge.data, isDragging: false }
    }));
  }, [edges, activeDagId]);

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

  // 6. Dagre 布局：增加全量依赖及尺寸触发器
  useEffect(() => {
    if (isDraggingRef.current || !activeDagId || nodes.length === 0) return;

    // 关键修复：使用最新的 activeDag.nodes 作为布局输入，避免闭包陷阱中使用了旧的 localNodes
    const layoutInputNodes = nodes.map(n => {
      const ln = localNodesRef.current.find(l => l.id === n.id);
      const cached = dimensionsCacheRef.current[n.id];
      return {
        ...n,
        width: ln?.width ?? cached?.w ?? 240,
        height: ln?.height ?? cached?.h ?? 72
      };
    });

    layoutCancelRef.current = false;
    const timer = window.setTimeout(() => {
      void applyDagreLayoutAsync(layoutInputNodes as Node[], edges as Edge[], "TB", new Set(lockedNodeIds)).then(
        (result) => {
          if (!layoutCancelRef.current) {
            handleLayoutReady(result);
          }
        }
      );
    }, 100);
    return () => {
      window.clearTimeout(timer);
      layoutCancelRef.current = true;
    };
  }, [nodes.length, edges.length, activeDagId, handleLayoutReady, lockedNodeIds.length, layoutTriggerStamp]);

  useEffect(() => {
    if (!pendingApprovalNodeId) return;
    userInteractedRef.current = false;
    selectNode(pendingApprovalNodeId);
    const timer = window.setTimeout(() => {
      const gateNode = localNodes.find((n) => n.id === pendingApprovalNodeId);
      if (gateNode?.position) {
        fitView({ padding: 0.4, duration: 600, maxZoom: 1 });
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [pendingApprovalNodeId, activeDagId, fitView, selectNode, localNodes]);

  const onNodesChange = (changes: NodeChange[]) => {
    let needsRelayout = false;

    setLocalNodes((nds) => {
      const nextNodes = applyNodeChanges(changes, nds);
      
      // 拦截尺寸变化，检测高度是否发生显著改变以触发重排
      changes.forEach(change => {
        if (change.type === 'dimensions' && change.dimensions) {
          const { width, height } = change.dimensions;
          const cached = dimensionsCacheRef.current[change.id];
          
          if (!cached || Math.abs(cached.h - height) > 20 || Math.abs(cached.w - width) > 20) {
            dimensionsCacheRef.current[change.id] = { w: width, h: height };
            needsRelayout = true;
          }
        }
      });

      return nextNodes;
    });

    if (needsRelayout && !isDraggingRef.current) {
      setLayoutTriggerStamp(Date.now());
    }
    
    // 用户手动操作，锁定自动视角
    if (activeDagId && changes.some(c => c.type === 'position' || c.type === 'select')) {
      if (sessionManager.current[activeDagId]) {
        sessionManager.current[activeDagId].userInteracted = true;
      }
    }

    if (changes.some((c) => c.type !== "position")) {
      applyActiveNodeChanges(changes);
    }
  };

  const handleDragStart = () => {
    isDraggingRef.current = true;
    if (activeDagId && sessionManager.current[activeDagId]) {
      sessionManager.current[activeDagId].userInteracted = true;
    }
    document.body.classList.add('is-dragging-node');
  };

  const handleDragStop = (_event: any, _node: any, currentNodes: Node[]) => {
    isDraggingRef.current = false;
    document.body.classList.remove('is-dragging-node');
    
    applyActiveNodeChanges(currentNodes.map(n => ({
      id: n.id,
      type: 'position',
      position: n.position
    })));
  };

  const onPaneClick = () => {
    selectNode(undefined);
  };

  const isCanvasEmpty = localNodes.length === 0 && !activeDagId;

  const inspectorContent = useMemo(() => {
    const selectedNode = localNodes.find(n => n.id === selectedNodeId);
    if (!selectedNode) {
      return (
        <div className="inspector-empty">
          <div className="inspector-empty-icon">🔍</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>点击 DAG 节点</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", opacity: 0.7 }}>查看输入 / 输出 / 指标</div>
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
    return <NodeDetailSection node={selectedNode} />;
  }, [selectedNodeId, localNodes]);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const tier = usePerformance();

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      <CosmicBackground />

      {isWeavingStarted && (
        <Header
          dagOrder={dagOrder}
          activeDagId={activeDagId}
          activeDagNodes={activeDag?.nodes ?? []}
          wsStatus={wsStatus}
          fitView={fitView}
        />
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden", background: "transparent" }}>
        {isWeavingStarted && (
          <LeftPanel
            dagOrder={dagOrder}
            dags={dags}
            activeDagId={activeDagId}
            setActiveDag={setActiveDag}
            isCollapsed={leftCollapsed}
            setCollapsed={setLeftCollapsed}
          />
        )}

        <main className="canvas-panel" style={{ flex: 1, position: "relative", overflow: "hidden", background: "transparent" }}>
          {!isWeavingStarted && (
            <Incarnation onSummon={(text) => {
              console.log("Summoning:", text);
              setIsWeavingStarted(true);
            }} />
          )}

          {isWeavingStarted && isCanvasEmpty && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 1, gap: 0 }}>
              <div style={{ fontSize: 188, opacity: 0.8, userSelect: "none", lineHeight: 1 }}>🌌</div>
              <div className="weave-galaxy-text" style={{ fontFamily: "var(--font-mono)", fontSize: 64, fontWeight: 800, letterSpacing: "0.25em", marginTop: 16, userSelect: "none" }}>WEAVE</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 24, color: "var(--text-secondary)", marginTop: 12, letterSpacing: "0.12em" }}>
                DAG 可视化引擎 · 等待执行<span className="cursor-blink">_</span>
              </div>
            </div>
          )}

          {isWeavingStarted && (
            <ReactFlow
              nodes={localNodes}
              edges={styledEdges}
              fitView
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStart={handleDragStart}
              onNodeDragStop={handleDragStop}
              onNodeClick={(_, node) => {
                selectNode(node.id);
              }}
              onPaneClick={onPaneClick}
              defaultEdgeOptions={{ type: "flow" }}
              style={{ background: 'transparent' }}
              className="css-grid-bg"
              onlyRenderVisibleElements={true}
            >
              {!isCanvasEmpty && (
                <>
                  <MiniMap 
                    style={{ background: "var(--bg-surface)", opacity: tier === 'low' ? 0.8 : 1 }} 
                    maskColor="rgba(8, 11, 20, 0.75)" 
                  />
                  <Controls />
                </>
              )}
            </ReactFlow>
          )}
        </main>

        {isWeavingStarted && (
          <RightPanel isCollapsed={rightCollapsed} setCollapsed={setRightCollapsed}>
            {inspectorContent}
          </RightPanel>
        )}
      </div>
    </div>
  );
}

function NodeDetailSection({ node }: { node: Node<GraphNodeData> }) {
  const { error, metrics, kind, status } = node.data;
  const hasMetrics = metrics && Object.keys(metrics).some((k) => metrics[k as keyof typeof metrics] !== undefined);
  const IconComp = KIND_ICON_MAP[kind ?? "tool"] ?? ToolIcon;
  const kindColor = KIND_COLOR_MAP[kind ?? "tool"] ?? "#5aadff";

  const inputPorts = node.data.inputPorts ?? [];
  const outputPorts = node.data.outputPorts ?? [];

  return (
    <div>
      {error && (
        <div className="inspector-group" style={{ borderLeft: "3px solid var(--status-fail)", paddingLeft: 10, background: "rgba(255, 96, 87, 0.05)", borderRadius: "0 6px 6px 0" }}>
          <div className="inspector-label" style={{ color: "var(--status-fail)" }}>⚠️ 错误</div>
          <div className="inspector-value" style={{ color: "var(--status-fail)", fontWeight: 600 }}>{error.name}: {error.message}</div>
          {error.stack && <InspectorTextBlock text={error.stack} />}
        </div>
      )}

      <div className="inspector-sticky-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: `${kindColor}18`, border: `1px solid ${kindColor}30`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <IconComp size={18} color={kindColor} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: kindColor, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 2 }}>{kind ?? "node"}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.data.title}</div>
          </div>
          <span className={`status-badge ${status}`} style={{ background: getStatusBadgeStyle(status).bg, color: getStatusBadgeStyle(status).color, border: `1px solid ${getStatusBadgeStyle(status).color}40`, flexShrink: 0 }}>
            {getStatusBadgeStyle(status).text}
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{node.id}</div>
      </div>

      {hasMetrics && (
        <div className="stat-cards">
          {metrics?.durationMs !== undefined && (
            <div className="stat-card">
              <div className="stat-card-value">{metrics.durationMs}<span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", WebkitTextFillColor: "var(--text-muted)", background: "none" }}>ms</span></div>
              <div className="stat-card-label">执行耗时</div>
            </div>
          )}
          {(metrics?.promptTokens !== undefined || metrics?.completionTokens !== undefined) && (
            <div className="stat-card">
              <div className="stat-card-value" style={{ fontSize: 16 }}>{metrics?.promptTokens ?? "?"}<span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-muted)", WebkitTextFillColor: "var(--text-muted)", background: "none" }}>+</span>{metrics?.completionTokens ?? "?"}</div>
              <div className="stat-card-label">输入 / 输出 Token</div>
            </div>
          )}
        </div>
      )}

      {(node.data.dependencies ?? []).length > 0 && (
        <div className="inspector-group">
          <div className="inspector-label">依赖节点</div>
          {(node.data.dependencies ?? []).map((depId) => (
            <div key={depId} className="inspector-code" style={{ marginBottom: 2, color: "var(--text-muted)" }}>{depId}</div>
          ))}
        </div>
      )}

      <PortSection title="🔢 输入" ports={inputPorts} />
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

export default function App() {
  const [isWeavingStarted, setIsWeavingStarted] = useState(false);

  return (
    <ReactFlowProvider>
      <GraphCanvas isWeavingStarted={isWeavingStarted} setIsWeavingStarted={setIsWeavingStarted} />
    </ReactFlowProvider>
  );
}
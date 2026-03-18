/*
 * 文件作用：语义化节点渲染组件 — 高级暗色工作室风格卡片，Emoji图标，玻璃态边框，状态光晕伪元素。
 */

import { memo } from "react";
import { Handle, Position } from "reactflow";
import type { GraphNodeData } from "../types/graph-events";
import { LlmIcon } from "../icons/LlmIcon";
import { ToolIcon } from "../icons/ToolIcon";
import { AttemptIcon } from "../icons/AttemptIcon";
import { EscalationIcon } from "../icons/EscalationIcon";
import { GateIcon } from "../icons/GateIcon";
import { FinalIcon } from "../icons/FinalIcon";
import { InputIcon } from "../icons/InputIcon";
import { SystemIcon } from "../icons/SystemIcon";
import { RepairIcon } from "../icons/RepairIcon";
import { ConditionIcon } from "../icons/ConditionIcon";

interface KindConfig {
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  color: string;
  label: string;
}

const KIND_MAP: Record<string, KindConfig> = {
  llm:        { Icon: LlmIcon,        color: "#b48aff", label: "llm" },
  tool:       { Icon: ToolIcon,       color: "#5aadff", label: "tool" },
  attempt:    { Icon: AttemptIcon,    color: "#5aadff", label: "attempt" },
  escalation: { Icon: EscalationIcon, color: "#ff6057", label: "escalation" },
  condition:  { Icon: ConditionIcon,  color: "#7ec8ff", label: "condition" },
  gate:       { Icon: GateIcon,       color: "#ffab5e", label: "gate" },
  repair:     { Icon: RepairIcon,     color: "#ff6057", label: "repair" },
  final:      { Icon: FinalIcon,      color: "#3dc653", label: "final" },
  system:     { Icon: SystemIcon,     color: "#6e7a90", label: "system" },
  input:      { Icon: InputIcon,      color: "#38d8f8", label: "input" },
};

const DEFAULT_KIND: KindConfig = { Icon: ToolIcon, color: "#5aadff", label: "node" };

interface StatusStyle {
  barColor: string;
  glowColor: string;
  glow: boolean;
  badgeText: string;
  badgeBg: string;
  badgeColor: string;
  badgePulse: boolean;
}

function getStatusStyle(status?: string, kindColor?: string): StatusStyle {
  switch (status) {
    case "running":
      return {
        barColor: "#f5a623", glowColor: "#f5a623", glow: true,
        badgeText: "RUNNING", badgeBg: "rgba(245,166,35,0.18)", badgeColor: "#f5a623", badgePulse: true,
      };
    case "retrying":
      return {
        barColor: "#e8872a", glowColor: "#e8872a", glow: true,
        badgeText: "RETRY", badgeBg: "rgba(232,135,42,0.18)", badgeColor: "#e8872a", badgePulse: true,
      };
    case "success":
      return {
        barColor: "#3dc653", glowColor: "#3dc653", glow: false,
        badgeText: "DONE", badgeBg: "rgba(61,198,83,0.15)", badgeColor: "#3dc653", badgePulse: false,
      };
    case "fail":
      return {
        barColor: "#ff6057", glowColor: "#ff6057", glow: false,
        badgeText: "FAIL", badgeBg: "rgba(255,96,87,0.18)", badgeColor: "#ff6057", badgePulse: false,
      };
    case "skipped":
      return {
        barColor: "#6e7a90", glowColor: "#6e7a90", glow: false,
        badgeText: "SKIP", badgeBg: "rgba(110,122,144,0.15)", badgeColor: "#6e7a90", badgePulse: false,
      };
    default: // pending
      return {
        barColor: kindColor ?? "#4a5468", glowColor: kindColor ?? "#4a5468", glow: false,
        badgeText: "WAIT", badgeBg: "rgba(48,54,61,0.4)", badgeColor: "#5a6b82", badgePulse: false,
      };
  }
}

function parseFooter(data: GraphNodeData): { ms?: string; tokens?: string } {
  if (data.metrics?.durationMs !== undefined) {
    const ms = `${data.metrics.durationMs}ms`;
    const tokens =
      data.metrics.promptTokens !== undefined
        ? `${data.metrics.promptTokens}+${data.metrics.completionTokens ?? 0}`
        : undefined;
    return { ms, tokens };
  }
  const subtitle = data.subtitle ?? "";
  if (!subtitle) return {};
  const parts = subtitle.split(/[·•|]/);
  const ms = parts.find((p) => p.includes("ms"))?.trim();
  const tokens = parts.find((p) => p.includes("token"))?.trim();
  return { ms, tokens };
}

interface SemanticNodeProps {
  data: GraphNodeData;
}

export const SemanticNode = memo(function SemanticNode({ data }: SemanticNodeProps) {
  const kind = data.kind ?? "tool";
  const status = data.status ?? "pending";
  const { Icon, color, label } = KIND_MAP[kind] ?? DEFAULT_KIND;
  const statusStyle = getStatusStyle(status, color);
  const isPendingApproval = data.pendingApproval === true;
  const footer = parseFooter(data);
  const hasFooter = Boolean(footer.ms || footer.tokens);

  const vertBarStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    borderRadius: "0 3px 3px 0",
    background: statusStyle.barColor,
    ...(status === "pending" ? { opacity: 0.4 } : {}),
    ...(statusStyle.glow ? {
      boxShadow: `0 0 10px 3px ${statusStyle.glowColor}55`,
      animation: "status-glow 1.6s ease-in-out infinite",
    } : {}),
  };

  const topBarStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    background: `linear-gradient(90deg, ${statusStyle.barColor}, ${statusStyle.barColor}60)`,
    ...(status === "pending" ? { opacity: 0.25 } : {}),
    ...(statusStyle.glow ? { animation: "status-glow 1.6s ease-in-out infinite" } : {}),
  };

  return (
    <div
      className={`node-status-${status} ${isPendingApproval ? "node-pending-approval" : ""}`}
      style={{ width: 248 }}
    >
      <Handle type="target" position={Position.Top} className="node-handle" />

      <div
        className="semantic-node-card"
        data-status={status}
        style={{
          position: "relative",
          width: 248,
          borderRadius: 16,
          background: "rgba(14, 18, 30, 0.96)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          /* 工业级 1px 玻璃边框 */
          border: "1px solid rgba(255, 255, 255, 0.08)",
          backgroundClip: "padding-box",
          /* 内高光 + 外阴影（用 filter 避免脏渗透）*/
          boxShadow: "inset 0 1px 1px rgba(255, 255, 255, 0.12)",
          filter: "drop-shadow(0 6px 20px rgba(0, 0, 0, 0.55))",
          overflow: "hidden",
          /* Safari WebKit 毛玻璃圆角 Bug 修复 */
          WebkitMaskImage: "-webkit-radial-gradient(white, black)",
        }}
      >
        {/* 顶部渐变颜色条 */}
        <div style={topBarStyle} />

        {/* 左侧竖线 */}
        <div style={vertBarStyle} />

        {/* TypeBar：emoji 图标 + 类型小字 */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "10px 12px 3px 16px" }}>
          <Icon size={13} color={color} />
          <span
            style={{
              fontSize: 10,
              color: color,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase" as const,
              opacity: 0.9,
            }}
          >
            {label}
          </span>
        </div>

        {/* TitleRow：主标题 + StatusBadge */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 12px 5px 16px" }}>
          <span
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: 600,
              color: "rgba(221, 230, 240, 0.92)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {data.title}
          </span>
          <span
            className={`status-badge ${statusStyle.badgePulse ? status : ""}`}
            style={{
              background: statusStyle.badgeBg,
              color: statusStyle.badgeColor,
              border: `1px solid ${statusStyle.badgeColor}40`,
            }}
          >
            {statusStyle.badgeText}
          </span>
        </div>

        {/* 审批副标题 */}
        {isPendingApproval && (
          <div
            style={{
              fontSize: 11,
              color: "#ffab5e",
              padding: "2px 12px 4px 16px",
              fontFamily: "var(--font-mono)",
              opacity: 0.9,
              background: "rgba(255, 171, 94, 0.07)",
            }}
          >
            🔐 等待放行 · {data.approvalPayload?.toolName ?? "工具调用"}
          </div>
        )}

        {/* FooterBar：耗时 + tokens */}
        {hasFooter ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 12px 9px 16px",
              fontSize: 10,
              color: "#5a6b82",
              fontFamily: "var(--font-mono)",
              borderTop: "1px solid rgba(58, 68, 92, 0.4)",
              marginTop: 2,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {footer.ms && <span>⏱ {footer.ms}</span>}
            {footer.tokens && <span>· {footer.tokens} tok</span>}
          </div>
        ) : (
          <div style={{ height: isPendingApproval ? 4 : 8 }} />
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  );
});

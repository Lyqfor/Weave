/*
 * 文件作用：语义化节点渲染组件 — 深空控制台风格卡片，SVG图标，状态竖线+顶部颜色条。
 */

import { memo } from "react";
import { Handle, Position } from "reactflow";
import type { GraphNodeData } from "../types/graph-events";
import { LlmIcon } from "../icons/LlmIcon";
import { ToolIcon } from "../icons/ToolIcon";
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
  llm:        { Icon: LlmIcon,       color: "#bc8cff", label: "llm" },
  tool:       { Icon: ToolIcon,      color: "#58a6ff", label: "tool" },
  attempt:    { Icon: ToolIcon,      color: "#58a6ff", label: "attempt" },
  escalation: { Icon: ToolIcon,      color: "#58a6ff", label: "escalation" },
  condition:  { Icon: ConditionIcon, color: "#79c0ff", label: "condition" },
  gate:       { Icon: GateIcon,      color: "#ffa657", label: "gate" },
  repair:     { Icon: RepairIcon,    color: "#f85149", label: "repair" },
  final:      { Icon: FinalIcon,     color: "#3fb950", label: "final" },
  system:     { Icon: SystemIcon,    color: "#6e7681", label: "system" },
  input:      { Icon: InputIcon,     color: "#39d3f5", label: "input" },
};

const DEFAULT_KIND: KindConfig = { Icon: ToolIcon, color: "#58a6ff", label: "node" };

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
        barColor: "#f0a500", glowColor: "#f0a500", glow: true,
        badgeText: "RUNNING", badgeBg: "rgba(240,165,0,0.18)", badgeColor: "#f0a500", badgePulse: true,
      };
    case "retrying":
      return {
        barColor: "#e8852a", glowColor: "#e8852a", glow: true,
        badgeText: "RETRY", badgeBg: "rgba(232,133,42,0.18)", badgeColor: "#e8852a", badgePulse: true,
      };
    case "success":
      return {
        barColor: "#3fb950", glowColor: "#3fb950", glow: false,
        badgeText: "DONE", badgeBg: "rgba(63,185,80,0.15)", badgeColor: "#3fb950", badgePulse: false,
      };
    case "fail":
      return {
        barColor: "#f85149", glowColor: "#f85149", glow: false,
        badgeText: "FAIL", badgeBg: "rgba(248,81,73,0.18)", badgeColor: "#f85149", badgePulse: false,
      };
    case "skipped":
      return {
        barColor: "#6e7681", glowColor: "#6e7681", glow: false,
        badgeText: "SKIP", badgeBg: "rgba(110,118,129,0.15)", badgeColor: "#6e7681", badgePulse: false,
      };
    default: // pending
      return {
        barColor: kindColor ?? "#484f58", glowColor: kindColor ?? "#484f58", glow: false,
        badgeText: "WAIT", badgeBg: "rgba(48,54,61,0.4)", badgeColor: "#6e7681", badgePulse: false,
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

  const vertBarStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    borderRadius: "0 1.5px 1.5px 0",
    background: statusStyle.barColor,
    ...(status === "pending" ? { opacity: 0.45 } : {}),
    ...(statusStyle.glow ? {
      boxShadow: `0 0 8px 3px ${statusStyle.glowColor}60`,
      animation: "status-glow 1.6s ease-in-out infinite",
    } : {}),
  };

  const topBarStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    background: statusStyle.barColor,
    ...(status === "pending" ? { opacity: 0.3 } : {}),
    ...(statusStyle.glow ? { animation: "status-glow 1.6s ease-in-out infinite" } : {}),
  };

  return (
    <div
      className={`node-status-${status} ${isPendingApproval ? "node-pending-approval" : ""}`}
      style={{ width: 240 }}
    >
      <Handle type="target" position={Position.Top} className="node-handle" />

      <div
        className="semantic-node-card"
        style={{
          position: "relative",
          width: 240,
          borderRadius: 10,
          background: "rgba(13,17,23,0.95)",
          backdropFilter: "blur(12px)",
          border: `1px solid rgba(48,54,61,0.7)`,
          boxShadow: "0 8px 24px rgba(0,0,0,0.65)",
          overflow: "hidden",
        }}
      >
        {/* 顶部颜色条 */}
        <div style={topBarStyle} />

        {/* 左侧竖线 */}
        <div style={vertBarStyle} />

        {/* TypeBar：图标 + 类型小字 */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "9px 10px 3px 14px" }}>
          <Icon size={12} color={color} />
          <span
            style={{
              fontSize: 10,
              color: color,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase" as const,
              opacity: 0.85,
            }}
          >
            {label}
          </span>
        </div>

        {/* TitleRow：主标题 + StatusBadge */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 10px 4px 14px" }}>
          <span
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: 700,
              color: "#e6edf3",
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
              fontSize: 10,
              color: "#ffa657",
              padding: "0 10px 3px 14px",
              fontFamily: "'JetBrains Mono', monospace",
              opacity: 0.9,
            }}
          >
            ⏸ 等待放行 · {data.approvalPayload?.toolName ?? "工具调用"}
          </div>
        )}

        {/* FooterBar：耗时 + tokens */}
        {(footer.ms || footer.tokens) ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "2px 10px 8px 14px",
              fontSize: 10,
              color: "#6e7681",
              fontFamily: "'JetBrains Mono', monospace",
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

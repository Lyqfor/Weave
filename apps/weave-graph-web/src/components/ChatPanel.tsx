/*
 * 文件作用：聊天面板，展示每轮对话及状态徽章 — 高级暗色工作室风格，Emoji 状态图标，玻璃态气泡。
 */

import { useEffect, useRef } from "react";
import type { DagGraph } from "../store/graph-store";

interface ChatPanelProps {
  dagOrder: string[];
  dags: Record<string, DagGraph>;
  activeDagId: string;
  onSelectDag: (dagId: string) => void;
}

export function ChatPanel({ dagOrder, dags, activeDagId, onSelectDag }: ChatPanelProps) {
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dagOrder.length]);

  const orderedDags = [...dagOrder].reverse();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* 对话列表 */}
      <div
        ref={threadRef}
        className="custom-scroll inspector-panel"
        style={{ flex: 1, overflowY: "auto", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 4 }}
      >
        {orderedDags.length === 0 && (
          <div
            className="slide-in-up"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "48px 12px",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 32, opacity: 0.6 }}>🌱</span>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.7 }}>
              在 CLI 输入问题后，<br />对话将出现在这里
            </div>
          </div>
        )}

        {orderedDags.map((dagId) => {
          const dag = dags[dagId];
          if (!dag) return null;

          const isActive = dagId === activeDagId;
          const userText = dag.userInputSummary?.trim() || dagId;
          const hasRunning = dag.nodes.some((n) => n.data.status === "running" || n.data.status === "retrying");
          const hasFail    = dag.nodes.some((n) => n.data.status === "fail");
          const hasSuccess = dag.nodes.some((n) => n.data.status === "success");
          const successCount = dag.nodes.filter((n) => n.data.status === "success").length;
          const totalCount = dag.nodes.length;

          return (
            <div
              key={dagId}
              role="button"
              tabIndex={0}
              onClick={() => onSelectDag(dagId)}
              onKeyDown={(e) => e.key === "Enter" && onSelectDag(dagId)}
              style={{
                position: "relative",
                borderRadius: 12,
                padding: "8px 10px 8px 14px",
                border: "1px solid transparent",
                cursor: "pointer",
                transition: "background var(--duration-fast) var(--ease-out-quart), border-color var(--duration-fast) var(--ease-out-quart)",
                background: isActive ? "rgba(90,173,255,0.06)" : undefined,
                borderColor: isActive ? "rgba(90,173,255,0.2)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.025)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = "";
              }}
            >
              {/* 活跃指示线 — 渐变 */}
              {isActive && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 8,
                    bottom: 8,
                    width: 3,
                    borderRadius: "0 3px 3px 0",
                    background: "linear-gradient(180deg, #5aadff, #b48aff)",
                  }}
                />
              )}

              {/* 用户气泡 */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, marginBottom: 7 }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 9,
                  color: "var(--text-muted)",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}>
                  <span style={{ fontSize: 10 }}>👤</span>
                  <span>YOU</span>
                </div>
                <div
                  className="text-fade-out"
                  style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    background: "linear-gradient(135deg, rgba(90,173,255,0.12), rgba(180,138,255,0.08))",
                    border: "1px solid rgba(90,173,255,0.18)",
                    borderRadius: "12px 12px 4px 12px",
                    padding: "6px 12px",
                    color: "var(--text-primary)",
                    maxWidth: "95%",
                    wordBreak: "break-word",
                    textAlign: "right",
                    backgroundClip: "padding-box",
                  }}
                >
                  {userText}
                </div>
              </div>

              {/* Agent 状态行 */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {hasRunning && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10,
                    color: "#f5a623",
                    animation: "blink 1.4s ease-in-out infinite",
                    fontFamily: "var(--font-ui)",
                  }}>
                    <span className="emoji-icon" style={{ fontSize: 11 }}>🤔</span>
                    <span>思考中...</span>
                  </div>
                )}
                {!hasRunning && hasSuccess && !hasFail && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10,
                    color: "#3dc653",
                    fontFamily: "var(--font-ui)",
                  }}>
                    <span className="emoji-icon" style={{ fontSize: 11 }}>✅</span>
                    <span>完成</span>
                  </div>
                )}
                {!hasRunning && hasFail && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10,
                    color: "#ffab5e",
                    fontFamily: "var(--font-ui)",
                  }}>
                    <span className="emoji-icon" style={{ fontSize: 11 }}>⚠️</span>
                    <span>拦截挂起</span>
                  </div>
                )}
                {!hasRunning && !hasSuccess && !hasFail && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-ui)",
                  }}>
                    <span className="emoji-icon" style={{ fontSize: 11 }}>⏳</span>
                    <span>等待中</span>
                  </div>
                )}

                {/* 节点计数徽章 */}
                {totalCount > 0 && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 9,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-muted)",
                      background: "rgba(48,54,61,0.5)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 4,
                      padding: "1px 5px",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {successCount}/{totalCount}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 输入栏（只读占位） */}
      <div
        style={{
          padding: "8px 10px",
          borderTop: "1px solid var(--border-dim)",
          display: "flex",
          gap: 6,
          alignItems: "flex-end",
          background: "var(--bg-surface)",
        }}
      >
        <textarea
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--border-dim)",
            borderRadius: 8,
            color: "var(--text-muted)",
            fontSize: 11,
            padding: "6px 10px",
            resize: "none",
            fontFamily: "var(--font-ui)",
            cursor: "not-allowed",
            lineHeight: 1.5,
          }}
          placeholder="后端集成中..."
          disabled
          rows={2}
        />
        <button
          style={{
            background: "rgba(90,173,255,0.08)",
            border: "1px solid rgba(90,173,255,0.12)",
            color: "var(--text-muted)",
            borderRadius: 8,
            padding: "6px 12px",
            fontSize: 11,
            cursor: "not-allowed",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-ui)",
          }}
          disabled
        >
          发送
        </button>
      </div>
    </div>
  );
}

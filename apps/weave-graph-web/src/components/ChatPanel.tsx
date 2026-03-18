/*
 * 文件作用：聊天面板，展示每轮对话及状态徽章（深空控制台风格）。
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
        className="custom-scroll"
        style={{ flex: 1, overflowY: "auto", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 4 }}
      >
        {orderedDags.length === 0 && (
          <div style={{ fontSize: 11, color: "#484f58", textAlign: "center", padding: "32px 12px", lineHeight: 1.6 }}>
            在 CLI 输入问题后，<br />对话将出现在这里...
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
                borderRadius: 8,
                padding: "8px 10px 8px 14px",
                border: "1px solid transparent",
                cursor: "pointer",
                transition: "background 0.15s, border-color 0.15s",
                background: isActive ? "rgba(88,166,255,0.06)" : undefined,
                borderColor: isActive ? "rgba(88,166,255,0.25)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = "";
              }}
            >
              {/* 活跃指示线 */}
              {isActive && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 6,
                    bottom: 6,
                    width: 2,
                    borderRadius: "0 2px 2px 0",
                    background: "#58a6ff",
                  }}
                />
              )}

              {/* 用户气泡 */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, marginBottom: 7 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#484f58", fontWeight: 700, letterSpacing: "0.06em" }}>
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="5" r="3.5" stroke="#484f58" strokeWidth="1.5" />
                    <path d="M2 14C2 11.2 4.7 9 8 9C11.3 9 14 11.2 14 14" stroke="#484f58" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <span>YOU</span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.45,
                    background: "rgba(88,166,255,0.1)",
                    border: "1px solid rgba(88,166,255,0.2)",
                    borderRadius: "8px 8px 2px 8px",
                    padding: "5px 10px",
                    color: "#c9d1d9",
                    maxWidth: "95%",
                    wordBreak: "break-word",
                    textAlign: "right",
                  }}
                >
                  {userText}
                </div>
              </div>

              {/* Agent 状态行 */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {hasRunning && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#f0a500", animation: "blink 1.4s ease-in-out infinite" }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="#f0a500" strokeWidth="1.5" />
                      <path d="M8 4V8L10.5 10.5" stroke="#f0a500" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    <span>思考中...</span>
                  </div>
                )}
                {!hasRunning && hasSuccess && !hasFail && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#3fb950" }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="#3fb950" strokeWidth="1.5" />
                      <path d="M5 8L7.2 10.5L11 5.5" stroke="#3fb950" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>完成</span>
                  </div>
                )}
                {!hasRunning && hasFail && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#ffa657" }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <path d="M8 2L14.5 13H1.5L8 2Z" stroke="#ffa657" strokeWidth="1.5" strokeLinejoin="round" />
                      <line x1="8" y1="7" x2="8" y2="10" stroke="#ffa657" strokeWidth="1.5" strokeLinecap="round" />
                      <circle cx="8" cy="12" r="0.8" fill="#ffa657" />
                    </svg>
                    <span>拦截挂起</span>
                  </div>
                )}
                {!hasRunning && !hasSuccess && !hasFail && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#484f58" }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="#484f58" strokeWidth="1.5" />
                      <line x1="8" y1="5" x2="8" y2="8" stroke="#484f58" strokeWidth="1.5" strokeLinecap="round" />
                      <circle cx="8" cy="11" r="0.8" fill="#484f58" />
                    </svg>
                    <span>等待中</span>
                  </div>
                )}

                {/* 节点计数徽章 */}
                {totalCount > 0 && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 9,
                      fontFamily: "'JetBrains Mono', monospace",
                      color: "#6e7681",
                      background: "rgba(48,54,61,0.5)",
                      border: "1px solid rgba(48,54,61,0.8)",
                      borderRadius: 4,
                      padding: "1px 5px",
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
            borderRadius: 6,
            color: "#484f58",
            fontSize: 11,
            padding: "6px 10px",
            resize: "none",
            fontFamily: "inherit",
            cursor: "not-allowed",
            lineHeight: 1.45,
          }}
          placeholder="后端集成中..."
          disabled
          rows={2}
        />
        <button
          style={{
            background: "rgba(88,166,255,0.1)",
            border: "1px solid rgba(88,166,255,0.15)",
            color: "#484f58",
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 11,
            cursor: "not-allowed",
            whiteSpace: "nowrap",
          }}
          disabled
        >
          发送
        </button>
      </div>
    </div>
  );
}

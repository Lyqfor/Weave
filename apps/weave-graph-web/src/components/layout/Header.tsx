import React from 'react';
import { WeaveIcon } from '../WeaveIcon';
import { useTheme } from '../../hooks/useTheme';

export const Header: React.FC<{
  dagOrder: string[];
  activeDagId: string | undefined;
  activeDagNodes: any[];
  wsStatus: string;
  fitView: any;
}> = ({ dagOrder, activeDagId, activeDagNodes, wsStatus, fitView }) => {
  const { theme, toggleTheme } = useTheme();

  const successCount = activeDagNodes.filter((n) => n.data.status === "success").length;
  const totalCount = activeDagNodes.length;
  const progressPct = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;
  const isComplete = totalCount > 0 && successCount === totalCount;

  const wsStatusDot = wsStatus === "connected" ? "ws-dot-connected" : wsStatus === "connecting" ? "ws-dot-connecting" : "ws-dot-disconnected";
  const wsStatusLabel = wsStatus === "connected" ? "已连接" : wsStatus === "connecting" ? "连接中" : "已断开";

  return (
    <header
      style={{
        gridColumn: "1 / -1",
        gridRow: 1,
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        padding: "0 18px",
        background: "rgba(15, 15, 20, 0.4)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <WeaveIcon size={24} />
        <span className="weave-galaxy-text" style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.25em" }}>WEAVE</span>
        <span style={{ fontSize: 9, color: "var(--color-llm)", background: "rgba(180, 138, 255, 0.1)", border: "1px solid rgba(180, 138, 255, 0.2)", borderRadius: 12, padding: "1px 7px", letterSpacing: "0.04em" }}>v0.2</span>
        {dagOrder.length > 0 && (
          <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--color-tool)", background: "rgba(90,173,255,0.1)", border: "1px solid rgba(90,173,255,0.2)", padding: "2px 7px", borderRadius: 10 }}>
            {dagOrder.length} 轮
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, justifyContent: "center" }}>
        {activeDagId ? (
          <>
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              🔗 {activeDagId.slice(0, 16)}...
            </span>
            {totalCount > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 72, height: 3, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${progressPct}%`, background: isComplete ? "linear-gradient(90deg, #3dc653, #38d8f8)" : "linear-gradient(90deg, #5aadff, #b48aff)", borderRadius: 2, transition: "width 0.4s var(--ease-out-quart)" }} />
                </div>
                <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: isComplete ? "#3dc653" : "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                  {successCount}/{totalCount}
                </span>
              </div>
            )}
          </>
        ) : (
          <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em" }}>🌌 Weave Graph</span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
        <button
          onClick={() => fitView({ padding: 0.15, duration: 400 })}
          style={{ background: "rgba(90,173,255,0.08)", border: "1px solid var(--border-dim)", color: "var(--text-secondary)", borderRadius: 8, padding: "4px 12px", fontSize: 10, cursor: "pointer", fontFamily: "var(--font-ui)", letterSpacing: "0.04em", transition: "all var(--duration-fast) var(--ease-out-quart)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(90,173,255,0.16)"; e.currentTarget.style.boxShadow = "0 0 0 1px rgba(90,173,255,0.3)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(90,173,255,0.08)"; e.currentTarget.style.boxShadow = ""; e.currentTarget.style.transform = ""; }}
        >
          ⊞ 居中视图
        </button>
        <button 
          onClick={toggleTheme}
          style={{ 
            background: "var(--bg-raised)", border: "1px solid var(--border-dim)", borderRadius: "12px", padding: "2px 8px", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
          }}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: 10 }}>
          <span className={`ws-dot ${wsStatusDot}`} />
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{wsStatusLabel}</span>
        </div>
      </div>
    </header>
  );
};
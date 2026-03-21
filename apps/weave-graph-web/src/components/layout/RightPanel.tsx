import React from 'react';
import { Resizer } from './Resizer';

interface RightPanelProps {
  isCollapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  children: React.ReactNode;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  isCollapsed,
  setCollapsed,
  children
}) => {
  return (
    <div
      style={{
        position: "relative",
        gridRow: 2,
        overflow: "hidden",
        borderLeft: "1px solid rgba(255,255,255,0.05)",
        background: "rgba(15, 15, 20, 0.4)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        width: isCollapsed ? "36px" : "var(--panel-right-width, 26%)",
        transition: "var(--transition-layout)",
      }}
    >
      <button
        onClick={() => setCollapsed(!isCollapsed)}
        style={{
          position: "absolute",
          top: "50%",
          left: -10,
          transform: "translateY(-50%)",
          width: 20,
          height: 48,
          background: "var(--bg-raised)",
          border: "1px solid var(--border-muted)",
          borderRadius: 10,
          color: "var(--text-muted)",
          fontSize: 11,
          cursor: "pointer",
          zIndex: 60,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          backdropFilter: "blur(8px)",
          transition: "background var(--duration-fast), color var(--duration-fast)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-overlay)";
          e.currentTarget.style.color = "var(--text-secondary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--bg-raised)";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        {isCollapsed ? "‹" : "›"}
      </button>

      {!isCollapsed && (
        <>
          <Resizer side="right" defaultWidth={320} isCollapsed={isCollapsed} />
          <aside className="inspector-panel">
            <h3 className="panel-title">Inspector</h3>
            <div className="inspector-content">
              {children}
            </div>

            <div className="orchestrate-section">
              <div className="orchestrate-title">🔒 编排</div>
              <button className="orchestrate-btn" disabled>➕ 添加节点</button>
              <button className="orchestrate-btn" disabled>✏️ 编辑结构</button>
              <button className="orchestrate-btn" disabled>🔁 从此节点重跑</button>
              <p className="orchestrate-hint">🔒 即将推出</p>
            </div>
          </aside>
        </>
      )}

      {isCollapsed && (
        <span style={{
          writingMode: "vertical-rl",
          fontSize: 8,
          letterSpacing: "0.14em",
          color: "var(--text-muted)",
          marginTop: 48,
          fontWeight: 700,
          display: 'block',
          textAlign: 'center',
          width: '100%'
        }}>
          INFO
        </span>
      )}
    </div>
  );
};
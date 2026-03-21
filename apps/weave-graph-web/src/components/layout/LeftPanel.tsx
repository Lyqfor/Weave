import React from 'react';
import { ChatPanel } from '../ChatPanel';
import { Resizer } from './Resizer';

interface LeftPanelProps {
  dagOrder: string[];
  dags: any;
  activeDagId: string;
  setActiveDag: (id: string) => void;
  isCollapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

export const LeftPanel: React.FC<LeftPanelProps> = ({
  dagOrder,
  dags,
  activeDagId,
  setActiveDag,
  isCollapsed,
  setCollapsed
}) => {
  return (
    <div
      style={{
        position: "relative",
        gridRow: 2,
        overflow: "hidden",
        borderRight: "1px solid rgba(255,255,255,0.05)",
        background: "rgba(15, 15, 20, 0.4)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        width: isCollapsed ? "36px" : "var(--panel-left-width, 24%)",
        transition: "var(--transition-layout)",
      }}
    >
      <button
        onClick={() => setCollapsed(!isCollapsed)}
        style={{
          position: "absolute",
          top: "50%",
          right: -10,
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
        {isCollapsed ? "›" : "‹"}
      </button>

      {!isCollapsed && (
        <>
          <ChatPanel
            dagOrder={dagOrder}
            dags={dags}
            activeDagId={activeDagId}
            onSelectDag={setActiveDag}
          />
          <Resizer side="left" defaultWidth={300} isCollapsed={isCollapsed} />
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
          CHAT
        </span>
      )}
    </div>
  );
};
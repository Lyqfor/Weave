/*
 * 文件作用：Step Gate 审批面板 — 深空控制台风格，顶部警示条，主/危险按钮分组。
 */

import { useState } from "react";

interface ApprovalPanelProps {
  toolName: string;
  toolParams: string;
  gateId: string;
  onAction: (action: "approve" | "edit" | "skip" | "abort", params?: string) => void;
}

export function ApprovalPanel({ toolName, toolParams, onAction }: ApprovalPanelProps) {
  const [editedParams, setEditedParams] = useState(tryPrettyJson(toolParams));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [hasEdited, setHasEdited] = useState(false);

  const validateJson = (text: string): boolean => {
    try {
      JSON.parse(text);
      setJsonError(null);
      return true;
    } catch {
      setJsonError("JSON 格式有误，请检查后重试");
      return false;
    }
  };

  const onParamsChange = (text: string) => {
    setEditedParams(text);
    setHasEdited(true);
    validateJson(text);
  };

  return (
    <div className="approval-panel">
      {/* 顶部渐变警示条 */}
      <div className="approval-top-bar" />

      {/* Header */}
      <div className="approval-header">
        <span className="approval-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 1.5L13.5 4.5V11.5L8 14.5L2.5 11.5V4.5L8 1.5Z" stroke="#ffa657" strokeWidth="1.2" fill="rgba(255,166,87,0.12)" />
            <line x1="6.5" y1="5.5" x2="6.5" y2="10.5" stroke="#ffa657" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="9.5" y1="5.5" x2="9.5" y2="10.5" stroke="#ffa657" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="approval-title">Step Gate — 等待放行</span>
      </div>

      <div className="approval-body">
        <div className="inspector-group">
          <div className="inspector-label">工具名称</div>
          <div className="inspector-code" style={{ color: "#ffa657" }}>{toolName}</div>
        </div>

        <div className="inspector-group">
          <div className="inspector-label">调用参数（可编辑）</div>
          <textarea
            className="approval-params-editor"
            value={editedParams}
            onChange={(e) => onParamsChange(e.target.value)}
            spellCheck={false}
            rows={10}
          />
          {jsonError && <div className="approval-error">{jsonError}</div>}
        </div>
      </div>

      <div className="approval-actions">
        {/* 主操作组 */}
        <div className="approval-actions-primary">
          <button
            className="approval-btn approve"
            onClick={() => onAction("approve")}
            title="直接放行，使用原始参数"
          >
            ✓ 放行
          </button>
          <button
            className="approval-btn edit"
            onClick={() => { if (validateJson(editedParams)) onAction("edit", editedParams); }}
            disabled={Boolean(jsonError) || !hasEdited}
            title="使用编辑后的参数放行"
          >
            ✎ 编辑后放行
          </button>
        </div>

        <div className="approval-divider" />

        {/* 危险操作组 */}
        <div className="approval-actions-danger">
          <button
            className="approval-btn skip"
            onClick={() => onAction("skip")}
            title="跳过本次工具调用"
          >
            ⟫ 跳过
          </button>
          <button
            className="approval-btn abort"
            onClick={() => onAction("abort")}
            title="终止本轮执行"
          >
            ✕ 终止
          </button>
        </div>
      </div>

      <div className="approval-hint">
        提示：可在 CLI 按 Enter / E / S / Q 或在此面板操作
      </div>
    </div>
  );
}

function tryPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

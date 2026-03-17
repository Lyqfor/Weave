/*
 * 文件作用：Step Gate 审批面板，在 Inspector 中展示工具调用参数并提供放行/编辑/跳过/终止操作。
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

  const handleApprove = () => {
    onAction("approve");
  };

  const handleEditApprove = () => {
    if (!validateJson(editedParams)) return;
    onAction("edit", editedParams);
  };

  const handleSkip = () => {
    onAction("skip");
  };

  const handleAbort = () => {
    onAction("abort");
  };

  return (
    <div className="approval-panel">
      <div className="approval-header">
        <span className="approval-icon">⏸</span>
        <span className="approval-title">Step Gate — 等待放行</span>
      </div>

      <div className="inspector-group">
        <div className="inspector-label">工具名称</div>
        <div className="inspector-code">{toolName}</div>
      </div>

      <div className="inspector-group">
        <div className="inspector-label">调用参数（可编辑）</div>
        <textarea
          className="approval-params-editor"
          value={editedParams}
          onChange={(e) => onParamsChange(e.target.value)}
          spellCheck={false}
        />
        {jsonError && <div className="approval-error">{jsonError}</div>}
      </div>

      <div className="approval-actions">
        <button className="approval-btn approve" onClick={handleApprove} title="直接放行，使用原始参数">
          ✓ 放行
        </button>
        <button
          className="approval-btn edit"
          onClick={handleEditApprove}
          disabled={Boolean(jsonError) || !hasEdited}
          title="使用编辑后的参数放行"
        >
          ✎ 编辑后放行
        </button>
        <button className="approval-btn skip" onClick={handleSkip} title="跳过本次工具调用">
          ⟫ 跳过
        </button>
        <button className="approval-btn abort" onClick={handleAbort} title="终止本轮执行">
          ✕ 终止
        </button>
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

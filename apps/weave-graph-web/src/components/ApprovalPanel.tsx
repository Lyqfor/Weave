/*
 * 文件作用：Step Gate 审批面板 — 高级暗色工作室风格，Emoji 图标，玻璃态渐变背景，浮起按钮。
 */

import { useState } from "react";
import { useGraphStore } from "../store/graph-store";

interface ApprovalPanelProps {
  toolName: string;
  toolParams: string;
  gateId: string;
}

export function ApprovalPanel({ toolName, toolParams, gateId }: ApprovalPanelProps) {
  const sendRpc = useGraphStore((s) => s.sendRpc);
  const [editedParams, setEditedParams] = useState(tryPrettyJson(toolParams));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [hasEdited, setHasEdited] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const handleAction = async (action: "approve" | "edit" | "skip" | "abort", params?: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setJsonError(null);

    try {
      await sendRpc("gate.action", {
        gateId,
        action,
        params
      });
      // 成功后由后端广播流更新状态，前端会自动感知并关闭此面板
    } catch (err) {
      setJsonError(String(err));
    } finally {
      setIsSubmitting(false);
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
          <span className="emoji-icon" style={{ fontSize: 16 }}>🛡️</span>
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span className="approval-title">🔐 Step Gate · 等待放行</span>
          <span style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-ui)",
          }}>
            AI 即将执行以下工具调用，请确认后放行
          </span>
        </div>
      </div>

      <div className="approval-body">
        {/* 工具名称卡片 */}
        <div className="inspector-group">
          <div className="inspector-label">工具名称</div>
          <div style={{
            background: "rgba(255,171,94,0.1)",
            border: "1px solid rgba(255,171,94,0.25)",
            borderRadius: 8,
            padding: "6px 10px",
            color: "#ffab5e",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            fontWeight: 600,
            backgroundClip: "padding-box",
          }}>
            🛠️ {toolName}
          </div>
        </div>

        <div className="inspector-group">
          <div className="inspector-label">调用参数（可编辑）</div>
          <textarea
            className={`approval-params-editor ${jsonError ? "error" : ""}`}
            value={editedParams}
            onChange={(e) => onParamsChange(e.target.value)}
            spellCheck={false}
            rows={10}
            disabled={isSubmitting}
          />
          {jsonError && <div className="approval-error">⚠️ {jsonError}</div>}
        </div>
      </div>

      <div className="approval-actions">
        {/* 主操作组 */}
        <div className="approval-actions-primary">
          <button
            className="approval-btn approve"
            onClick={() => handleAction("approve")}
            disabled={isSubmitting}
            title="直接放行，使用原始参数"
          >
            {isSubmitting ? "⏳ 处理中..." : "✅ 放行"}
          </button>
          <button
            className="approval-btn edit"
            onClick={() => { if (validateJson(editedParams)) handleAction("edit", editedParams); }}
            disabled={Boolean(jsonError) || !hasEdited || isSubmitting}
            title="使用编辑后的参数放行"
          >
            ✏️ 编辑后放行
          </button>
        </div>

        <div className="approval-divider" />

        {/* 危险操作组 */}
        <div className="approval-actions-danger">
          <button
            className="approval-btn skip"
            onClick={() => handleAction("skip")}
            disabled={isSubmitting}
            title="跳过本次工具调用"
          >
            ⏭ 跳过
          </button>
          <button
            className="approval-btn abort"
            onClick={() => handleAction("abort")}
            disabled={isSubmitting}
            title="终止本轮执行"
          >
            🛑 终止
          </button>
        </div>
      </div>

      <div className="approval-hint">
        💡 可在 CLI 按 Enter · E · S · Q 操作
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

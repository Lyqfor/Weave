/*
 * 文件作用：Inspector 文本块组件，支持折叠/展开、语法高亮、复制闪光反馈，按内容类型选择字体。
 */

import React, { useEffect, useState } from "react";

export function renderPortSummary(summary: string) {
  return <InspectorTextBlock text={summary} />;
}

export function InspectorTextBlock({ text }: { text: string }) {
  const normalizedText = (text ?? "").trim();
  const isLikelyJson =
    (normalizedText.startsWith("{") && normalizedText.endsWith("}")) ||
    (normalizedText.startsWith("[") && normalizedText.endsWith("]"));
  const shouldCollapse = normalizedText.length > 120 || normalizedText.includes("\n");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [flashGreen, setFlashGreen] = useState(false);
  const [SyntaxHighlighterComp, setSyntaxHighlighterComp] = useState<null | React.ComponentType<any>>(null);
  const [highlighterTheme, setHighlighterTheme] = useState<any>(null);

  // JSON 和代码使用等宽字体；自然语言文字用 UI 字体
  const contentFont = isLikelyJson ? "var(--font-mono)" : "var(--font-ui)";

  useEffect(() => {
    let cancelled = false;
    if (!expanded || SyntaxHighlighterComp) return;

    Promise.all([
      import("react-syntax-highlighter"),
      import("react-syntax-highlighter/dist/esm/styles/prism")
    ]).then(([syntaxModule, themeModule]) => {
      if (cancelled) return;
      setSyntaxHighlighterComp(() => syntaxModule.Prism);
      setHighlighterTheme(themeModule.oneDark);
    });

    return () => { cancelled = true; };
  }, [expanded, SyntaxHighlighterComp]);

  const onCopy = async () => {
    if (!normalizedText) return;
    try {
      await navigator.clipboard.writeText(normalizedText);
      setCopied(true);
      setFlashGreen(true);
      window.setTimeout(() => {
        setCopied(false);
        setFlashGreen(false);
      }, 1000);
    } catch {
      setCopied(false);
    }
  };

  if (!normalizedText) {
    return <div className="inspector-code">(empty)</div>;
  }

  if (!shouldCollapse) {
    return (
      <div
        className="inspector-code-toolbar-wrap"
        style={{
          transition: "background var(--duration-fast) var(--ease-out-quart)",
          background: flashGreen ? "rgba(61,198,83,0.06)" : undefined,
          borderRadius: 6,
        }}
      >
        <div className="inspector-code" style={{ fontFamily: contentFont }}>{normalizedText}</div>
        <div className="inspector-toolbar">
          <button className="inspector-btn" onClick={() => void onCopy()}>
            {copied ? "✅ 已复制" : "复制"}
          </button>
        </div>
      </div>
    );
  }

  const preview = normalizedText.length > 120 ? `${normalizedText.slice(0, 120)}...` : normalizedText;
  return (
    <div
      className="inspector-code-toolbar-wrap"
      style={{
        transition: "background var(--duration-fast) var(--ease-out-quart)",
        background: flashGreen ? "rgba(61,198,83,0.06)" : undefined,
        borderRadius: 6,
      }}
    >
      <div className="inspector-toolbar">
        <button className={`inspector-btn ${!expanded ? "active" : ""}`} onClick={() => setExpanded(false)}>
          摘要
        </button>
        <button className={`inspector-btn ${expanded ? "active" : ""}`} onClick={() => setExpanded(true)}>
          展开
        </button>
        <button className="inspector-btn" onClick={() => void onCopy()}>
          {copied ? "✅ 已复制" : "复制"}
        </button>
      </div>

      {!expanded ? (
        <div className="inspector-code" style={{ fontFamily: contentFont }}>{preview}</div>
      ) : SyntaxHighlighterComp && highlighterTheme ? (
        <div className="inspector-code-block">
          <SyntaxHighlighterComp
            language={isLikelyJson ? "json" : "bash"}
            style={highlighterTheme}
            customStyle={{ margin: 0, fontSize: 11, fontFamily: "var(--font-mono)" }}
          >
            {normalizedText}
          </SyntaxHighlighterComp>
        </div>
      ) : (
        <div className="inspector-code">正在加载高亮...</div>
      )}
    </div>
  );
}

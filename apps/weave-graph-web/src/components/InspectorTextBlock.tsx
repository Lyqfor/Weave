/*
 * 文件作用：Inspector 文本块组件，支持折叠/展开、语法高亮和复制功能。
 * 从 App.tsx 提取，功能不变。
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
  const [SyntaxHighlighterComp, setSyntaxHighlighterComp] = useState<null | React.ComponentType<any>>(null);
  const [highlighterTheme, setHighlighterTheme] = useState<any>(null);

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
      window.setTimeout(() => setCopied(false), 1000);
    } catch {
      setCopied(false);
    }
  };

  if (!normalizedText) {
    return <div className="inspector-code">(empty)</div>;
  }

  if (!shouldCollapse) {
    return (
      <div className="inspector-code-toolbar-wrap">
        <div className="inspector-code">{normalizedText}</div>
        <div className="inspector-toolbar">
          <button className="inspector-btn" onClick={() => void onCopy()}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
    );
  }

  const preview = normalizedText.length > 120 ? `${normalizedText.slice(0, 120)}...` : normalizedText;
  return (
    <div className="inspector-code-toolbar-wrap">
      <div className="inspector-toolbar">
        <button className={`inspector-btn ${!expanded ? "active" : ""}`} onClick={() => setExpanded(false)}>
          摘要
        </button>
        <button className={`inspector-btn ${expanded ? "active" : ""}`} onClick={() => setExpanded(true)}>
          展开
        </button>
        <button className="inspector-btn" onClick={() => void onCopy()}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>

      {!expanded ? (
        <div className="inspector-code">{preview}</div>
      ) : SyntaxHighlighterComp && highlighterTheme ? (
        <div className="inspector-code-block">
          <SyntaxHighlighterComp
            language={isLikelyJson ? "json" : "bash"}
            style={highlighterTheme}
            customStyle={{ margin: 0, fontSize: 11 }}
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

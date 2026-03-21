import React, { useState } from "react";

export function Incarnation({ onSummon }: { onSummon: (text: string) => void }) {
  const [inputValue, setInputValue] = useState("");

  const handleSummon = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim()) return;
    
    // 失去焦点，配合后续 Phase 3 过场动画
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    onSummon(inputValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSummon();
    }
  };

  return (
    <div className="incarnation-container">
      <div className="incarnation-logo">🌌</div>
      <div className="incarnation-title">WEAVE</div>
      <div className="incarnation-slogan">编织智能体思维，可视化无限可能</div>
      
      <div className="magic-input-wrapper">
        <div className="magic-input-inner">
          <input 
            type="text" 
            className="magic-input" 
            placeholder="给 Weave 输入一个指令，或者描述你想让 Agent 干什么..." 
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="magic-send-btn" onClick={handleSummon} disabled={!inputValue.trim()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

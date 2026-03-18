/* 文件作用：LLM 节点图标 — 脑（🧠），符合大语言模型语义 */
interface IconProps { size?: number; color?: string; }
export function LlmIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>🧠</span>
  );
}

/* 文件作用：LLM 节点图标 — 神经网络三圆点连线（紫色）*/
interface IconProps { size?: number; color?: string; }
export function LlmIcon({ size = 14, color = "#bc8cff" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="3" cy="8" r="2" fill={color} opacity="0.9" />
      <circle cx="13" cy="4" r="2" fill={color} opacity="0.9" />
      <circle cx="13" cy="12" r="2" fill={color} opacity="0.9" />
      <line x1="5" y1="7.3" x2="11" y2="4.7" stroke={color} strokeWidth="1.2" opacity="0.6" />
      <line x1="5" y1="8.7" x2="11" y2="11.3" stroke={color} strokeWidth="1.2" opacity="0.6" />
    </svg>
  );
}

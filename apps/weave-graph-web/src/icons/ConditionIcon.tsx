/* 文件作用：Condition 节点图标 — 菱形分支（蓝紫色）*/
interface IconProps { size?: number; color?: string; }
export function ConditionIcon({ size = 14, color = "#79c0ff" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.5L14.5 8L8 14.5L1.5 8L8 1.5Z" stroke={color} strokeWidth="1.2" fill={color} fillOpacity="0.12" />
      <line x1="8" y1="5" x2="8" y2="11" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="5" y1="8" x2="11" y2="8" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

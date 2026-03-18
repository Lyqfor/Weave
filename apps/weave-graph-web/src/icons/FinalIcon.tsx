/* 文件作用：Final 节点图标 — 圆形 + 勾选路径（绿色）*/
interface IconProps { size?: number; color?: string; }
export function FinalIcon({ size = 14, color = "#3fb950" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.3" fill={color} fillOpacity="0.12" />
      <path d="M5 8.2L7.2 10.5L11 5.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* 文件作用：System 节点图标 — 服务器方块（灰色）*/
interface IconProps { size?: number; color?: string; }
export function SystemIcon({ size = 14, color = "#6e7681" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="12" height="5" rx="1.5" stroke={color} strokeWidth="1.2" fill={color} fillOpacity="0.1" />
      <rect x="2" y="9" width="12" height="5" rx="1.5" stroke={color} strokeWidth="1.2" fill={color} fillOpacity="0.1" />
      <circle cx="12.5" cy="4.5" r="1" fill={color} />
      <circle cx="12.5" cy="11.5" r="1" fill={color} />
      <line x1="4" y1="4.5" x2="7" y2="4.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <line x1="4" y1="11.5" x2="7" y2="11.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

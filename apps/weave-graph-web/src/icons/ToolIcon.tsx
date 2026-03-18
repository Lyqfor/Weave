/* 文件作用：Tool 节点图标 — 终端 > 符号（蓝色）*/
interface IconProps { size?: number; color?: string; }
export function ToolIcon({ size = 14, color = "#58a6ff" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="14" height="12" rx="2" stroke={color} strokeWidth="1.2" opacity="0.7" />
      <path d="M4.5 6L7 8L4.5 10" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8.5" y1="10" x2="11.5" y2="10" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

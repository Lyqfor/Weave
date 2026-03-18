/* 文件作用：Input 节点图标 — 对话气泡 + 光标（青色）*/
interface IconProps { size?: number; color?: string; }
export function InputIcon({ size = 14, color = "#39d3f5" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 3C2 2.45 2.45 2 3 2H13C13.55 2 14 2.45 14 3V10C14 10.55 13.55 11 13 11H9L6 14V11H3C2.45 11 2 10.55 2 10V3Z" stroke={color} strokeWidth="1.2" fill={color} fillOpacity="0.1" />
      <line x1="5" y1="5.5" x2="8.5" y2="5.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="5" y1="7.8" x2="11" y2="7.8" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

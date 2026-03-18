/* 文件作用：Repair 节点图标 — 循环箭头（红色）*/
interface IconProps { size?: number; color?: string; }
export function RepairIcon({ size = 14, color = "#f85149" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 8A5 5 0 1 1 8 3" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 1L10 3.5L7.5 5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/* 文件作用：Gate 节点图标 — 六边形盾牌 + 暂停双竖线（橙色）*/
interface IconProps { size?: number; color?: string; }
export function GateIcon({ size = 14, color = "#ffa657" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.5L13.5 4.5V11.5L8 14.5L2.5 11.5V4.5L8 1.5Z" stroke={color} strokeWidth="1.2" fill={color} fillOpacity="0.12" />
      <line x1="6.5" y1="5.5" x2="6.5" y2="10.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <line x1="9.5" y1="5.5" x2="9.5" y2="10.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

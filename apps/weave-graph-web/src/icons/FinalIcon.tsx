/* 文件作用：Final 节点图标 — 完成（✅），代表执行链路终点 */
interface IconProps { size?: number; color?: string; }
export function FinalIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>✅</span>
  );
}

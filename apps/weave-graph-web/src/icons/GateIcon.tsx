/* 文件作用：Step Gate 节点图标 — 盾牌（🛡️），代表守卫/审批关卡 */
interface IconProps { size?: number; color?: string; }
export function GateIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>🛡️</span>
  );
}

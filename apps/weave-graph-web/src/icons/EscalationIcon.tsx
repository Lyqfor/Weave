/* 文件作用：Escalation 节点图标 — 警灯（🚨），代表控制流发生严重异常转移/熔断升级，必须刺眼 */
interface IconProps { size?: number; color?: string; }
export function EscalationIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>🚨</span>
  );
}

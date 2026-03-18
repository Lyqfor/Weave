/* 文件作用：Condition 节点图标 — 分支（🔀），代表条件判断节点 */
interface IconProps { size?: number; color?: string; }
export function ConditionIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>🔀</span>
  );
}

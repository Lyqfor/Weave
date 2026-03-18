/* 文件作用：常规工具节点图标 — 锤子与扳手（🛠️），代表正常工具执行（区别于 attempt 重试和 escalation 熔断） */
interface IconProps { size?: number; color?: string; }
export function ToolIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>🛠️</span>
  );
}

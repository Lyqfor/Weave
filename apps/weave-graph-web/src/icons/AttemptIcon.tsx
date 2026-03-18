/* 文件作用：Attempt 节点图标 — 循环（🔄），代表"不屈不挠的重试状态" */
interface IconProps { size?: number; color?: string; }
export function AttemptIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>🔄</span>
  );
}

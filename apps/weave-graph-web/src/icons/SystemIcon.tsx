/* 文件作用：System 节点图标 — 齿轮（⚙️），代表系统级节点 */
interface IconProps { size?: number; color?: string; }
export function SystemIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>⚙️</span>
  );
}

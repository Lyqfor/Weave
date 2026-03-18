/* 文件作用：Input 节点图标 — 对话气泡（💬），代表用户输入节点 */
interface IconProps { size?: number; color?: string; }
export function InputIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>💬</span>
  );
}

/* 文件作用：Repair 节点图标 — 创可贴（🩹），代表修复/恢复节点 */
interface IconProps { size?: number; color?: string; }
export function RepairIcon({ size = 14 }: IconProps) {
  return (
    <span className="emoji-icon" style={{ fontSize: size }}>🩹</span>
  );
}

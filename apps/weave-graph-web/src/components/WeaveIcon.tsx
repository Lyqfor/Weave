/*
 * 文件作用：WEAVE 品牌 SVG 图标，三节点"W"形态（紫→蓝→琥珀配色）。
 */

interface WeaveIconProps {
  size?: number;
}

export function WeaveIcon({ size = 32 }: WeaveIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <rect width="32" height="32" rx="7" fill="#0f0f10" />
      <defs>
        <linearGradient id="wi-grad-left" x1="6" y1="24" x2="16" y2="10" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id="wi-grad-right" x1="16" y1="10" x2="26" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
        <linearGradient id="wi-grad-mid" x1="10" y1="17" x2="22" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a855f7" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      {/* 左上臂 */}
      <path d="M 6 24 C 8 20, 12 14, 16 10" stroke="url(#wi-grad-left)" strokeWidth="1.6" strokeLinecap="round" />
      {/* 右上臂 */}
      <path d="M 16 10 C 20 14, 24 20, 26 24" stroke="url(#wi-grad-right)" strokeWidth="1.6" strokeLinecap="round" />
      {/* 中腰（W 谷） */}
      <path d="M 10 17 C 12 19, 14 18, 16 17 C 18 16, 20 15, 22 17" stroke="url(#wi-grad-mid)" strokeWidth="1.2" strokeLinecap="round" />
      {/* 紫色节点 LLM */}
      <circle cx="6" cy="24" r="2.8" fill="#a855f7" opacity="0.95" />
      {/* 蓝色节点 Tool */}
      <circle cx="16" cy="10" r="2.8" fill="#3b82f6" opacity="0.95" />
      {/* 琥珀节点 Gate */}
      <circle cx="26" cy="24" r="2.8" fill="#f59e0b" opacity="0.95" />
    </svg>
  );
}

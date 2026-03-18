/*
 * 文件作用：带彗星流光动画的流动边组件。
 * 双层渲染：静态发光轨道（带 filter）+ 纯净彗星动线（无 filter，GPU 友好）。
 * 3 锚点渐变（紫→蓝→蓝），消除 RGB 插值泥泞色。
 * shape-rendering: geometricPrecision 消除亚像素虚边。
 */

import { getBezierPath, type EdgeProps } from "reactflow";

export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  animated,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });

  const pathId = `flow-path-${id}`;
  const gradientId = `grad-${id}`;
  const arrowId = `arrow-${id}`;
  const strokeColor = (style?.stroke as string) ?? "rgba(90,173,255,0.6)";
  const strokeWidth = (style?.strokeWidth as number) ?? 1.5;

  // Edge label based on edgeKind
  const edgeKind = (data as { edgeKind?: string } | undefined)?.edgeKind;
  let edgeLabelText = "";
  let edgeLabelColor = "#8fa3bc";
  if (edgeKind === "retry") { edgeLabelText = "↩ RETRY"; edgeLabelColor = "#e8872a"; }
  else if (edgeKind === "condition_true") { edgeLabelText = "✓ TRUE"; edgeLabelColor = "#3dc653"; }
  else if (edgeKind === "condition_false") { edgeLabelText = "✗ FALSE"; edgeLabelColor = "#ff6057"; }

  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;

  // fail 边：虚线
  const isFail = (style?.strokeDasharray as string | undefined) !== undefined;

  return (
    <g style={{ shapeRendering: "geometricPrecision" } as React.CSSProperties}>
      <defs>
        {/* Per-edge arrow marker */}
        <marker
          id={arrowId}
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M0,0 L0,6 L8,3 z"
            fill={animated ? "#b48aff" : strokeColor}
            opacity={animated ? 0.85 : 0.6}
          />
        </marker>

        {animated && (
          <>
            {/* 3 锚点渐变：紫 → 蓝 → 天蓝，消除 RGB 泥潭色 */}
            <linearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={sourceX} y1={sourceY}
              x2={targetX} y2={targetY}
            >
              <stop offset="0%"   stopColor="#b48aff" stopOpacity="0.9" />
              <stop offset="50%"  stopColor="#3b82f6" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#5aadff" stopOpacity="0.9" />
            </linearGradient>

            {/* 底层：静态发光轨道（唯一携带 filter 的层，不参与动画）*/}
            <filter id={`track-glow-${id}`} x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </>
        )}
      </defs>

      {/* Hidden path for particle motion */}
      {animated && <path id={pathId} d={edgePath} fill="none" stroke="none" />}

      {/* 底层：静态轨道（running 时显示渐变 + 发光） */}
      {animated ? (
        <path
          d={edgePath}
          fill="none"
          strokeWidth={strokeWidth + 0.5}
          stroke={`url(#${gradientId})`}
          opacity={0.35}
          filter={`url(#track-glow-${id})`}
          markerEnd={`url(#${arrowId})`}
        />
      ) : (
        <path
          d={edgePath}
          style={style}
          fill="none"
          strokeWidth={strokeWidth}
          stroke={strokeColor}
          markerEnd={`url(#${arrowId})`}
          {...(isFail ? { strokeDasharray: style?.strokeDasharray as string } : {})}
        />
      )}

      {/* 顶层：纯净彗星动线（绝不加 filter，GPU 零负担）*/}
      {animated && (
        <path
          d={edgePath}
          fill="none"
          strokeWidth={strokeWidth + 0.5}
          stroke="#b48aff"
          strokeLinecap="round"
          strokeDasharray="12 88"
          style={{
            animation: `comet-flow 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite`,
          }}
        />
      )}

      {/* 第二彗星（相位偏移 0.75s，天蓝色）*/}
      {animated && (
        <path
          d={edgePath}
          fill="none"
          strokeWidth={strokeWidth - 0.2}
          stroke="#5aadff"
          strokeLinecap="round"
          strokeDasharray="8 92"
          style={{
            animation: `comet-flow 1.5s cubic-bezier(0.4, 0, 0.2, 1) -0.75s infinite`,
          }}
        />
      )}

      {/* Edge label */}
      {edgeLabelText && (
        <g>
          <rect
            x={midX - 28}
            y={midY - 9}
            width="56"
            height="16"
            rx="4"
            fill="rgba(11,14,22,0.95)"
            stroke={edgeLabelColor}
            strokeWidth="0.8"
            strokeOpacity="0.6"
          />
          <text
            x={midX}
            y={midY + 3}
            textAnchor="middle"
            fontSize="9"
            fontFamily="'JetBrains Mono', 'Cascadia Code', monospace"
            fontWeight="700"
            fill={edgeLabelColor}
            letterSpacing="0.04em"
          >
            {edgeLabelText}
          </text>
        </g>
      )}
    </g>
  );
}

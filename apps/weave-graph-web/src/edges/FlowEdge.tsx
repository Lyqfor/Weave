/*
 * 文件作用：带粒子动画的流动边组件。
 * 增强：方向箭头、渐变描边、双粒子流动、Edge label。
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
  const filterId = `glow-${id}`;
  const gradientId = `grad-${id}`;
  const arrowId = `arrow-${id}`;
  const strokeColor = (style?.stroke as string) ?? "rgba(88,166,255,0.9)";
  const strokeWidth = (style?.strokeWidth as number) ?? 1.8;

  // Edge label based on edgeKind
  const edgeKind = (data as { edgeKind?: string } | undefined)?.edgeKind;
  let edgeLabelText = "";
  let edgeLabelColor = "#8b949e";
  if (edgeKind === "retry") { edgeLabelText = "↩ RETRY"; edgeLabelColor = "#e8852a"; }
  else if (edgeKind === "condition_true") { edgeLabelText = "✓ TRUE"; edgeLabelColor = "#3fb950"; }
  else if (edgeKind === "condition_false") { edgeLabelText = "✗ FALSE"; edgeLabelColor = "#f85149"; }

  // Mid point for label
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;

  return (
    <g>
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
          <path d="M0,0 L0,6 L8,3 z" fill={animated ? "#f0a500" : strokeColor} opacity={animated ? 0.9 : 0.7} />
        </marker>

        {animated && (
          <>
            {/* Glow filter */}
            <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Running gradient: blue source → amber target */}
            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse"
              x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
              <stop offset="0%" stopColor="#58a6ff" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#f0a500" stopOpacity="0.9" />
            </linearGradient>

            {/* Particle glow filter */}
            <filter id={`pglow-${id}`} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="5" result="blur" />
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

      {/* Main edge path */}
      <path
        d={edgePath}
        style={animated ? {} : style}
        fill="none"
        strokeWidth={strokeWidth}
        stroke={animated ? `url(#${gradientId})` : strokeColor}
        markerEnd={`url(#${arrowId})`}
        filter={animated ? `url(#${filterId})` : undefined}
      />

      {/* Particle 1 */}
      {animated && (
        <circle r="4.5" fill="rgba(240,165,0,0.95)" filter={`url(#pglow-${id})`}>
          <animateMotion dur="1.4s" repeatCount="indefinite" rotate="auto">
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      )}

      {/* Particle 2 (offset) */}
      {animated && (
        <circle r="3" fill="rgba(88,166,255,0.8)" filter={`url(#pglow-${id})`}>
          <animateMotion dur="2.1s" begin="-0.7s" repeatCount="indefinite" rotate="auto">
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      )}

      {/* Edge label */}
      {edgeLabelText && (
        <g>
          <rect
            x={midX - 28}
            y={midY - 9}
            width="56"
            height="16"
            rx="3"
            fill="rgba(13,17,23,0.92)"
            stroke={edgeLabelColor}
            strokeWidth="0.8"
            strokeOpacity="0.5"
          />
          <text
            x={midX}
            y={midY + 3}
            textAnchor="middle"
            fontSize="9"
            fontFamily="'JetBrains Mono', 'Consolas', monospace"
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

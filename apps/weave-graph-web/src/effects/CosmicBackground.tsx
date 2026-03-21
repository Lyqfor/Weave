import React from 'react';
import { StarCanvas } from './StarCanvas';
import { usePerformance } from '../hooks/usePerformance';

export const CosmicBackground: React.FC = () => {
  const tier = usePerformance();
  const isLow = tier === 'low';

  const blurRadius = isLow ? '40px' : '80px';
  const nebulaOpacity = isLow ? 0.06 : 0.1;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        transition: 'opacity 0.4s ease',
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden',
        zIndex: 0,
        background: '#09090b',
      }}
      className="cosmic-bg"
    >
      {/* 🚀 Phase 1: 量子织锦层 (光纤流动与噪点，纯CSS硬件加速) */}
      <div
        className="quantum-tapestry"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.65,
          background: `
            linear-gradient(60deg, rgba(15, 20, 40, 0.5) 0%, rgba(45, 20, 70, 0.4) 50%, rgba(10, 20, 45, 0.5) 100%),
            url('data:image/svg+xml;utf8,%3Csvg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"%3E%3Cfilter id="noise"%3E%3CfeTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/%3E%3C/filter%3E%3Crect width="100%25" height="100%25" filter="url(%23noise)" opacity="0.15"/%3E%3C/svg%3E')
          `,
          backgroundSize: '200% 200%, 150px 150px',
          backgroundBlendMode: 'overlay',
          animation: 'quantum-flow 30s linear infinite',
          zIndex: 1,
        }}
      />

      {/* 恢复三团星云 (z-index: 2 覆盖在织锦上方) */}
      <div
        style={{
          position: 'absolute',
          width: 500, height: 500,
          background: `radial-gradient(circle, rgba(139, 92, 246, ${nebulaOpacity}), transparent 70%)`,
          top: -150, right: -100,
          borderRadius: '50%',
          filter: `blur(${blurRadius})`,
          animation: 'nebula-drift 25s ease-in-out infinite',
          willChange: 'transform',
          zIndex: 2,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 400, height: 400,
          background: `radial-gradient(circle, rgba(99, 102, 241, ${nebulaOpacity * 0.8}), transparent 70%)`,
          bottom: -100, left: -100,
          borderRadius: '50%',
          filter: `blur(${blurRadius})`,
          animation: 'nebula-drift 25s ease-in-out infinite',
          animationDelay: '-10s',
          willChange: 'transform',
          zIndex: 2,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 300, height: 300,
          background: `radial-gradient(circle, rgba(168, 85, 247, ${nebulaOpacity * 0.6}), transparent 70%)`,
          top: '50%', left: '40%',
          borderRadius: '50%',
          filter: `blur(${blurRadius})`,
          animation: 'nebula-drift 25s ease-in-out infinite',
          animationDelay: '-18s',
          willChange: 'transform',
          zIndex: 2,
        }}
      />
      
      {/* 宇宙网格 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px',
          opacity: isLow ? 0.5 : 1,
          zIndex: 2,
        }}
      />
      
      {/* 动态星空 (z-index: 3) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 3 }}>
        <StarCanvas tier={tier} />
      </div>
    </div>
  );
};

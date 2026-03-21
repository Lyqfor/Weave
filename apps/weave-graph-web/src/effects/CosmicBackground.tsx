import React from 'react';
import { StarCanvas } from './StarCanvas';
import { usePerformance } from '../hooks/usePerformance';

export const CosmicBackground: React.FC = () => {
  const tier = usePerformance();
  const isLow = tier === 'low';

  const blurRadius = isLow ? '40px' : '80px';
  // Reduced nebula opacity to make it subtle
  const nebulaOpacity = isLow ? 0.02 : 0.04;

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
        background: '#09090b', // Obsidian Black
      }}
      className="cosmic-bg"
    >
      {/* Quantum Tapestry */}
      <div
        className="quantum-tapestry"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.3, // Reduced opacity
          background: `
            linear-gradient(60deg, rgba(15, 20, 40, 0.2) 0%, rgba(30, 20, 50, 0.15) 50%, rgba(10, 20, 45, 0.2) 100%),
            url('data:image/svg+xml;utf8,%3Csvg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"%3E%3Cfilter id="noise"%3E%3CfeTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/%3E%3C/filter%3E%3Crect width="100%25" height="100%25" filter="url(%23noise)" opacity="0.15"/%3E%3C/svg%3E')
          `,
          backgroundSize: '200% 200%, 150px 150px',
          backgroundBlendMode: 'overlay',
          animation: 'quantum-flow 40s linear infinite', // Slower animation
          zIndex: 1,
        }}
      />

      {/* Constellation Layer (Big Dipper) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}>
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <path
            className="constellation-path"
            d="M 30% 70% L 40% 65% L 48% 68% L 55% 60% L 65% 58% L 70% 48% L 60% 45% Z"
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.5"
            strokeDasharray="2 4"
            style={{ filter: 'url(#noise)' }}
          />
          {/* Subtle star nodes for the Big Dipper */}
          <circle cx="30%" cy="70%" r="1" fill="rgba(255,255,255,0.3)" />
          <circle cx="40%" cy="65%" r="1" fill="rgba(255,255,255,0.3)" />
          <circle cx="48%" cy="68%" r="1" fill="rgba(255,255,255,0.3)" />
          <circle cx="55%" cy="60%" r="1" fill="rgba(255,255,255,0.3)" />
          <circle cx="65%" cy="58%" r="1" fill="rgba(255,255,255,0.3)" />
          <circle cx="70%" cy="48%" r="1" fill="rgba(255,255,255,0.3)" />
          <circle cx="60%" cy="45%" r="1" fill="rgba(255,255,255,0.3)" />
        </svg>
      </div>

      {/* Nebulas - much more subtle now */}
      <div
        style={{
          position: 'absolute',
          width: 500, height: 500,
          background: `radial-gradient(circle, rgba(139, 92, 246, ${nebulaOpacity}), transparent 70%)`,
          top: -150, right: -100,
          borderRadius: '50%',
          filter: `blur(${blurRadius})`,
          animation: 'nebula-drift 30s ease-in-out infinite',
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
          animation: 'nebula-drift 30s ease-in-out infinite',
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
          animation: 'nebula-drift 30s ease-in-out infinite',
          animationDelay: '-18s',
          willChange: 'transform',
          zIndex: 2,
        }}
      />
      
      {/* Grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
          opacity: isLow ? 0.3 : 0.6,
          zIndex: 2,
        }}
      />
      
      {/* Stars */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 3 }}>
        <StarCanvas tier={tier} />
      </div>
    </div>
  );
};

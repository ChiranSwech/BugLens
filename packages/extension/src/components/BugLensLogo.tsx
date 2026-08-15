import React from 'react';

interface BugLensLogoProps {
  size?: number | string;
  showText?: boolean;
  showSubtitle?: boolean;
  className?: string;
  monoColor?: string; // Custom CSS color or var(--text-primary)
  style?: React.CSSProperties;
}

export const BugLensLogo: React.FC<BugLensLogoProps> = ({
  size = 32,
  showText = true,
  showSubtitle = false,
  className = '',
  monoColor = 'var(--text-primary, #f1f0ff)',
  style = {},
}) => {
  const iconSize = typeof size === 'number' ? `${size}px` : size;

  return (
    <div
      className={`buglens-logo-container ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '10px',
        userSelect: 'none',
        ...style,
      }}
    >
      {/* SVG Icon */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0, transition: 'transform 0.2s ease' }}
      >
        <defs>
          {/* Ring Gradient */}
          <linearGradient id="ext-buglens-ring-grad" x1="10" y1="10" x2="85" y2="85" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f43f5e" />
            <stop offset="40%" stopColor="#ec4899" />
            <stop offset="75%" stopColor="#a855f7" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>

          {/* Right Bug Body Gradient */}
          <linearGradient id="ext-buglens-bug-right-grad" x1="45" y1="25" x2="65" y2="65" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ec4899" />
            <stop offset="100%" stopColor="#f43f5e" />
          </linearGradient>
        </defs>

        {/* Outer Magnifying Glass Ring */}
        <path
          d="M 45 12 A 32 32 0 1 0 72 61 L 88 77 A 5 5 0 0 0 95 70 L 79 54 A 32 32 0 0 0 45 12 Z M 45 20 A 24 24 0 1 1 21 44 A 24 24 0 0 1 45 20 Z"
          fill="url(#ext-buglens-ring-grad)"
        />

        {/* Magnifying Glass Handle Base Detail */}
        <path
          d="M 68 58 L 74 64 L 70 68 L 64 62 Z"
          fill="#a855f7"
          opacity="0.8"
        />

        {/* Bug Antennae (Mono theme color) */}
        <path d="M 39 30 Q 36 24 33 22" stroke={monoColor} strokeWidth="2.8" strokeLinecap="round" />
        <path d="M 51 30 Q 54 24 57 22" stroke={monoColor} strokeWidth="2.8" strokeLinecap="round" />

        {/* Bug Legs (Mono theme color) */}
        <path d="M 33 38 H 27 M 31 44 H 25 M 34 50 H 28" stroke={monoColor} strokeWidth="2.8" strokeLinecap="round" />
        <path d="M 57 38 H 63 M 59 44 H 65 M 56 50 H 62" stroke={monoColor} strokeWidth="2.8" strokeLinecap="round" />

        {/* Left Bug Body Half (Theme Adapting Monochrome) */}
        <path
          d="M 45 29 C 37 29 34 35 34 44 C 34 53 37 59 45 59 Z"
          fill={monoColor}
        />

        {/* Right Bug Body Half (Vibrant Pink/Magenta Gradient) */}
        <path
          d="M 45 29 C 53 29 56 35 56 44 C 56 53 53 59 45 59 Z"
          fill="url(#ext-buglens-bug-right-grad)"
        />

        {/* Bug Head (Mono theme color) */}
        <path
          d="M 40 31 C 40 28 50 28 50 31 Z"
          fill={monoColor}
        />
      </svg>

      {/* Optional Text Branding */}
      {showText && (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', fontWeight: 800, fontSize: '20px', letterSpacing: '-0.02em' }}>
            {/* Mono Color Text Adapts to Light/Dark Theme */}
            <span style={{ color: monoColor, transition: 'color 0.2s ease' }}>
              Bug
            </span>
            {/* Lens Gradient Text */}
            <span
              style={{
                background: 'linear-gradient(135deg, #818cf8 0%, #c084fc 50%, #f43f5e 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                marginLeft: '3px',
              }}
            >
              Lens
            </span>
          </div>

          {showSubtitle && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.12em', marginTop: '4px' }}>
              <span style={{ color: '#a855f7' }}>•</span>
              <span style={{ color: monoColor, opacity: 0.8 }}>FIND</span>
              <span style={{ opacity: 0.5, color: monoColor }}>SNEAK</span>
              <span style={{ color: monoColor, opacity: 0.8 }}>RAISE</span>
              <span style={{ color: '#f43f5e' }}>•</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

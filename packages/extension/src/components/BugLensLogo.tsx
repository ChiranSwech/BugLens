import React from 'react';
import { LOGO_DATA_URI } from '../assets/logoData';

interface BugLensLogoProps {
  size?: number | string;
  showText?: boolean;
  showSubtitle?: boolean;
  badge?: string;
  className?: string;
  monoColor?: string; // Custom CSS color or var(--text-primary)
  style?: React.CSSProperties;
}

export const BugLensLogo: React.FC<BugLensLogoProps> = ({
  size = 32,
  showText = true,
  showSubtitle = true,
  badge,
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
      <img
        src={LOGO_DATA_URI}
        width={iconSize}
        height={iconSize}
        alt="BugLens Logo"
        style={{
          flexShrink: 0,
          width: iconSize,
          height: iconSize,
          objectFit: 'contain',
          filter: 'drop-shadow(0 0 5px rgba(255, 255, 255, 0.45)) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2))',
          borderRadius: '6px',
        }}
      />

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
            {badge && (
              <span
                style={{
                  marginLeft: '8px',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  border: '1px solid rgba(129, 140, 248, 0.4)',
                  background: 'rgba(99, 102, 241, 0.15)',
                  color: '#818cf8',
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                }}
              >
                {badge}
              </span>
            )}
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

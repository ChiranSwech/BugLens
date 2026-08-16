import React from 'react';
import { LOGO_DATA_URI } from '../assets/logoData';

interface BugLensLogoProps {
  size?: number | string;
  showText?: boolean;
  showSubtitle?: boolean;
  badge?: string;
  className?: string;
  monoColorClass?: string; // Optional custom Tailwind/CSS class for mono color adaptation
  textClassName?: string;
}

export const BugLensLogo: React.FC<BugLensLogoProps> = ({
  size = 36,
  showText = true,
  showSubtitle = true,
  badge,
  className = '',
  monoColorClass = 'text-slate-900 dark:text-white',
  textClassName = '',
}) => {
  const iconSize = typeof size === 'number' ? `${size}px` : size;

  return (
    <div className={`inline-flex items-center gap-3 select-none ${className}`}>
      <img
        src={LOGO_DATA_URI}
        width={iconSize}
        height={iconSize}
        alt="BugLens Logo"
        className="shrink-0 transition-transform duration-300 hover:scale-105 object-contain"
        style={{
          width: iconSize,
          height: iconSize,
          filter: 'drop-shadow(0 0 5px rgba(255, 255, 255, 0.45)) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2))',
          borderRadius: '6px',
        }}
      />

      {/* Optional Text Branding */}
      {showText && (
        <div className={`flex flex-col leading-none ${textClassName}`}>
          <div className="flex items-center font-black tracking-tight text-2xl font-sans">
            {/* Mono Color Text Adapts to Light/Dark Theme */}
            <span className={`transition-colors duration-200 ${monoColorClass}`}>
              Bug
            </span>
            {/* Lens Gradient Text */}
            <span className="bg-gradient-to-r from-[#818cf8] via-[#c084fc] to-[#f43f5e] bg-clip-text text-transparent ml-1">
              Lens
            </span>
            {badge && (
              <span className="ml-2 px-2 py-0.5 rounded-full border border-indigo-400/40 bg-indigo-500/15 text-indigo-400 text-[10px] font-bold tracking-widest uppercase">
                {badge}
              </span>
            )}
          </div>

          {showSubtitle && (
            <div className="flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-widest mt-1">
              <span className="text-[#a855f7]">•</span>
              <span className={`opacity-70 transition-colors duration-200 ${monoColorClass}`}>FIND</span>
              <span className="opacity-50">SNEAK</span>
              <span className={`opacity-70 transition-colors duration-200 ${monoColorClass}`}>RAISE</span>
              <span className="text-[#f43f5e]">•</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

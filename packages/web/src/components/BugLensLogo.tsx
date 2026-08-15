import React from 'react';

interface BugLensLogoProps {
  size?: number | string;
  showText?: boolean;
  showSubtitle?: boolean;
  className?: string;
  monoColorClass?: string; // Optional custom Tailwind/CSS class for mono color adaptation
  textClassName?: string;
}

export const BugLensLogo: React.FC<BugLensLogoProps> = ({
  size = 36,
  showText = true,
  showSubtitle = false,
  className = '',
  monoColorClass = 'text-slate-900 dark:text-white',
  textClassName = '',
}) => {
  const iconSize = typeof size === 'number' ? `${size}px` : size;

  return (
    <div className={`inline-flex items-center gap-3 select-none ${className}`}>
      {/* SVG Icon */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 transition-transform duration-300 hover:scale-105"
      >
        <defs>
          {/* Ring Gradient */}
          <linearGradient id="buglens-ring-grad" x1="10" y1="10" x2="85" y2="85" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f43f5e" />
            <stop offset="40%" stopColor="#ec4899" />
            <stop offset="75%" stopColor="#a855f7" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>

          {/* Right Bug Body Gradient */}
          <linearGradient id="buglens-bug-right-grad" x1="45" y1="25" x2="65" y2="65" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ec4899" />
            <stop offset="100%" stopColor="#f43f5e" />
          </linearGradient>

          {/* Subtitle Dot Gradient */}
          <linearGradient id="buglens-dot-grad" x1="0" y1="0" x2="10" y2="10" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#a855f7" />
            <stop offset="100%" stopColor="#f43f5e" />
          </linearGradient>
        </defs>

        {/* Outer Magnifying Glass Ring */}
        <path
          d="M 45 12 A 32 32 0 1 0 72 61 L 88 77 A 5 5 0 0 0 95 70 L 79 54 A 32 32 0 0 0 45 12 Z M 45 20 A 24 24 0 1 1 21 44 A 24 24 0 0 1 45 20 Z"
          fill="url(#buglens-ring-grad)"
        />

        {/* Magnifying Glass Handle Base Detail */}
        <path
          d="M 68 58 L 74 64 L 70 68 L 64 62 Z"
          fill="#a855f7"
          opacity="0.8"
        />

        {/* Bug Antennae */}
        <path d="M 39 30 Q 36 24 33 22" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={monoColorClass} />
        <path d="M 51 30 Q 54 24 57 22" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={monoColorClass} />

        {/* Bug Legs */}
        <path d="M 33 38 H 27 M 31 44 H 25 M 34 50 H 28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={monoColorClass} />
        <path d="M 57 38 H 63 M 59 44 H 65 M 56 50 H 62" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={monoColorClass} />

        {/* Left Bug Body Half (Theme Adapting Monochrome) */}
        <path
          d="M 45 29 C 37 29 34 35 34 44 C 34 53 37 59 45 59 Z"
          fill="currentColor"
          className={monoColorClass}
        />

        {/* Right Bug Body Half (Vibrant Pink/Magenta Gradient) */}
        <path
          d="M 45 29 C 53 29 56 35 56 44 C 56 53 53 59 45 59 Z"
          fill="url(#buglens-bug-right-grad)"
        />

        {/* Bug Head */}
        <path
          d="M 40 31 C 40 28 50 28 50 31 Z"
          fill="currentColor"
          className={monoColorClass}
        />
      </svg>

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

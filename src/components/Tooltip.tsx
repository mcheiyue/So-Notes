import React, { useState, useRef } from 'react';
import { cn } from "../utils/cn";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number; // Delay in ms
}

export function Tooltip({ content, children, side = 'top', delay = 0 }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<number>(undefined);

  const positionClasses = {
    top: "bottom-full mb-2",
    bottom: "top-full mt-2",
    left: "right-full mr-2",
    right: "left-full ml-2",
  };

  const handleMouseEnter = () => {
    timeoutRef.current = window.setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  };

  return (
    <div 
        className="relative flex items-center justify-center"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
    >
      {children}
      <div 
        className={cn(
            "absolute transition-all duration-200",
            "px-2 py-1 bg-white/90 backdrop-blur-sm text-slate-500 text-xs tracking-wide",
            "rounded shadow-md border border-slate-200 whitespace-nowrap z-50 pointer-events-none",
            positionClasses[side],
            isVisible ? "opacity-100 visible translate-y-0" : "opacity-0 invisible translate-y-1"
        )}
      >
        {content}
      </div>
    </div>
  );
}

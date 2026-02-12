import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from "../utils/cn";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  disabled?: boolean;
}

export const Tooltip = React.memo(function Tooltip({ content, children, side = 'top', delay = 0, disabled = false }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<number>(undefined);

  const calculatePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    // Basic offset spacing
    const gap = 8; 

    let top = 0;
    let left = 0;

    switch (side) {
      case 'top':
        top = rect.top + scrollY - gap; // We'll adjust for height later via CSS transform
        left = rect.left + scrollX + rect.width / 2;
        break;
      case 'bottom':
        top = rect.bottom + scrollY + gap;
        left = rect.left + scrollX + rect.width / 2;
        break;
      case 'left':
        top = rect.top + scrollY + rect.height / 2;
        left = rect.left + scrollX - gap;
        break;
      case 'right':
        top = rect.top + scrollY + rect.height / 2;
        left = rect.right + scrollX + gap;
        break;
    }

    setCoords({ top, left });
  };

  useEffect(() => {
    if (disabled && isVisible) {
        setIsVisible(false);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
    }
  }, [disabled, isVisible]);

  const handleMouseEnter = () => {
    if (disabled) return;
    calculatePosition(); // Recalculate on enter
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

  // Close on scroll/resize to prevent floating ghosts
  useEffect(() => {
    if (!isVisible) return;
    const handleUpdate = () => setIsVisible(false);
    window.addEventListener('scroll', handleUpdate);
    window.addEventListener('resize', handleUpdate);
    return () => {
        window.removeEventListener('scroll', handleUpdate);
        window.removeEventListener('resize', handleUpdate);
    };
  }, [isVisible]);

  return (
    <div 
        ref={triggerRef}
        className="relative flex items-center justify-center" // Removed z-index from here
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && createPortal(
          <div 
            className={cn(
                "tooltip-portal fixed z-[999999] px-2 py-1 bg-tertiary-bg/95 backdrop-blur text-text-secondary text-xs font-medium tracking-wide",
                "rounded shadow-lg border border-border-subtle whitespace-nowrap pointer-events-none",
                "transition-opacity duration-200 animate-in fade-in zoom-in-95",
                // Positioning transforms to center the tooltip relative to the coordinate
                side === 'top' && "-translate-x-1/2 -translate-y-full",
                side === 'bottom' && "-translate-x-1/2",
                side === 'left' && "-translate-x-full -translate-y-1/2",
                side === 'right' && "-translate-y-1/2"
            )}
            style={{ 
                top: coords.top, 
                left: coords.left 
            }}
          >
            {content}
          </div>,
          document.body
      )}
    </div>
  );
});

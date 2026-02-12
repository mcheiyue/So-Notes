import { useStore } from '../store/useStore';
import { useEffect, useState } from 'react';

/**
 * A hook that returns whether the app is currently in dark mode.
 * It reacts to both the store's theme configuration and the system's color scheme preference.
 */
export const useDarkMode = (): boolean => {
  const themeMode = useStore((state) => state.config.themeMode);
  
  // Initialize with current system state to avoid hydration mismatch if possible,
  // though for client-side only apps this is fine.
  const [isSystemDark, setIsSystemDark] = useState(() => 
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    // Handler for system theme changes
    const handler = (e: MediaQueryListEvent) => {
      setIsSystemDark(e.matches);
    };
    
    // Modern browsers support addEventListener for MediaQueryList
    mediaQuery.addEventListener('change', handler);
    
    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, []);

  // Logic matches the store's init/setThemeMode logic
  if (themeMode === 'system') {
    return isSystemDark;
  }
  
  return themeMode === 'dark';
};

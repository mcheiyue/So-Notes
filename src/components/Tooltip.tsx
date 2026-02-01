import React from 'react';

export function Tooltip({ content, children }: { content: string, children: React.ReactNode }) {
  return (
    <div className="relative flex items-center justify-center group/tooltip">
      {children}
      <div className="absolute bottom-full mb-2 invisible opacity-0 group-hover/tooltip:visible group-hover/tooltip:opacity-100 transition-all duration-200 px-2 py-1 bg-white/90 backdrop-blur-sm text-slate-500 text-xs tracking-wide rounded shadow-md border border-slate-200 whitespace-nowrap z-50 pointer-events-none">
        {content}
      </div>
    </div>
  );
}

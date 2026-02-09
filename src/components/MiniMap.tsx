import React, { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { cn } from '../utils/cn';

export const MiniMap: React.FC = () => {
    const { notes, viewport, interaction } = useStore();
    
    const visibleNotes = useMemo(() => notes.filter(n => !n.deletedAt), [notes]);
    
    // Map Configuration
    const MAP_WIDTH = 240;
    const MAP_HEIGHT = 160;
    const NOTE_WIDTH = 260; // Standard note width
    const NOTE_HEIGHT = 100; // Standard note height

    // Calculate World Bounds (Always anchored at 0,0)
    const { scale } = useMemo(() => {
        // 1. Determine the maximum extent of the content
        let maxContentX = 0;
        let maxContentY = 0;

        // Check Viewport bounds
        maxContentX = Math.max(maxContentX, viewport.x + viewport.w);
        maxContentY = Math.max(maxContentY, viewport.y + viewport.h);

        // Check Notes bounds
        visibleNotes.forEach(note => {
            // Use note.width if available, otherwise default
            const w = (note as any).width || NOTE_WIDTH;
            const h = (note as any).height || NOTE_HEIGHT;
            maxContentX = Math.max(maxContentX, note.x + w);
            maxContentY = Math.max(maxContentY, note.y + h);
        });

        // 2. Add some "breathing room" to the world size (padding)
        // and ensure a minimum size so the map doesn't look too zoomed in on empty canvas
        const worldW = Math.max(maxContentX + 1000, 4000); 
        const worldH = Math.max(maxContentY + 1000, 3000);

        // 3. Calculate Scale to fit within the map container
        // We use the smaller scale to ensure EVERYTHING fits
        const scaleX = MAP_WIDTH / worldW;
        const scaleY = MAP_HEIGHT / worldH;
        const scale = Math.min(scaleX, scaleY);

        return { scale };
        }, [visibleNotes, viewport]);

    // Visibility Logic
    const edgePush = useStore(state => state.interaction.edgePush);
    const isEdgePushing = Object.values(edgePush).some(v => v);
    const isVisible = interaction.isPanMode || isEdgePushing;

    // Helper: World to Map Coordinates
    // Since world (0,0) is map (0,0), this is a simple scaling
    const toMap = (x: number, y: number, w: number, h: number) => ({
        left: x * scale,
        top: y * scale,
        width: w * scale,
        height: h * scale
    });

    // Viewport Rect on Map
    const vp = toMap(viewport.x, viewport.y, viewport.w, viewport.h);

    return (
        <div 
            className={cn(
                "fixed bottom-8 right-8 z-[999]",
                "w-[240px] h-[160px]",
                "bg-white/60 dark:bg-zinc-900/60 backdrop-blur-xl",
                "border border-white/40 dark:border-zinc-700/50",
                "rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.12)]",
                "overflow-hidden transition-all duration-300 ease-out transform",
                isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-8 scale-95 pointer-events-none"
            )}
        >
            {/* Grid Pattern Background */}
            <div 
                className="absolute inset-0 opacity-20 pointer-events-none"
                style={{ 
                    backgroundImage: `radial-gradient(circle, currentColor 1px, transparent 1px)`,
                    backgroundSize: '16px 16px',
                    color: '#a1a1aa' // zinc-400
                }} 
            />

            {/* Origin Marker (0,0) Visualizer */}
            <div className="absolute top-0 left-0">
                {/* Corner accent */}
                <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-rose-500 rounded-tl-sm" />
                {/* Dot */}
                <div className="absolute top-1 left-1 w-1 h-1 bg-rose-500 rounded-full shadow-[0_0_4px_rgba(244,63,94,0.5)]" />
            </div>

            {/* Content Container - Items are absolutely positioned relative to this */}
            <div className="relative w-full h-full">
                
                {/* Notes */}
                {visibleNotes.map(note => {
                    const rect = toMap(note.x, note.y, (note as any).width || NOTE_WIDTH, (note as any).height || NOTE_HEIGHT);
                    
                    // Skip if out of bounds (negative coordinates) - though UI requirement says anchor 0,0
                    if (rect.left + rect.width < 0 || rect.top + rect.height < 0) return null;

                    return (
                        <div key={note.id}
                             className={cn(
                                 "absolute rounded-[2px] shadow-sm transition-all duration-300",
                                 "bg-rose-400/80 dark:bg-rose-500/80 hover:bg-rose-500"
                             )}
                             style={{ 
                                 left: rect.left, 
                                 top: rect.top, 
                                 width: Math.max(3, rect.width), // Min size for visibility
                                 height: Math.max(3, rect.height) 
                             }}
                        />
                    );
                })}

                {/* Viewport Indicator */}
                <div 
                    className={cn(
                        "absolute rounded-lg shadow-sm transition-all duration-75 ease-linear",
                        "border-2 border-indigo-500/60 dark:border-indigo-400/60",
                        "bg-indigo-500/5 backdrop-brightness-110"
                    )}
                    style={{ 
                        left: vp.left, 
                        top: vp.top, 
                        width: Math.max(vp.width, 4), 
                        height: Math.max(vp.height, 4) 
                    }}
                >
                    {/* Viewport label (optional, kept minimal) */}
                    <div className="absolute -bottom-4 right-0 text-[8px] font-mono font-medium text-indigo-500/70 select-none">
                        VIEW
                    </div>
                </div>

            </div>

            {/* Coordinates Badge (Bottom Left) */}
            <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded-md bg-white/50 dark:bg-black/30 backdrop-blur-sm border border-white/20 dark:border-white/10">
                <span className="text-[9px] font-mono font-semibold text-zinc-500 dark:text-zinc-400">
                    {Math.round(viewport.x)}, {Math.round(viewport.y)}
                </span>
            </div>
        </div>
    );
};
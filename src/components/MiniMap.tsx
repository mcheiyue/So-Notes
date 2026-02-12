import React, { useMemo, useState, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../utils/cn';
import { LAYOUT, Z_INDEX } from '../constants/layout';
import { getNoteColor } from '../store/types';
import { useDarkMode } from '../hooks/useDarkMode';

export const MiniMap: React.FC = () => {
    const { notes, viewport, interaction, setViewportPosition } = useStore(
        useShallow(state => ({
            notes: state.notes,
            viewport: state.viewport,
            interaction: state.interaction,
            setViewportPosition: state.setViewportPosition,
        }))
    );
    const [isHovered, setIsHovered] = useState(false);
    const mapRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const isDarkMode = useDarkMode();

    const visibleNotes = useMemo(() => notes.filter(n => !n.deletedAt), [notes]);
    
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
            const w = (note as any).width || LAYOUT.NOTE_WIDTH;
            const h = (note as any).height || LAYOUT.NOTE_MIN_HEIGHT;
            maxContentX = Math.max(maxContentX, note.x + w);
            maxContentY = Math.max(maxContentY, note.y + h);
        });

        // 2. Add some "breathing room" to the world size (padding)
        // and ensure a minimum size so the map doesn't look too zoomed in on empty canvas
        const worldW = Math.max(maxContentX + 1000, 4000); 
        const worldH = Math.max(maxContentY + 1000, 3000);

        // 3. Calculate Scale to fit within the map container
        // We use the smaller scale to ensure EVERYTHING fits
        const scaleX = LAYOUT.MINIMAP_WIDTH / worldW;
        const scaleY = LAYOUT.MINIMAP_HEIGHT / worldH;
        const scale = Math.min(scaleX, scaleY);

        return { scale };
        }, [visibleNotes, viewport]);

    // Visibility Logic
    const edgePush = useStore(state => state.interaction.edgePush);
    const isEdgePushing = Object.values(edgePush).some(v => v);
    const isVisible = interaction.isPanMode || isEdgePushing || isHovered;

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

    // --- Interaction Handlers ---

    // 1. Dragging the Viewport Box (Delta Pan)
    const handleViewportDrag = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent jumping
        e.preventDefault();
        
        const startX = e.clientX;
        const startY = e.clientY;
        
        // Capture initial state
        const startVx = viewport.x;
        const startVy = viewport.y;
        const startLeft = vp.left;
        const startTop = vp.top;
        
        // Use a ref to store the latest mouse position for RAF
        let frameId: number | null = null;

        const handleMove = (moveEvent: MouseEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;

            // 1. Instant Visual Feedback (Direct DOM manipulation)
            // This eliminates the "lag" caused by waiting for React/Store round-trip
            if (viewportRef.current) {
                viewportRef.current.style.left = `${startLeft + dx}px`;
                viewportRef.current.style.top = `${startTop + dy}px`;
            }

            // 2. Throttled Store Update (Data Sync)
            if (frameId) return; // Skip if a frame is already pending

            frameId = requestAnimationFrame(() => {
                // Convert pixel delta to world delta
                const worldDx = dx / scale;
                const worldDy = dy / scale;
                
                setViewportPosition(startVx + worldDx, startVy + worldDy);
                frameId = null;
            });
        };
        
        const handleUp = () => {
            if (frameId) {
                cancelAnimationFrame(frameId);
                frameId = null;
            }
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', handleUp);
        };
        
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
    };

    // 2. Clicking/Dragging the Map Background (Jump to Position)
    const handleMapDrag = (e: React.MouseEvent) => {
        if (!mapRef.current) return;
        e.preventDefault();
        
        const rect = mapRef.current.getBoundingClientRect();
        
        const updatePosition = (clientX: number, clientY: number) => {
            const mapX = clientX - rect.left;
            const mapY = clientY - rect.top;
            
            // Convert to World Coordinates
            const worldX = mapX / scale;
            const worldY = mapY / scale;
            
            // Center viewport on this point
            setViewportPosition(worldX - viewport.w / 2, worldY - viewport.h / 2);
        };

        // Initial Jump
        updatePosition(e.clientX, e.clientY);
        
        const handleMove = (moveEvent: MouseEvent) => {
            updatePosition(moveEvent.clientX, moveEvent.clientY);
        };
        
        const handleUp = () => {
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', handleUp);
        };
        
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
    };

    return (
        <div 
            ref={mapRef}
            className={cn(
                "minimap-interaction-area", // Add marker class for interaction exclusion
                "fixed bottom-8 right-8",
                "bg-secondary-bg backdrop-blur-xl",
                "border border-border-subtle",
                "rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.2)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                "overflow-hidden transition-all duration-300 ease-out transform",
                isVisible ? "opacity-100 translate-y-0 scale-100 pointer-events-auto" : "opacity-0 translate-y-8 scale-95 pointer-events-none"
            )}
            style={{ 
                width: LAYOUT.MINIMAP_WIDTH,
                height: LAYOUT.MINIMAP_HEIGHT,
                zIndex: Z_INDEX.MINIMAP 
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onMouseDown={handleMapDrag}
        >
            {/* Grid Pattern Background */}
            <div 
                className="absolute inset-0 opacity-20 pointer-events-none"
                style={{ 
                    backgroundImage: `radial-gradient(circle, currentColor 1px, transparent 1px)`,
                    backgroundSize: '16px 16px',
                    color: 'var(--color-border-subtle)'
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
                
                {/* Notes Layer (Memoized) */}
                <MiniMapNotes notes={visibleNotes} scale={scale} isDarkMode={isDarkMode} />

                {/* Viewport Indicator */}
                <div 
                    ref={viewportRef}
                    className={cn(
                        "absolute rounded-lg shadow-sm transition-all duration-75 ease-linear cursor-grab active:cursor-grabbing",
                        "border-2 border-blue-500/60 dark:border-blue-300/60",
                        "bg-blue-500/5 dark:bg-blue-300/5 backdrop-brightness-110",
                        "hover:bg-blue-500/10 dark:hover:bg-blue-300/10 hover:border-blue-500/80 dark:hover:border-blue-300/80"
                    )}
                    style={{ 
                        left: vp.left, 
                        top: vp.top, 
                        width: Math.max(vp.width, 4), 
                        height: Math.max(vp.height, 4) 
                    }}
                    onMouseDown={handleViewportDrag}
                >
                    {/* Viewport label (optional, kept minimal) */}
                    <div className="absolute -bottom-4 right-0 text-[8px] font-mono font-medium text-blue-500/70 dark:text-blue-300/70 select-none">
                        VIEW
                    </div>
                </div>

            </div>

            {/* Coordinates Badge (Bottom Left) */}
            <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded-md bg-secondary-bg/50 backdrop-blur-sm border border-border-subtle">
                <span className="text-[9px] font-mono font-semibold text-text-secondary">
                    {Math.round(viewport.x)}, {Math.round(viewport.y)}
                </span>
            </div>
        </div>
    );
};

// Optimized Sub-component for Individual Note Item
const MiniMapNoteItem = React.memo(({ note, scale, isDarkMode }: { note: any, scale: number, isDarkMode: boolean }) => {
    const w = note.width || LAYOUT.NOTE_WIDTH;
    const h = note.height || LAYOUT.NOTE_MIN_HEIGHT;
    
    const left = note.x * scale;
    const top = note.y * scale;
    const width = w * scale;
    const height = h * scale;

    // Skip if effectively invisible
    if (width < 0.5 || height < 0.5) return null;
    
    // Skip if out of bounds (negative coordinates check)
    if (left + width < 0 || top + height < 0) return null;

    return (
        <div 
            className={cn(
                "absolute rounded-[2px] shadow-sm transition-all duration-300",
                "border border-border-subtle/50"
            )}
            style={{ 
                left, 
                top, 
                width: Math.max(3, width), // Min size for visibility
                height: Math.max(3, height),
                backgroundColor: getNoteColor(note.color, isDarkMode),
            }}
        />
    );
}, (prev, next) => {
    // Only re-render if note reference changes (Immer ensures this only happens for the moved note)
    // or if scale changes (global zoom/pan affecting world bounds)
    return prev.note === next.note && prev.scale === next.scale && prev.isDarkMode === next.isDarkMode;
});

// Optimized Container for Notes Layer
const MiniMapNotes = React.memo(({ notes, scale, isDarkMode }: { notes: any[], scale: number, isDarkMode: boolean }) => {
    return (
        <>
            {notes.map(note => (
                <MiniMapNoteItem key={note.id} note={note} scale={scale} isDarkMode={isDarkMode} />
            ))}
        </>
    );
}, (prev, next) => {
    // Re-render only if the notes array reference changes or scale changes
    return prev.notes === next.notes && prev.scale === next.scale && prev.isDarkMode === next.isDarkMode;
});

import { useRef, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { LAYOUT } from '../constants/layout';

export const useEdgePush = () => {
    const setEdgePush = useStore(state => state.setEdgePush);
    const viewport = useStore(state => state.viewport);
    const isPanMode = useStore(state => state.interaction.isPanMode);
    
    const edgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentEdge = useRef({ top: false, bottom: false, left: false, right: false });

    // Cleanup on unmount
    useEffect(() => {
        return () => {
             if (edgeTimer.current) clearTimeout(edgeTimer.current);
             setEdgePush({ top: false, bottom: false, left: false, right: false });
        };
    }, [setEdgePush]);

    const checkEdge = (x: number, y: number, width: number, height: number) => {
        // If in Pan Mode, disable Edge Push
        if (isPanMode) return;
        
        const winW = viewport.w;
        const winH = viewport.h;
        const EDGE_THRESHOLD = LAYOUT.EDGE_PUSH_THRESHOLD;

        // Check Edge Proximity
        const isRight = x > winW - width - EDGE_THRESHOLD;
        const isBottom = y > winH - height - EDGE_THRESHOLD;
        const isLeft = x < EDGE_THRESHOLD && viewport.x > 0;
        const isTop = y < EDGE_THRESHOLD && viewport.y > 0;

        const newEdge = { top: isTop, bottom: isBottom, left: isLeft, right: isRight };
        
        // Detect Change
        const hasChanged = 
            newEdge.top !== currentEdge.current.top ||
            newEdge.bottom !== currentEdge.current.bottom ||
            newEdge.left !== currentEdge.current.left ||
            newEdge.right !== currentEdge.current.right;

        if (hasChanged) {
            if (edgeTimer.current) {
                clearTimeout(edgeTimer.current);
                edgeTimer.current = null;
            }
            
            // Reset state immediately
            setEdgePush({ top: false, bottom: false, left: false, right: false });
            currentEdge.current = newEdge;

            // Start timer if any edge is active
            if (newEdge.top || newEdge.bottom || newEdge.left || newEdge.right) {
                    edgeTimer.current = setTimeout(() => {
                        setEdgePush(newEdge);
                    }, 1000);
            }
        }
    };
    
    const clearEdge = () => {
         if (edgeTimer.current) {
            clearTimeout(edgeTimer.current);
            edgeTimer.current = null;
        }
        setEdgePush({ top: false, bottom: false, left: false, right: false });
        currentEdge.current = { top: false, bottom: false, left: false, right: false };
    };

    return { checkEdge, clearEdge };
};

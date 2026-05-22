import { useRef, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { LAYOUT } from '../constants/layout';

export const EDGE_PUSH_ACTIVATION_DELAY = 1000;
export const EDGE_PUSH_EXIT_THRESHOLD = LAYOUT.EDGE_PUSH_THRESHOLD + 12;

type EdgeState = { top: boolean; bottom: boolean; left: boolean; right: boolean };

const EMPTY_EDGE: EdgeState = { top: false, bottom: false, left: false, right: false };

const hasAnyEdge = (edge: EdgeState) => edge.top || edge.bottom || edge.left || edge.right;

const isSameEdge = (a: EdgeState, b: EdgeState) => (
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.right === b.right
);

export const useEdgePush = () => {
    const setEdgePush = useStore(state => state.setEdgePush);
    const isDragging = useStore(state => state.interaction.isDragging);
    
    const edgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentEdge = useRef<EdgeState>(EMPTY_EDGE);
    const isEdgeActive = useRef(false);

    const resetEdgeState = () => {
        if (edgeTimer.current) {
            clearTimeout(edgeTimer.current);
            edgeTimer.current = null;
        }
        isEdgeActive.current = false;
        currentEdge.current = EMPTY_EDGE;
    };

    const computeEdgeState = (
        x: number,
        y: number,
        width: number,
        height: number,
        viewport: { x: number; y: number; w: number; h: number },
        threshold: number,
    ): EdgeState => {
        const isRight = x > viewport.w - width - threshold;
        const isBottom = y > viewport.h - height - threshold;
        const isLeft = x < threshold && viewport.x > 0;
        const isTop = y < threshold && viewport.y > 0;

        return { top: isTop, bottom: isBottom, left: isLeft, right: isRight };
    };

    const computeResolvedActiveEdge = (
        x: number,
        y: number,
        width: number,
        height: number,
        viewport: { x: number; y: number; w: number; h: number },
    ): EdgeState => {
        const enteringEdge = computeEdgeState(x, y, width, height, viewport, LAYOUT.EDGE_PUSH_THRESHOLD);
        const exitingEdge = computeEdgeState(x, y, width, height, viewport, EDGE_PUSH_EXIT_THRESHOLD);
        const previous = currentEdge.current;

        return {
            top: previous.top ? exitingEdge.top : enteringEdge.top,
            bottom: previous.bottom ? exitingEdge.bottom : enteringEdge.bottom,
            left: previous.left ? exitingEdge.left : enteringEdge.left,
            right: previous.right ? exitingEdge.right : enteringEdge.right,
        };
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
             resetEdgeState();
             setEdgePush(EMPTY_EDGE);
        };
    }, [setEdgePush]);

    useEffect(() => {
        if (!isDragging && (isEdgeActive.current || !!edgeTimer.current || hasAnyEdge(currentEdge.current))) {
            resetEdgeState();
            setEdgePush(EMPTY_EDGE);
        }
    }, [isDragging, setEdgePush]);

    const checkEdge = (x: number, y: number, width: number, height: number) => {
        // Access store directly to avoid re-renders on every viewport change
        const state = useStore.getState();
        const viewport = state.viewport;
        const isPanMode = state.interaction.isPanMode;
        const hasPendingState = isEdgeActive.current || !!edgeTimer.current || hasAnyEdge(currentEdge.current);

        // If in Pan Mode, disable Edge Push
        if (isPanMode) {
            if (hasPendingState) {
                resetEdgeState();
                setEdgePush(EMPTY_EDGE);
            }
            return;
        }

        if (isEdgeActive.current) {
            const nextEdge = computeResolvedActiveEdge(x, y, width, height, viewport);
            if (!hasAnyEdge(nextEdge)) {
                resetEdgeState();
                setEdgePush(EMPTY_EDGE);
                return;
            }

            if (!isSameEdge(nextEdge, currentEdge.current)) {
                currentEdge.current = nextEdge;
                setEdgePush(nextEdge);
            }
            return;
        }

        const nextEdge = computeEdgeState(x, y, width, height, viewport, LAYOUT.EDGE_PUSH_THRESHOLD);

        if (!hasAnyEdge(nextEdge)) {
            if (edgeTimer.current) {
                clearTimeout(edgeTimer.current);
                edgeTimer.current = null;
            }
            if (hasAnyEdge(currentEdge.current)) {
                currentEdge.current = EMPTY_EDGE;
                setEdgePush(EMPTY_EDGE);
            }
            return;
        }

        if (edgeTimer.current && isSameEdge(nextEdge, currentEdge.current)) {
            return;
        }

        if (edgeTimer.current) {
            clearTimeout(edgeTimer.current);
            edgeTimer.current = null;
        }

        currentEdge.current = nextEdge;
        edgeTimer.current = setTimeout(() => {
            isEdgeActive.current = true;
            edgeTimer.current = null;
            setEdgePush(currentEdge.current);
        }, EDGE_PUSH_ACTIVATION_DELAY);
    };

    const clearEdge = () => {
        resetEdgeState();
        setEdgePush(EMPTY_EDGE);
    };

    return { checkEdge, clearEdge };
};

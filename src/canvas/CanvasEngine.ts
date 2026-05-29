import { LAYOUT } from "../constants/layout";
import { useStore } from "../store/useStore";
import { useViewportStore } from "../store";
import {
  getEdgePushDragLeader,
  hasActiveEdgePushDragSession,
  accumulateEdgePushDelta,
  applyActiveDragSessionTransforms,
  resetEdgePushDragCompensation,
} from "../utils/edgePushDragCompensation";
import { getNoteElement } from "../utils/noteElementRegistry";
import { getNoteVisualWidth, getNoteVisualHeight } from "../utils/noteVisualMetrics";
import { resolveDragStopWorldPosition } from "../utils/dragCoordinates";
import { resetActiveNoteDrag } from "../utils/activeNoteDrag";

interface Point {
  x: number;
  y: number;
}

export class CanvasEngine {
  readonly isPanning = { current: false };
  readonly isSelecting = { current: false };
  readonly panStart: Point = { x: 0, y: 0 };
  readonly selectionStart: Point = { x: 0, y: 0 };
  readonly panDelta: Point = { x: 0, y: 0 };

  private panFlushFrame = 0;
  private edgePushFrame = 0;

  lastSpacePressTime = 0;

  // sticky drag 预览位置——落位时的唯一真相来源（替代 DOM style.transform 解析）
  private stickyDragPreviewPositions = new Map<string, Point>();

  private worldLayerRef: React.RefObject<HTMLDivElement | null> | null = null;
  private selectionBoxRef: React.RefObject<HTMLDivElement | null> | null = null;

  bindRefs(
    worldLayerRef: React.RefObject<HTMLDivElement | null>,
    selectionBoxRef: React.RefObject<HTMLDivElement | null>,
  ): void {
    this.worldLayerRef = worldLayerRef;
    this.selectionBoxRef = selectionBoxRef;
  }

  schedulePanFlushLoop(): void {
    if (this.panFlushFrame) return;

    const flush = () => {
      this.panFlushFrame = 0;

      const { x: dx, y: dy } = this.panDelta;
      if (dx === 0 && dy === 0) return;

      const vpState = useViewportStore.getState();
      const newX = Math.max(0, vpState.viewport.x + dx);
      const newY = Math.max(0, vpState.viewport.y + dy);

      if (this.worldLayerRef?.current) {
        this.worldLayerRef.current.style.transform =
          `translate3d(${-newX}px, ${-newY}px, 0)`;
      }

      useViewportStore.getState().setViewportPosition(newX, newY);
      this.panDelta.x = 0;
      this.panDelta.y = 0;
    };

    this.panFlushFrame = requestAnimationFrame(flush);
  }

  stopPanFlushLoop(): void {
    if (this.panFlushFrame) {
      cancelAnimationFrame(this.panFlushFrame);
      this.panFlushFrame = 0;
    }
  }

  syncEdgePushLoop(): void {
    const { top, bottom, left, right } =
      useViewportStore.getState().interaction.edgePush;

    if (!top && !bottom && !left && !right) {
      if (this.edgePushFrame) {
        cancelAnimationFrame(this.edgePushFrame);
        this.edgePushFrame = 0;
        const vp = useViewportStore.getState().viewport;
        useViewportStore.getState().setViewportPosition(vp.x, vp.y);
      }
      return;
    }

    const vp = useViewportStore.getState().viewport;
    let currentX = vp.x;
    let currentY = vp.y;

    const pushLoop = () => {
      let dx = 0;
      let dy = 0;
      const SPEED = LAYOUT.EDGE_PUSH_SPEED;
      const edgePush = useViewportStore.getState().interaction.edgePush;

      if (edgePush.left) dx -= SPEED;
      if (edgePush.right) dx += SPEED;
      if (edgePush.top) dy -= SPEED;
      if (edgePush.bottom) dy += SPEED;

      if (dx !== 0 || dy !== 0) {
        const prevX = currentX;
        const prevY = currentY;
        currentX = Math.max(0, currentX + dx);
        currentY = Math.max(0, currentY + dy);
        const actualDx = currentX - prevX;
        const actualDy = currentY - prevY;

        useViewportStore.getState().setViewportPosition(currentX, currentY);

        if (this.worldLayerRef?.current) {
          this.worldLayerRef.current.style.transform =
            `translate3d(${-currentX}px, ${-currentY}px, 0)`;
        }

        const leaderId = getEdgePushDragLeader();
        if (leaderId && hasActiveEdgePushDragSession()) {
          accumulateEdgePushDelta(actualDx, actualDy);
          applyActiveDragSessionTransforms();
        } else {
          useStore.getState().moveSelectedNotes(actualDx, actualDy, leaderId ?? undefined);
        }
      }
      this.edgePushFrame = requestAnimationFrame(pushLoop);
    };

    this.edgePushFrame = requestAnimationFrame(pushLoop);
  }

  stopEdgePushLoop(): void {
    if (this.edgePushFrame) {
      cancelAnimationFrame(this.edgePushFrame);
      this.edgePushFrame = 0;
    }
  }

  resetPointerInteractions(): void {
    this.isPanning.current = false;
    this.isSelecting.current = false;
    this.panDelta.x = 0;
    this.panDelta.y = 0;
    this.stopPanFlushLoop();

    if (this.selectionBoxRef?.current) {
      this.selectionBoxRef.current.style.display = 'none';
    }
  }

  setStickyDragPreviewPosition(id: string, x: number, y: number): void {
    this.stickyDragPreviewPositions.set(id, { x, y });
  }

  getStickyDragPreviewPosition(id: string): Point | undefined {
    return this.stickyDragPreviewPositions.get(id);
  }

  clearStickyDragPreviewPositions(): void {
    this.stickyDragPreviewPositions.clear();
  }

  getStickyDragIds(): string[] {
    const vpState = useViewportStore.getState();
    const leaderId = vpState.stickyDrag.id;
    if (!leaderId) return [];

    const legacyState = useStore.getState();
    if (legacyState.selectedIds.includes(leaderId) && legacyState.selectedIds.length > 1) {
      return legacyState.selectedIds;
    }
    return [leaderId];
  }

  restoreStickyDragPreview(): void {
    const legacyState = useStore.getState();
    const ids = this.getStickyDragIds();
    ids.forEach((id) => {
      const el = getNoteElement(id);
      const note = legacyState.notesById[id];
      if (!el || !note) return;
      el.style.transform = `translate(${note.x}px, ${note.y}px)`;
    });
  }

  commitStickyDragPlacement(): void {
    const legacyState = useStore.getState();
    const vpState = useViewportStore.getState();
    const idsToCommit = this.getStickyDragIds();
    if (idsToCommit.length === 0) {
      useViewportStore.getState().setStickyDrag(null);
      return;
    }

    const rawPositions = Object.fromEntries(
      idsToCommit.flatMap((id) => {
        const note = legacyState.notesById[id];
        if (!note) return [];

        const previewPos = this.stickyDragPreviewPositions.get(id);
        if (previewPos) {
          return [[id, { x: previewPos.x, y: previewPos.y }]];
        }

        return [[id, { x: note.x, y: note.y }]];
      }),
    ) as Record<string, { x: number; y: number }>;

    const finalPositions = Object.fromEntries(
      idsToCommit.flatMap((id) => {
        const note = legacyState.notesById[id];
        const layout = legacyState.layoutNotesById[id];
        const rawPosition = rawPositions[id];
        if (!note || !layout || !rawPosition) return [];

        return [[
          id,
          resolveDragStopWorldPosition(
            rawPosition.x,
            rawPosition.y,
            vpState.viewport,
            getNoteVisualWidth(note, layout),
            getNoteVisualHeight(note, layout),
            vpState.interaction.isPanMode,
            10,
          ),
        ]];
      }),
    ) as Record<string, { x: number; y: number }>;

    const timestamp = Date.now();
    useStore.setState((draft) => {
      idsToCommit.forEach((id) => {
        const note = draft.notesById[id];
        const position = finalPositions[id];
        if (!note || !position) return;

        note.x = position.x;
        note.y = position.y;
        note.updatedAt = timestamp;
        draft.layoutNotesById[id] = {
          id: note.id,
          x: note.x,
          y: note.y,
          boardId: note.boardId,
          deletedAt: note.deletedAt ?? null,
          color: note.color,
          width: note.width,
          height: note.height,
        };
      });
    });

    this.stickyDragPreviewPositions.clear();
    useViewportStore.getState().setStickyDrag(null);
    legacyState.finalizeLayoutChange(idsToCommit);
  }

  cancelStickyDrag(): void {
    const vpState = useViewportStore.getState();
    if (!vpState.stickyDrag.id) return;
    this.restoreStickyDragPreview();
    this.stickyDragPreviewPositions.clear();
    useViewportStore.getState().setStickyDrag(null);
  }

  suspendStickyDrag(): void {
    const vpState = useViewportStore.getState();
    if (!vpState.stickyDrag.id || vpState.stickyDrag.status === 'suspended') return;
    useViewportStore.getState().setStickyDrag(
      vpState.stickyDrag.id,
      vpState.stickyDrag.offsetX,
      vpState.stickyDrag.offsetY,
      'suspended',
    );
  }

  resetAllInteractions(): void {
    resetActiveNoteDrag('window-blur');

    this.resetPointerInteractions();

    useViewportStore.getState().setEdgePush({
      top: false, bottom: false, left: false, right: false,
    });
    useViewportStore.getState().setIsDragging(false);
    resetEdgePushDragCompensation();

    this.suspendStickyDrag();
  }

  dispose(): void {
    this.resetAllInteractions();
    this.stopEdgePushLoop();
    this.cancelStickyDrag();
    this.stickyDragPreviewPositions.clear();
    this.worldLayerRef = null;
    this.selectionBoxRef = null;
  }
}

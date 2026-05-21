interface DragViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GroupDragBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export const getEdgeCheckRect = (
  dragX: number,
  dragY: number,
  viewport: Pick<DragViewport, 'x' | 'y'>,
  fallbackWidth: number,
  fallbackHeight: number,
  groupBounds?: GroupDragBounds | null,
) => {
  if (groupBounds) {
    return {
      x: dragX + groupBounds.minX - viewport.x,
      y: dragY + groupBounds.minY - viewport.y,
      width: groupBounds.width,
      height: groupBounds.height,
    };
  }

  return {
    x: dragX - viewport.x,
    y: dragY - viewport.y,
    width: fallbackWidth,
    height: fallbackHeight,
  };
};

export const resolveDragStopWorldPosition = (
  dragX: number,
  dragY: number,
  viewport: DragViewport,
  noteWidth: number,
  noteHeight: number,
  isPanMode: boolean,
  margin: number,
) => {
  let finalScreenX = dragX - viewport.x;
  let finalScreenY = dragY - viewport.y;

  let finalWorldX = dragX;
  let finalWorldY = dragY;

  if (!isPanMode) {
    if (finalScreenX > viewport.w - noteWidth) finalScreenX = viewport.w - noteWidth - margin;
    if (finalScreenY > viewport.h - noteHeight) finalScreenY = viewport.h - noteHeight - margin;

    if (finalScreenX < 0) finalScreenX = 0;
    if (finalScreenY < 0) finalScreenY = 0;

    finalWorldX = finalScreenX + viewport.x;
    finalWorldY = finalScreenY + viewport.y;
  }

  return {
    x: Math.max(0, finalWorldX),
    y: Math.max(0, finalWorldY),
  };
};

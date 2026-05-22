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

interface WorldPosition {
  x: number;
  y: number;
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

export const alignGroupPositionsWithinBounds = (
  positions: Record<string, WorldPosition>,
  ids: string[],
  viewport: DragViewport,
  isPanMode: boolean,
  margin: number,
  getBounds: (id: string) => { width: number; height: number } | null,
) => {
  if (ids.length === 0) {
    return {} as Record<string, WorldPosition>;
  }

  let groupLeft = Infinity;
  let groupTop = Infinity;
  let groupRight = -Infinity;
  let groupBottom = -Infinity;

  ids.forEach((id) => {
    const position = positions[id];
    const bounds = getBounds(id);
    if (!position || !bounds) return;

    groupLeft = Math.min(groupLeft, position.x);
    groupTop = Math.min(groupTop, position.y);
    groupRight = Math.max(groupRight, position.x + bounds.width);
    groupBottom = Math.max(groupBottom, position.y + bounds.height);
  });

  if (!Number.isFinite(groupLeft) || !Number.isFinite(groupTop)) {
    return { ...positions };
  }

  const minX = isPanMode ? 0 : viewport.x;
  const minY = isPanMode ? 0 : viewport.y;
  const maxRight = isPanMode ? Number.POSITIVE_INFINITY : viewport.x + viewport.w - margin;
  const maxBottom = isPanMode ? Number.POSITIVE_INFINITY : viewport.y + viewport.h - margin;

  let deltaX = 0;
  let deltaY = 0;

  if (groupLeft < minX) {
    deltaX = minX - groupLeft;
  }
  if (groupTop < minY) {
    deltaY = minY - groupTop;
  }

  if (Number.isFinite(maxRight) && groupRight + deltaX > maxRight) {
    deltaX += maxRight - (groupRight + deltaX);
  }
  if (Number.isFinite(maxBottom) && groupBottom + deltaY > maxBottom) {
    deltaY += maxBottom - (groupBottom + deltaY);
  }

  return Object.fromEntries(
    ids.map((id) => {
      const position = positions[id];
      if (!position) {
        return [id, { x: 0, y: 0 }];
      }

      return [
        id,
        {
          x: Math.max(0, position.x + deltaX),
          y: Math.max(0, position.y + deltaY),
        },
      ];
    }),
  ) as Record<string, WorldPosition>;
};

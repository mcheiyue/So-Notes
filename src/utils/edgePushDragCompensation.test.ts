import { describe, expect, it, beforeEach } from 'vitest';
import {
  beginEdgePushDragSession,
  setEdgePushDragLeader,
  getEdgePushDragLeader,
  accumulateEdgePushDelta,
  getEdgePushAccumulatedDelta,
  getEdgePushDragSessionPosition,
  getEdgePushDragTotalDelta,
  updateEdgePushPointerDelta,
  setLastDraggablePosition,
  getLastDraggablePosition,
  getEffectiveLeaderPosition,
} from './edgePushDragCompensation';

describe('edgePushDragCompensation', () => {
  beforeEach(() => {
    setEdgePushDragLeader(null);
  });

  it('setEdgePushDragLeader(null) 重置累积增量与拖拽位置', () => {
    setEdgePushDragLeader('note-1');
    accumulateEdgePushDelta(10, 20);
    setLastDraggablePosition(100, 200);

    setEdgePushDragLeader(null);

    expect(getEdgePushDragLeader()).toBeNull();
    expect(getEdgePushAccumulatedDelta()).toEqual({ x: 0, y: 0 });
    expect(getLastDraggablePosition()).toEqual({ x: 0, y: 0 });
  });

  it('accumulateEdgePushDelta 累加多帧增量', () => {
    setEdgePushDragLeader('note-1');
    accumulateEdgePushDelta(5, 0);
    accumulateEdgePushDelta(5, 0);
    accumulateEdgePushDelta(0, 3);

    expect(getEdgePushAccumulatedDelta()).toEqual({ x: 10, y: 3 });
  });

  it('setLastDraggablePosition 覆盖而非累加', () => {
    setEdgePushDragLeader('note-1');
    setLastDraggablePosition(50, 60);
    setLastDraggablePosition(55, 65);

    expect(getLastDraggablePosition()).toEqual({ x: 55, y: 65 });
  });

  it('getEffectiveLeaderPosition 返回 draggable 位置与累积推动增量的统一真值', () => {
    setEdgePushDragLeader('note-1');
    setLastDraggablePosition(150, 200);
    accumulateEdgePushDelta(15, -5);

    expect(getEffectiveLeaderPosition()).toEqual({ x: 165, y: 195 });
  });

  it('DragSession 用 pointerDelta + edgePushDelta 推导所有便签的有效位置', () => {
    beginEdgePushDragSession('leader', ['leader', 'follower'], {
      leader: { x: 100, y: 100 },
      follower: { x: 300, y: 120 },
    });

    updateEdgePushPointerDelta(40, 10);
    accumulateEdgePushDelta(15, 0);

    expect(getEdgePushDragTotalDelta()).toEqual({ x: 55, y: 10 });
    expect(getEffectiveLeaderPosition()).toEqual({ x: 155, y: 110 });
    expect(getEdgePushDragSessionPosition('follower')).toEqual({ x: 355, y: 130 });
  });

  it('leader 未设置时累积增量仍可写入但不影响 DOM', () => {
    accumulateEdgePushDelta(10, 10);
    expect(getEdgePushAccumulatedDelta()).toEqual({ x: 10, y: 10 });
    expect(getEdgePushDragLeader()).toBeNull();
  });

  it('切换 leader 时前一个累积增量被清零', () => {
    setEdgePushDragLeader('note-1');
    accumulateEdgePushDelta(50, 50);

    setEdgePushDragLeader('note-2');

    expect(getEdgePushDragLeader()).toBe('note-2');
    expect(getEdgePushAccumulatedDelta()).toEqual({ x: 0, y: 0 });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('./db', () => ({
  db: {
    saveWAL: vi.fn(async () => undefined),
    loadWAL: vi.fn(async () => undefined),
    clearWAL: vi.fn(async () => undefined),
  },
}));

vi.mock('../utils/fileSystem', () => ({
  saveFile: vi.fn(async () => true),
  openFile: vi.fn(async () => null),
}));

import { useStore } from './useStore';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useStore 布局持久化契约', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);

    useStore.setState({
      notes: [
        {
          id: 'note-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'alpha',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'note-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'beta',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ],
      currentBoardId: 'default',
      selectedIds: ['note-1', 'note-2'],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 2 },
    });
  });

  it('moveNote 只更新位置，不刷新 updatedAt，也不调度持久化', () => {
    const saveSpy = vi.fn(async () => undefined);
    useStore.setState({ saveToDisk: saveSpy });

    useStore.getState().moveNote('note-1', 110, 210);
    vi.advanceTimersByTime(3000);

    const note = useStore.getState().notes.find((item) => item.id === 'note-1');
    expect(note?.x).toBe(110);
    expect(note?.y).toBe(210);
    expect(note?.updatedAt).toBe(100);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('moveSelectedNotes 只更新选中便签位置，不刷新 updatedAt，也不调度持久化', () => {
    const saveSpy = vi.fn(async () => undefined);
    useStore.setState({ saveToDisk: saveSpy });

    useStore.getState().moveSelectedNotes(15, -5, 'note-1');
    vi.advanceTimersByTime(3000);

    const first = useStore.getState().notes.find((item) => item.id === 'note-1');
    const second = useStore.getState().notes.find((item) => item.id === 'note-2');

    expect(first?.x).toBe(10);
    expect(first?.y).toBe(20);
    expect(first?.updatedAt).toBe(100);
    expect(second?.x).toBe(45);
    expect(second?.y).toBe(35);
    expect(second?.updatedAt).toBe(200);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('finalizeLayoutChange 只刷新受影响便签并立即持久化一次', async () => {
    const saveSpy = vi.fn(async () => undefined);
    useStore.setState({ saveToDisk: saveSpy });

    vi.setSystemTime(new Date('2026-03-19T10:00:00.000Z'));
    useStore.getState().finalizeLayoutChange(['note-1', 'note-1']);
    await flushMicrotasks();

    const first = useStore.getState().notes.find((item) => item.id === 'note-1');
    const second = useStore.getState().notes.find((item) => item.id === 'note-2');
    const expectedTimestamp = new Date('2026-03-19T10:00:00.000Z').getTime();

    expect(first?.updatedAt).toBe(expectedTimestamp);
    expect(second?.updatedAt).toBe(200);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('显式置顶后通过最终提交点刷新 updatedAt 并持久化', async () => {
    const saveSpy = vi.fn(async () => undefined);
    useStore.setState({ saveToDisk: saveSpy });

    vi.setSystemTime(new Date('2026-03-19T10:05:00.000Z'));
    useStore.getState().bringToFront('note-1');
    useStore.getState().finalizeLayoutChange(['note-1']);
    await flushMicrotasks();

    const note = useStore.getState().notes.find((item) => item.id === 'note-1');
    const expectedTimestamp = new Date('2026-03-19T10:05:00.000Z').getTime();

    expect(note?.z).toBe(3);
    expect(useStore.getState().config.maxZ).toBe(3);
    expect(note?.updatedAt).toBe(expectedTimestamp);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('arrangeNotes 会通过统一最终提交点刷新 updatedAt 并立即持久化', async () => {
    const saveSpy = vi.fn(async () => undefined);
    useStore.setState({ saveToDisk: saveSpy, selectedIds: [] });

    vi.setSystemTime(new Date('2026-03-19T10:10:00.000Z'));
    useStore.getState().arrangeNotes(100, 120);
    await flushMicrotasks();

    const first = useStore.getState().notes.find((item) => item.id === 'note-1');
    const second = useStore.getState().notes.find((item) => item.id === 'note-2');
    const expectedTimestamp = new Date('2026-03-19T10:10:00.000Z').getTime();

    expect(first?.x).toBe(100);
    expect(first?.y).toBe(120);
    expect(first?.updatedAt).toBe(expectedTimestamp);
    expect(second?.updatedAt).toBe(expectedTimestamp);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

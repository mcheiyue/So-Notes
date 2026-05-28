import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('./db', () => ({
  db: {
    saveWAL: vi.fn(async () => true),
    loadWAL: vi.fn(async () => undefined),
    clearWAL: vi.fn(async () => undefined),
  },
}));

vi.mock('../utils/fileSystem', () => ({
  saveFile: vi.fn(async () => true),
  openFile: vi.fn(async () => null),
}));

import { useStore } from './useStore';
import { db } from './db';
import { openFile } from '../utils/fileSystem';
import { invoke } from '@tauri-apps/api/core';
import { createEmptyNormalizedNotesState, denormalizeNotes, normalizeNotes } from './normalization';
import { STORAGE_SCHEMA_VERSION } from './types';
import { LAYOUT } from '../constants/layout';
import { registerActiveNoteDragFinalizer } from '../utils/activeNoteDrag';
import { parseSmartPaste } from '../utils/smartPaste';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const getNote = (id: string) => useStore.getState().notesById[id];

describe('v1.4.0 StorageData 演进契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
  });

  it('读取旧版数据时补齐存储元信息，并忽略 UI 与 Viewport 字段', async () => {
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      notes: [{
        id: 'legacy-note',
        boardId: 'legacy-board',
        x: 10,
        y: 20,
        title: '旧数据',
        content: '应正常读取',
        color: '#FFFFFF',
        z: 3,
        createdAt: 100,
        updatedAt: 123,
      }],
      boards: [{ id: 'legacy-board', name: '旧看板', icon: '📦', createdAt: 90 }],
      currentBoardId: 'legacy-board',
      config: { version: 2, maxZ: 3, themeMode: 'system' },
      viewMode: 'TRASH',
      selectedIds: ['legacy-note'],
      viewport: { x: 999, y: 888, w: 777, h: 666 },
    }));

    await useStore.getState().init();

    const state = useStore.getState();
    expect(state.currentBoardId).toBe('legacy-board');
    expect(state.notesById['legacy-note']?.title).toBe('旧数据');
    expect(state.viewMode).toBe('BOARD');
    expect(state.selectedIds).toEqual([]);
    expect(state.viewport.x).not.toBe(999);

    const savedWal = vi.mocked(db.saveWAL).mock.calls[0]?.[0];
    expect(savedWal).toMatchObject({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: 123,
    });
  });
});

describe('useStore 布局持久化契约', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);

    useStore.setState({
      ...normalizeNotes([
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
      ]),
      currentBoardId: 'default',
      selectedIds: ['note-1', 'note-2'],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 2 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moveNote 只更新位置，不刷新 updatedAt，也不调度持久化', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    useStore.getState().moveNote('note-1', 110, 210);
    vi.advanceTimersByTime(3000);

    const note = getNote('note-1');
    expect(note?.x).toBe(110);
    expect(note?.y).toBe(210);
    expect(note?.updatedAt).toBe(100);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('moveSelectedNotes 只更新选中便签位置，不刷新 updatedAt，也不调度持久化', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    useStore.getState().moveSelectedNotes(15, -5, 'note-1');
    vi.advanceTimersByTime(3000);

    const first = getNote('note-1');
    const second = getNote('note-2');

    expect(first?.x).toBe(10);
    expect(first?.y).toBe(20);
    expect(first?.updatedAt).toBe(100);
    expect(second?.x).toBe(45);
    expect(second?.y).toBe(35);
    expect(second?.updatedAt).toBe(200);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('finalizeLayoutChange 只刷新受影响便签并通过 debounce 持久化', async () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    vi.setSystemTime(new Date('2026-03-19T10:00:00.000Z'));
    useStore.getState().finalizeLayoutChange(['note-1', 'note-1']);

    const first = getNote('note-1');
    const second = getNote('note-2');
    const expectedTimestamp = new Date('2026-03-19T10:00:00.000Z').getTime();

    expect(first?.updatedAt).toBe(expectedTimestamp);
    expect(second?.updatedAt).toBe(200);
    expect(saveSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('显式置顶后通过最终提交点刷新 updatedAt 并通过 debounce 持久化', async () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    vi.setSystemTime(new Date('2026-03-19T10:05:00.000Z'));
    useStore.getState().bringToFront('note-1');
    useStore.getState().finalizeLayoutChange(['note-1']);

    const note = getNote('note-1');
    const expectedTimestamp = new Date('2026-03-19T10:05:00.000Z').getTime();

    expect(note?.z).toBe(3);
    expect(useStore.getState().config.maxZ).toBe(3);
    expect(note?.updatedAt).toBe(expectedTimestamp);
    expect(saveSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('arrangeNotes 会通过统一最终提交点刷新 updatedAt 并通过 debounce 持久化', async () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy, selectedIds: [] });

    vi.setSystemTime(new Date('2026-03-19T10:10:00.000Z'));
    useStore.getState().arrangeNotes(100, 120);

    const first = getNote('note-1');
    const second = getNote('note-2');
    const expectedTimestamp = new Date('2026-03-19T10:10:00.000Z').getTime();

    expect(first?.x).toBe(100);
    expect(first?.y).toBe(120);
    expect(first?.updatedAt).toBe(expectedTimestamp);
    expect(second?.updatedAt).toBe(expectedTimestamp);
    expect(saveSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('arrangeNotes 对折叠便签使用 36px 高度估算下一行起点', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'note-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '折叠',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          collapsed: true,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'note-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: '下一行',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 500, h: 720 },
    });

    useStore.getState().arrangeNotes(100, 120);

    expect(getNote('note-1')?.y).toBe(120);
    expect(getNote('note-2')?.y).toBe(120 + LAYOUT.NOTE_COLLAPSED_HEIGHT + 20);
  });

  it('arrangeNotes 对无显式高度的展开便签使用 100px 最小高度估算下一行起点', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'note-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '展开',
          content: 'a',
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
          title: '下一行',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 500, h: 720 },
    });

    useStore.getState().arrangeNotes(100, 120);

    expect(getNote('note-1')?.y).toBe(120);
    expect(getNote('note-2')?.y).toBe(120 + LAYOUT.NOTE_MIN_HEIGHT + 20);
  });

  it('arrangeNotes 对显式高度的展开便签使用真实高度估算下一行起点', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'note-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '高便签',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          height: 180,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'note-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: '下一行',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 500, h: 720 },
    });

    useStore.getState().arrangeNotes(100, 120);

    expect(getNote('note-1')?.y).toBe(120);
    expect(getNote('note-2')?.y).toBe(120 + 180 + 20);
  });

  it('arrangeNotes 支持按更新时间从近到远排列', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'old-note',
          boardId: 'default',
          x: 10,
          y: 10,
          title: '旧便签',
          content: 'old',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'new-note',
          boardId: 'default',
          x: 600,
          y: 600,
          title: '新便签',
          content: 'new',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 900,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 900, h: 720 },
    });

    useStore.getState().arrangeNotes(100, 120, 'updatedAt');

    expect(getNote('new-note')).toMatchObject({ x: 100, y: 120 });
    expect(getNote('old-note')).toMatchObject({ x: 420, y: 120 });
  });

  it('arrangeNotes 支持按颜色顺序简单分组排列', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'blue-note',
          boardId: 'default',
          x: 10,
          y: 10,
          title: '蓝色',
          content: 'blue',
          color: '#dbeafe',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'white-note',
          boardId: 'default',
          x: 600,
          y: 600,
          title: '白色',
          content: 'white',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 900, h: 720 },
    });

    useStore.getState().arrangeNotes(100, 120, 'color');

    expect(getNote('white-note')).toMatchObject({ x: 100, y: 120 });
    expect(getNote('blue-note')).toMatchObject({ x: 420, y: 120 });
  });

  it('arrangeNotes 记录最近一次归拢前位置并支持一次性撤销', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    useStore.getState().arrangeNotes(100, 120);

    const toast = useStore.getState().arrangeUndoToast;
    expect(toast?.action).toBe('arrange');
    expect(toast?.noteCount).toBe(2);
    expect(toast?.positions).toEqual([
      { id: 'note-1', x: 10, y: 20 },
      { id: 'note-2', x: 30, y: 40 },
    ]);
    expect(getNote('note-1')).toMatchObject({ x: 100, y: 120 });
    expect(getNote('note-2')).toMatchObject({ x: 420, y: 120 });

    const undone = useStore.getState().undoLastArrange();

    expect(undone).toBe(true);
    expect(useStore.getState().arrangeUndoToast).toBeNull();
    expect(getNote('note-1')).toMatchObject({ x: 10, y: 20 });
    expect(getNote('note-2')).toMatchObject({ x: 30, y: 40 });

    vi.advanceTimersByTime(3000);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('dismissArrangeUndoToast 只关闭最近一次归拢提示，不移动便签', () => {
    useStore.getState().arrangeNotes(100, 120);
    expect(useStore.getState().arrangeUndoToast).not.toBeNull();

    useStore.getState().dismissArrangeUndoToast();

    expect(useStore.getState().arrangeUndoToast).toBeNull();
    expect(getNote('note-1')).toMatchObject({ x: 100, y: 120 });
    expect(getNote('note-2')).toMatchObject({ x: 420, y: 120 });
  });

  it('mergeSelectedNotes 按画布坐标合并并只选中新便签', () => {
    const saveSpy = vi.fn(async () => true);
    vi.setSystemTime(new Date('2026-03-19T10:30:00.000Z'));
    useStore.setState({ saveToDisk: saveSpy });

    const mergedId = useStore.getState().mergeSelectedNotes();
    const state = useStore.getState();

    expect(mergedId).toBeTruthy();
    expect(state.selectedIds).toEqual([mergedId]);
    expect(state.notesById[mergedId!]).toMatchObject({
      boardId: 'default',
      x: 10,
      y: 20,
      content: 'alpha\n\nbeta',
      z: 3,
    });
    expect(state.notesById['note-1']).toBeDefined();
    expect(state.notesById['note-2']).toBeDefined();
    expect(state.arrangeUndoToast).toMatchObject({
      action: 'merge',
      noteCount: 2,
      createdIds: [mergedId],
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('undoLastArrange 可撤销合并结果且保留原便签', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    const mergedId = useStore.getState().mergeSelectedNotes();
    saveSpy.mockClear();

    const undone = useStore.getState().undoLastArrange();
    const state = useStore.getState();

    expect(undone).toBe(true);
    expect(mergedId).toBeTruthy();
    expect(state.notesById[mergedId!]).toBeUndefined();
    expect(state.notesById['note-1']).toBeDefined();
    expect(state.notesById['note-2']).toBeDefined();
    expect(state.arrangeUndoToast).toBeNull();
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('splitNoteByParagraph 按空行拆分并保留原便签内容', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      saveToDisk: saveSpy,
      notesById: {
        ...useStore.getState().notesById,
        'note-1': {
          ...useStore.getState().notesById['note-1'],
          content: '第一段\n\n第二段\n\n第三段',
        },
      },
    });

    const selectedIds = useStore.getState().splitNoteByParagraph('note-1');
    const state = useStore.getState();

    expect(selectedIds).toHaveLength(4);
    expect(selectedIds[0]).toBe('note-1');
    expect(state.notesById['note-1'].content).toBe('第一段\n\n第二段\n\n第三段');
    expect(state.notesById[selectedIds[1]]).toMatchObject({ content: '第一段', x: 42, y: 48 });
    expect(state.notesById[selectedIds[2]]).toMatchObject({ content: '第二段', x: 74, y: 76 });
    expect(state.notesById[selectedIds[3]]).toMatchObject({ content: '第三段', x: 106, y: 104 });
    expect(state.selectedIds).toEqual(selectedIds);
    expect(state.recentlyCreatedIds).toEqual(selectedIds.slice(1));
    expect(state.arrangeUndoToast).toMatchObject({
      action: 'split',
      noteCount: 3,
      createdIds: selectedIds.slice(1),
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('undoLastArrange 可撤销按段拆分新增结果且不改原便签', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      saveToDisk: saveSpy,
      notesById: {
        ...useStore.getState().notesById,
        'note-1': {
          ...useStore.getState().notesById['note-1'],
          content: '第一段\n\n第二段',
        },
      },
    });

    const selectedIds = useStore.getState().splitNoteByParagraph('note-1');
    saveSpy.mockClear();

    const undone = useStore.getState().undoLastArrange();
    const state = useStore.getState();

    expect(undone).toBe(true);
    expect(state.notesById['note-1'].content).toBe('第一段\n\n第二段');
    selectedIds.slice(1).forEach((id) => {
      expect(state.notesById[id]).toBeUndefined();
    });
    expect(state.arrangeUndoToast).toBeNull();
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('arrangeNotes 显式指定 board 作用域时忽略单选并整理当前看板全部便签', () => {
    useStore.setState({ selectedIds: ['note-1'] });

    useStore.getState().arrangeNotes(100, 120, 'position', 'board');

    expect(getNote('note-1')).toMatchObject({ x: 100, y: 120 });
    expect(getNote('note-2')).toMatchObject({ x: 420, y: 120 });
  });

  it('mergeSelectedNotes 跨看板选中时返回 null 且不执行合并', () => {
    useStore.setState({
      ...normalizeNotes([
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
          id: 'note-cross',
          boardId: 'other-board',
          x: 50,
          y: 60,
          title: 'C',
          content: 'cross',
          color: '#FFFFFF',
          z: 3,
          createdAt: 300,
          updatedAt: 300,
        },
      ]),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'other-board', name: '其他板', icon: '📋', createdAt: 1 },
      ],
      selectedIds: ['note-1', 'note-cross'],
      config: { ...useStore.getState().config, maxZ: 3 },
    });

    const result = useStore.getState().mergeSelectedNotes();

    expect(result).toBeNull();
    expect(useStore.getState().notesById['note-1']).toBeDefined();
    expect(useStore.getState().notesById['note-cross']).toBeDefined();
    expect(useStore.getState().arrangeUndoToast).toBeNull();
  });

  it('undoLastArrange 撤销合并时完整恢复原始便签内容与坐标', () => {
    const saveSpy = vi.fn(async () => true);
    vi.setSystemTime(new Date('2026-03-19T11:00:00.000Z'));
    useStore.setState({ saveToDisk: saveSpy });

    const mergedId = useStore.getState().mergeSelectedNotes();
    expect(mergedId).toBeTruthy();
    saveSpy.mockClear();

    const undone = useStore.getState().undoLastArrange();
    const state = useStore.getState();

    expect(undone).toBe(true);
    expect(state.notesById[mergedId!]).toBeUndefined();
    expect(state.notesById['note-1']).toBeDefined();
    expect(state.notesById['note-1']).toMatchObject({
      x: 10,
      y: 20,
      content: 'alpha',
      boardId: 'default',
    });
    expect(state.notesById['note-2']).toBeDefined();
    expect(state.notesById['note-2']).toMatchObject({
      x: 30,
      y: 40,
      content: 'beta',
      boardId: 'default',
    });
    expect(state.arrangeUndoToast).toBeNull();
    expect(state.selectedIds).toEqual(['note-1', 'note-2']);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('undoLastArrange 撤销拆分时完整恢复原始便签', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      saveToDisk: saveSpy,
      notesById: {
        ...useStore.getState().notesById,
        'note-1': {
          ...useStore.getState().notesById['note-1'],
          content: '第一段\n\n第二段\n\n第三段',
        },
      },
    });

    const selectedIds = useStore.getState().splitNoteByParagraph('note-1');
    expect(selectedIds).toHaveLength(4);
    saveSpy.mockClear();

    const undone = useStore.getState().undoLastArrange();
    const state = useStore.getState();

    expect(undone).toBe(true);
    expect(state.notesById['note-1']).toBeDefined();
    expect(state.notesById['note-1']).toMatchObject({
      content: '第一段\n\n第二段\n\n第三段',
      x: 10,
      y: 20,
      boardId: 'default',
    });
    selectedIds.slice(1).forEach((id) => {
      expect(state.notesById[id]).toBeUndefined();
    });
    expect(state.arrangeUndoToast).toBeNull();
    expect(state.selectedIds).toEqual(['note-1', 'note-2']);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useStore 导入契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      viewMode: 'BOARD',
      selectedIds: ['legacy-selection'],
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('导入不支持版本时短路，不修改状态也不触发持久化', async () => {
    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      version: 999,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: { boards: [], notes: [] },
    }));

    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    const result = await useStore.getState().importFromFile();

    expect(result.status).toBe('error');
    expect(useStore.getState().boards).toHaveLength(1);
    expect(useStore.getState().allNoteIds).toHaveLength(0);
    expect(useStore.getState().currentBoardId).toBe('default');
    expect(useStore.getState().selectedIds).toEqual(['legacy-selection']);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('全量导入采用附加式写入并切换到导入包主板', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: {
        boards: [{ id: 'backup-board', name: '主板', icon: '💼', createdAt: 10 }],
        notes: [{
          id: 'backup-note',
          boardId: 'backup-board',
          x: 10,
          y: 20,
          title: '备份标题',
          content: '备份内容',
          color: '#FFFFFF',
          z: 2,
          createdAt: 11,
          updatedAt: 12,
        }],
        currentBoardId: 'backup-board',
      },
    }));

    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();
    const notes = denormalizeNotes(state);

    expect(result.status).toBe('success');
    expect(state.boards).toHaveLength(2);
    expect(state.boards[1].id).toBe('11111111-1111-4111-8111-111111111111');
    expect(state.boards[1].name).toBe('主板（导入）');
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('22222222-2222-4222-8222-222222222222');
    expect(notes[0].boardId).toBe('11111111-1111-4111-8111-111111111111');
    expect(state.currentBoardId).toBe('11111111-1111-4111-8111-111111111111');
    expect(state.selectedIds).toEqual([]);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(result.summary?.skippedNotesCount).toBe(0);
  });

  it('单板导入默认不抢占当前看板，但会附加写入并清空选择', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444');

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'SINGLE_BOARD',
      timestamp: 1,
      payload: {
        boards: [{ id: 'single-board', name: '灵感板', icon: '💡', createdAt: 10 }],
        notes: [{
          id: 'single-note',
          boardId: 'single-board',
          x: 30,
          y: 40,
          title: '灵感',
          content: '内容',
          color: '#FFFFFF',
          z: 2,
          createdAt: 11,
          updatedAt: 12,
        }],
        currentBoardId: 'single-board',
      },
    }));

    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy, currentBoardId: 'default', selectedIds: ['note-x'] });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();

    expect(result.status).toBe('success');
    expect(state.boards).toHaveLength(2);
    expect(state.boards[1].id).toBe('33333333-3333-4333-8333-333333333333');
    expect(state.currentBoardId).toBe('default');
    expect(state.selectedIds).toEqual([]);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('多看板导入时保持导入相对顺序，并整体追加到本地末尾', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('abababab-abab-4bab-8bab-abababababab')
      .mockReturnValueOnce('cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd');

    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'local-2', name: '本地二号', icon: '📚', createdAt: 1 },
      ],
      currentBoardId: 'default',
    });

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: {
        boards: [
          { id: 'import-a', name: '导入甲', icon: '🅰️', createdAt: 10 },
          { id: 'import-b', name: '导入乙', icon: '🅱️', createdAt: 11 },
        ],
        notes: [],
        currentBoardId: 'import-a',
      },
    }));

    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();

    expect(result.status).toBe('success');
    expect(state.boards.map(board => board.name)).toEqual(['主板', '本地二号', '导入甲', '导入乙']);
    expect(state.currentBoardId).toBe('abababab-abab-4bab-8bab-abababababab');
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('导入时允许跳过异常便签，并在结果中返回部分成功摘要', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('55555555-aaaa-4555-8555-555555555555')
      .mockReturnValueOnce('66666666-bbbb-4666-8666-666666666666');

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: {
        boards: [{ id: 'import-board', name: '导入板', icon: '📥', createdAt: 10 }],
        notes: [
          {
            id: 'valid-note',
            boardId: 'import-board',
            x: 10,
            y: 20,
            title: '有效便签',
            content: '有效内容',
            color: '#FFFFFF',
            z: 2,
            createdAt: 11,
            updatedAt: 12,
          },
          {
            id: 'broken-note',
            boardId: 'import-board',
            title: '损坏便签',
          },
        ],
        currentBoardId: 'import-board',
      },
    }));

    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();
    const notes = denormalizeNotes(state);

    expect(result.status).toBe('success');
    expect(result.message).toBe('导入完成，已跳过 1 条异常便签。');
    expect(result.summary?.skippedNotesCount).toBe(1);
    expect(result.summary?.issues[0].code).toBe('INVALID_NOTE');
    expect(state.boards).toHaveLength(2);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('66666666-bbbb-4666-8666-666666666666');
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('旧版备份导入会完成兼容迁移，并返回迁移摘要', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('12121212-1212-4121-8121-121212121212')
      .mockReturnValueOnce('34343434-3434-4343-8343-343434343434');

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      source: 'so-notes',
      type: 'FULL_BACKUP',
      payload: {
        notes: [
          {
            content: '旧版便签',
            createdAt: 123,
          },
        ],
      },
    }));

    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();
    const notes = denormalizeNotes(state);

    expect(result.status).toBe('success');
    expect(result.message).toBe('已导入旧版备份，并按当前规则完成兼容处理。');
    expect(result.summary).toMatchObject({
      createdDefaultBoard: true,
      migratedNotesCount: 1,
      skippedNotesCount: 0,
    });
    expect(result.summary?.issues.map(issue => issue.code)).toEqual([
      'CREATED_DEFAULT_BOARD',
      'MIGRATED_NOTE',
      'FALLBACK_CURRENT_BOARD',
    ]);
    expect(state.boards).toHaveLength(2);
    expect(notes).toHaveLength(1);
    expect(state.currentBoardId).toBe('12121212-1212-4121-8121-121212121212');
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('旧版迁移自动补建默认看板时，该看板作为导入批次整体追加到本地末尾', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('56565656-5656-4565-8565-565656565656')
      .mockReturnValueOnce('78787878-7878-4787-8787-787878787878');

    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'local-2', name: '本地二号', icon: '📚', createdAt: 1 },
      ],
      currentBoardId: 'default',
    });

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      source: 'so-notes',
      type: 'FULL_BACKUP',
      payload: {
        notes: [
          {
            content: '旧版便签',
            createdAt: 123,
          },
        ],
      },
    }));

    const saveSpy = vi.fn(async () => true);
    useStore.setState({ saveToDisk: saveSpy });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();

    expect(result.status).toBe('success');
    expect(state.boards.map(board => board.name)).toEqual(['主板', '本地二号', '主板 (Main)']);
    expect(state.currentBoardId).toBe('56565656-5656-4565-8565-565656565656');
    expect(result.summary?.createdDefaultBoard).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('写入本地存储失败时回滚到导入前状态', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('77777777-cccc-4777-8777-777777777777')
      .mockReturnValueOnce('88888888-dddd-4888-8888-888888888888');

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: {
        boards: [{ id: 'rollback-board', name: '回滚板', icon: '↩️', createdAt: 10 }],
        notes: [{
          id: 'rollback-note',
          boardId: 'rollback-board',
          x: 10,
          y: 20,
          title: '回滚',
          content: '需要回滚',
          color: '#FFFFFF',
          z: 2,
          createdAt: 11,
          updatedAt: 12,
        }],
        currentBoardId: 'rollback-board',
      },
    }));

    const originalState = useStore.getState();
    const saveSpy = vi.fn(async () => false);
    useStore.setState({ saveToDisk: saveSpy, selectedIds: ['keep-me'] });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();

    expect(result.status).toBe('error');
    expect(result.code).toBe('SAVE_FAILED');
    expect(result.rolledBack).toBe(true);
    expect(state.boards).toEqual(originalState.boards);
    expect(denormalizeNotes(state)).toEqual(denormalizeNotes(originalState));
    expect(state.currentBoardId).toBe(originalState.currentBoardId);
    expect(state.selectedIds).toEqual(['keep-me']);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('WAL 写入失败时也会回滚到导入前状态', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('99999999-eeee-4999-8999-999999999999')
      .mockReturnValueOnce('aaaaaaaa-ffff-4aaa-8aaa-aaaaaaaaaaaa');

    vi.mocked(openFile).mockResolvedValue(JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: {
        boards: [{ id: 'wal-board', name: 'WAL板', icon: '💾', createdAt: 10 }],
        notes: [{
          id: 'wal-note',
          boardId: 'wal-board',
          x: 10,
          y: 20,
          title: 'WAL失败',
          content: '需要回滚',
          color: '#FFFFFF',
          z: 2,
          createdAt: 11,
          updatedAt: 12,
        }],
        currentBoardId: 'wal-board',
      },
    }));

    vi.mocked(db.saveWAL)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const originalState = useStore.getState();
    useStore.setState({ selectedIds: ['keep-me'] });

    const result = await useStore.getState().importFromFile();
    const state = useStore.getState();

    expect(result.status).toBe('error');
    expect(result.code).toBe('SAVE_FAILED');
    expect(result.rolledBack).toBe(true);
    expect(state.boards).toEqual(originalState.boards);
    expect(denormalizeNotes(state)).toEqual(denormalizeNotes(originalState));
    expect(state.currentBoardId).toBe(originalState.currentBoardId);
    expect(state.selectedIds).toEqual(['keep-me']);
    expect(db.saveWAL).toHaveBeenCalledTimes(2);
  });
});

describe('useStore 保存状态可见性契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('保存成功后写入 saved 状态并记录 lastSavedAt', async () => {
    vi.mocked(db.saveWAL).mockResolvedValueOnce(true);
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, io_duration_ms: 0, retries: 0 });

    const saved = await useStore.getState().saveToDisk();
    const state = useStore.getState();

    expect(saved).toBe(true);
    expect(state.isSaving).toBe(false);
    expect(state.saveStatus).toBe('saved');
    expect(state.saveError).toBeNull();
    expect(typeof state.lastSavedAt).toBe('number');
  });

  it('WAL 保存失败时写入 error 状态与错误文案', async () => {
    vi.mocked(db.saveWAL).mockResolvedValueOnce(false);

    const saved = await useStore.getState().saveToDisk();
    const state = useStore.getState();

    expect(saved).toBe(false);
    expect(state.isSaving).toBe(false);
    expect(state.saveStatus).toBe('error');
    expect(state.saveError).toBe('写入本地缓存失败，未保存到磁盘。');
  });

  it('磁盘写入异常时写入 error 状态并透传错误消息', async () => {
    vi.mocked(db.saveWAL).mockResolvedValueOnce(true);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('磁盘写入失败'));

    const saved = await useStore.getState().saveToDisk();
    const state = useStore.getState();

    expect(saved).toBe(false);
    expect(state.isSaving).toBe(false);
    expect(state.saveStatus).toBe('error');
    expect(state.saveError).toBe('磁盘写入失败');
  });

  it('Rust 侧返回 success:false 时写入 error 状态', async () => {
    vi.mocked(db.saveWAL).mockResolvedValueOnce(true);
    vi.mocked(invoke).mockResolvedValueOnce({ success: false, error: 'File locked by another process', io_duration_ms: 0, retries: 3 });

    const saved = await useStore.getState().saveToDisk();
    const state = useStore.getState();

    expect(saved).toBe(false);
    expect(state.isSaving).toBe(false);
    expect(state.saveStatus).toBe('error');
    expect(state.saveError).toBe('File locked by another process');
  });
});

describe('v1.3.0 并发与代际契约', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('切换看板前先触发活动普通便签拖拽收口', () => {
    const activeDragFinalizer = vi.fn();
    const saveSpy = vi.fn(async () => true);
    registerActiveNoteDragFinalizer(activeDragFinalizer);

    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-2', name: '二号板', icon: '🧩', createdAt: 1 },
      ],
      currentBoardId: 'default',
      viewport: { x: 24, y: 36, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 1 },
      saveToDisk: saveSpy,
    });

    useStore.getState().switchBoard('board-2');

    expect(activeDragFinalizer).toHaveBeenCalledTimes(1);
    expect(activeDragFinalizer).toHaveBeenCalledWith('switch-board');
    expect(useStore.getState().currentBoardId).toBe('board-2');
    expect(useStore.getState().boards.find((board) => board.id === 'default')?.viewport).toEqual({ x: 24, y: 36 });
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('switchBoard 目标看板无 viewport 时恢复到 0,0', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-2', name: '二号板', icon: '🧩', createdAt: 1 },
      ],
      currentBoardId: 'default',
      viewport: { x: 24, y: 36, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 1 },
      saveToDisk: saveSpy,
    });

    useStore.getState().switchBoard('board-2');

    expect(useStore.getState().viewport.x).toBe(0);
    expect(useStore.getState().viewport.y).toBe(0);
  });

  it('switchBoard 目标看板有 viewport 时恢复到该 viewport', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-2', name: '二号板', icon: '🧩', createdAt: 1, viewport: { x: 500, y: 600 } },
      ],
      currentBoardId: 'default',
      viewport: { x: 24, y: 36, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 1 },
      saveToDisk: saveSpy,
    });

    useStore.getState().switchBoard('board-2');

    expect(useStore.getState().viewport.x).toBe(500);
    expect(useStore.getState().viewport.y).toBe(600);
  });

  it('新建空白便签后选中新便签并标记创建反馈', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
      saveToDisk: saveSpy,
    });

    useStore.getState().addNote(16, 24);

    const state = useStore.getState();
    const [noteId] = state.allNoteIds;
    expect(state.selectedIds).toEqual([noteId]);
    expect(state.recentlyCreatedIds).toEqual([noteId]);
    expect(state.noteHighlights[noteId]?.reason).toBe('created');
    expect(state.notesById[noteId]).toMatchObject({ x: 16, y: 24, content: '' });
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('临时定位高亮支持按 token 精确清理，避免旧计时器清掉新高亮', () => {
    vi.setSystemTime(new Date('2026-03-19T10:20:00.000Z'));
    useStore.getState().markNoteHighlights(['note-1'], 'located');
    const firstHighlight = useStore.getState().noteHighlights['note-1'];

    vi.setSystemTime(new Date('2026-03-19T10:20:01.000Z'));
    useStore.getState().markNoteHighlights(['note-1'], 'edited');
    const secondHighlight = useStore.getState().noteHighlights['note-1'];

    expect(firstHighlight?.reason).toBe('located');
    expect(secondHighlight?.reason).toBe('edited');
    expect(secondHighlight?.token).not.toBe(firstHighlight?.token);

    useStore.getState().clearNoteHighlight('note-1', firstHighlight?.token);
    expect(useStore.getState().noteHighlights['note-1']).toEqual(secondHighlight);

    useStore.getState().clearNoteHighlight('note-1', secondHighlight?.token);
    expect(useStore.getState().noteHighlights['note-1']).toBeUndefined();
  });

  it('临时高亮即使没有便签组件挂载也会按时过期清理', () => {
    useStore.getState().markNoteHighlights(['note-1'], 'located');
    expect(useStore.getState().noteHighlights['note-1']?.reason).toBe('located');

    vi.advanceTimersByTime(1100);

    expect(useStore.getState().noteHighlights['note-1']).toBeUndefined();
  });

  it('软删除便签时同步清理临时高亮与新建反馈', () => {
    useStore.getState().addNote(100, 100);
    const state = useStore.getState();
    const [noteId] = state.allNoteIds;

    useStore.getState().markRecentlyCreated([noteId]);
    expect(useStore.getState().recentlyCreatedIds).toEqual([noteId]);
    expect(useStore.getState().noteHighlights[noteId]?.reason).toBe('created');

    useStore.getState().deleteNote(noteId);

    expect(useStore.getState().recentlyCreatedIds).toEqual([]);
    expect(useStore.getState().noteHighlights[noteId]).toBeUndefined();
  });

  it('永久删除便签时同步清理临时高亮与新建反馈', () => {
    useStore.getState().addNote(100, 100);
    const state = useStore.getState();
    const [noteId] = state.allNoteIds;

    useStore.getState().markRecentlyCreated([noteId]);

    useStore.getState().deleteNotePermanently(noteId);

    expect(useStore.getState().recentlyCreatedIds).toEqual([]);
    expect(useStore.getState().noteHighlights[noteId]).toBeUndefined();
    expect(useStore.getState().notesById[noteId]).toBeUndefined();
  });

  it('批量创建智能粘贴便签后选中新便签并只保存一次', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 3 },
      saveToDisk: saveSpy,
    });

    const ids = useStore.getState().addNotesWithContentBatch([
      { x: 10, y: 20, content: ' Alpha ' },
      { x: 30, y: 40, content: 'Beta' },
    ]);

    const state = useStore.getState();
    expect(ids).toHaveLength(2);
    expect(state.selectedIds).toEqual(ids);
    expect(state.recentlyCreatedIds).toEqual(ids);
    expect(state.noteHighlights[ids[0]]?.reason).toBe('created');
    expect(state.noteHighlights[ids[1]]?.reason).toBe('created');
    expect(state.allNoteIds).toEqual(ids);
    expect(state.config.maxZ).toBe(5);
    expect(state.notesById[ids[0]].content).toBe('Alpha');
    expect(state.notesById[ids[1]].z).toBe(5);
    expect(saveSpy).toHaveBeenCalledTimes(1);

    useStore.getState().clearRecentlyCreated(ids[0]);
    expect(useStore.getState().recentlyCreatedIds).toEqual([ids[1]]);
  });

  it('智能粘贴拆分气泡确认后复用原便签并追加剩余便签', () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 3 },
      saveToDisk: saveSpy,
    });

    const [noteId] = useStore.getState().addNotesWithContentBatch([
      { x: 10, y: 20, content: '第一行\n第二行\n第三行' },
    ]);
    saveSpy.mockClear();

    useStore.getState().openSmartPasteSplitPanel({
      noteId,
      result: parseSmartPaste('第一行\n第二行\n第三行'),
    });

    const selectedIds = useStore.getState().applySmartPasteSplit('split-lines');
    const state = useStore.getState();

    expect(selectedIds).toHaveLength(3);
    expect(selectedIds[0]).toBe(noteId);
    expect(state.notesById[noteId].content).toBe('第一行');
    expect(state.notesById[selectedIds[1]]).toMatchObject({ content: '第二行', x: 42, y: 48 });
    expect(state.notesById[selectedIds[2]]).toMatchObject({ content: '第三行', x: 74, y: 76 });
    expect(state.selectedIds).toEqual(selectedIds);
    expect(state.recentlyCreatedIds).toEqual(selectedIds);
    expect(state.smartPasteSplitPanel).toBeNull();
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('旧 generationId ACK 不得覆盖最新 UI 状态', async () => {
    vi.mocked(db.saveWAL).mockResolvedValue(true);

    let resolveGen1: () => void;
    const gen1Promise = new Promise<void>((res) => { resolveGen1 = res; });
    
    vi.mocked(invoke).mockImplementation(async (_cmd, args: unknown) => {
      const generationId = typeof args === 'object' && args !== null && 'generationId' in args
        ? (args as { generationId?: unknown }).generationId
        : undefined;

      if (generationId === 1) {
        await gen1Promise;
      }
      return { success: true, io_duration_ms: 0, retries: 0 };
    });

    useStore.getState().saveToDisk(); 
    await flushMicrotasks(); 
    
    const stateAfterGen1 = useStore.getState();
    expect(stateAfterGen1.saveStatus).toBe('saving');
    expect(stateAfterGen1.saveGenerationId).toBe(1);

    useStore.getState().saveToDisk(); 
    await flushMicrotasks();
    
    const stateAfterGen2Sent = useStore.getState();
    expect(stateAfterGen2Sent.saveGenerationId).toBe(2);
    
    resolveGen1!();
    await flushMicrotasks();
    
    const finalState = useStore.getState();
    expect(finalState.saveStatus).toBe('saved');
    expect(finalState.saveGenerationId).toBe(2);
  });

  it('高频保存下内存与状态不崩溃', async () => {
    vi.mocked(db.saveWAL).mockResolvedValue(true);
    vi.mocked(invoke).mockResolvedValue({ success: true, io_duration_ms: 0, retries: 0 });

    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(useStore.getState().saveToDisk());
    }
    
    await Promise.all(promises);
    await flushMicrotasks();

    const state = useStore.getState();
    expect(state.saveStatus).toBe('saved');
    expect(state.isSaving).toBe(false);
    expect(state.saveGenerationId).toBe(20);
  });
});

describe('v1.3.9 TRASH 安全收口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('setViewMode 切到 TRASH 时清理残留状态', () => {
    useStore.setState({
      selectedIds: ['note-1', 'note-2'],
      contextMenu: { isOpen: true, x: 100, y: 200, type: 'NOTE', targetId: 'note-1' },
      smartPasteSplitPanel: { noteId: 'note-1', result: { kind: 'single', source: 'text', options: [] } },
      stickyDrag: { id: 'note-1', offsetX: 5, offsetY: 10, status: 'active' },
      interaction: { isPanMode: true, isDragging: false, edgePush: { top: false, bottom: false, left: false, right: false } },
      isSpotlightOpen: true,
      isQuickCaptureOpen: true,
    });

    useStore.getState().setViewMode('TRASH');
    const state = useStore.getState();

    expect(state.viewMode).toBe('TRASH');
    expect(state.selectedIds).toEqual([]);
    expect(state.contextMenu).toEqual({ isOpen: false, x: 0, y: 0, type: 'CANVAS' });
    expect(state.smartPasteSplitPanel).toBeNull();
    expect(state.stickyDrag).toEqual({ id: null, offsetX: 0, offsetY: 0, status: 'active' });
    expect(state.interaction.isPanMode).toBe(false);
    expect(state.isSpotlightOpen).toBe(false);
    expect(state.isQuickCaptureOpen).toBe(false);
  });

  it('setViewMode 切到 BOARD 时只清 selectedIds，不触碰其他状态', () => {
    useStore.setState({
      viewMode: 'TRASH',
      selectedIds: ['note-1'],
      isSpotlightOpen: true,
      isQuickCaptureOpen: true,
    });

    useStore.getState().setViewMode('BOARD');
    const state = useStore.getState();

    expect(state.viewMode).toBe('BOARD');
    expect(state.selectedIds).toEqual([]);
    expect(state.isSpotlightOpen).toBe(true);
    expect(state.isQuickCaptureOpen).toBe(true);
  });
});

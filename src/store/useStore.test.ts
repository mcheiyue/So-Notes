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
import type { AttachmentRef } from './types';
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

  it('finalizeLayoutChange 只刷新受影响便签，不再直接调度持久化', async () => {
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

    vi.advanceTimersByTime(3000);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('显式置顶后通过最终提交点刷新 updatedAt，不再直接调度持久化', async () => {
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

    vi.advanceTimersByTime(3000);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('arrangeNotes 会通过统一最终提交点刷新 updatedAt，不再直接调度持久化', async () => {
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

    vi.advanceTimersByTime(3000);
    expect(saveSpy).not.toHaveBeenCalled();
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

  it('arrangeNotes 对显式高度的展开便签使用默认最小高度估算下一行起点', () => {
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
    expect(getNote('note-2')?.y).toBe(120 + LAYOUT.NOTE_MIN_HEIGHT + 20);
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

  it('mergeSelectedNotes 按画布坐标合并，移除原便签并只选中新便签', () => {
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
    expect(state.notesById['note-1']).toBeUndefined();
    expect(state.notesById['note-2']).toBeUndefined();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('splitNoteByParagraph 按空行拆分，移除原便签并返回拆分后便签', () => {
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

    const createdIds = useStore.getState().splitNoteByParagraph('note-1');
    const state = useStore.getState();

    expect(createdIds).toHaveLength(3);
    expect(state.notesById['note-1']).toBeUndefined();
    expect(state.notesById[createdIds[0]]).toMatchObject({ content: '第一段', x: 42, y: 48 });
    expect(state.notesById[createdIds[1]]).toMatchObject({ content: '第二段', x: 74, y: 76 });
    expect(state.notesById[createdIds[2]]).toMatchObject({ content: '第三段', x: 106, y: 104 });
    expect(state.selectedIds).toEqual(createdIds);
    expect(state.recentlyCreatedIds).toEqual(createdIds);
    expect(saveSpy).not.toHaveBeenCalled();
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
  });

  it('mergeSelectedNotes 撤销会移除合并便签并还原原便签，重做会再次合并', () => {
    vi.setSystemTime(new Date('2026-03-19T10:30:00.000Z'));
    const mergedId = useStore.getState().mergeSelectedNotes();
    expect(mergedId).toBeTruthy();
    expect(useStore.getState().notesById['note-1']).toBeUndefined();
    expect(useStore.getState().notesById['note-2']).toBeUndefined();

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById[mergedId!]).toBeUndefined();
    expect(useStore.getState().notesById['note-1']).toBeDefined();
    expect(useStore.getState().notesById['note-2']).toBeDefined();
    expect(useStore.getState().notesById['note-1'].content).toBe('alpha');
    expect(useStore.getState().notesById['note-2'].content).toBe('beta');

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById[mergedId!]).toBeDefined();
    expect(useStore.getState().notesById[mergedId!].content).toBe('alpha\n\nbeta');
    expect(useStore.getState().notesById['note-1']).toBeUndefined();
    expect(useStore.getState().notesById['note-2']).toBeUndefined();
  });

  it('splitNoteByParagraph 撤销会移除拆分便签并还原原便签，重做会再次拆分', () => {
    useStore.setState({
      notesById: {
        ...useStore.getState().notesById,
        'note-1': {
          ...useStore.getState().notesById['note-1'],
          content: '第一段\n\n第二段',
        },
      },
    });

    const createdIds = useStore.getState().splitNoteByParagraph('note-1');
    expect(createdIds).toHaveLength(2);
    expect(useStore.getState().notesById['note-1']).toBeUndefined();

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['note-1']).toBeDefined();
    expect(useStore.getState().notesById['note-1'].content).toBe('第一段\n\n第二段');
    expect(useStore.getState().notesById[createdIds[0]]).toBeUndefined();
    expect(useStore.getState().notesById[createdIds[1]]).toBeUndefined();

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['note-1']).toBeUndefined();
    expect(useStore.getState().notesById[createdIds[0]]).toBeDefined();
    expect(useStore.getState().notesById[createdIds[1]]).toBeDefined();
    expect(useStore.getState().notesById[createdIds[0]].content).toBe('第一段');
    expect(useStore.getState().notesById[createdIds[1]].content).toBe('第二段');
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
      'RENAMED_BOARD',
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
    expect(state.boards.map(board => board.name)).toEqual(['主板', '本地二号', '主板（导入）']);
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
    expect(saveSpy).not.toHaveBeenCalled();
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
    expect(saveSpy).not.toHaveBeenCalled();
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
    expect(saveSpy).not.toHaveBeenCalled();

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
    expect(saveSpy).not.toHaveBeenCalled();
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

  it('setViewMode 切到 TRASH 时保存当前视口到看板', () => {
    useStore.setState({
      viewMode: 'BOARD',
      viewport: { x: 150, y: 250, w: 1280, h: 720 },
    });

    useStore.getState().setViewMode('TRASH');

    const board = useStore.getState().boards.find(b => b.id === 'default');
    expect(board?.viewport).toEqual({ x: 150, y: 250 });
  });

  it('setViewMode 切到 TRASH 再切回 BOARD 时恢复保存的视口', () => {
    useStore.setState({
      viewMode: 'BOARD',
      viewport: { x: 150, y: 250, w: 1280, h: 720 },
    });

    useStore.getState().setViewMode('TRASH');

    const board = useStore.getState().boards.find(b => b.id === 'default');
    expect(board?.viewport).toEqual({ x: 150, y: 250 });

    useStore.getState().setViewMode('BOARD');

    const state = useStore.getState();
    expect(state.viewport.x).toBe(150);
    expect(state.viewport.y).toBe(250);
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

describe('v1.4.3 领域撤销/重做契约', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
      domainHistory: useStore.getState().domainHistory,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('撤销 addNote 会从 normalized/layout 中移除便签且不进入废纸篓', () => {
    useStore.getState().addNote(100, 200);

    const state = useStore.getState();
    const [noteId] = state.allNoteIds;
    expect(noteId).toBeDefined();
    expect(state.notesById[noteId]).toBeDefined();
    expect(state.layoutNotesById[noteId]).toBeDefined();

    const undone = useStore.getState().undoDomainChange();
    expect(undone).toBe(true);

    const afterUndo = useStore.getState();
    expect(afterUndo.notesById[noteId]).toBeUndefined();
    expect(afterUndo.layoutNotesById[noteId]).toBeUndefined();
    expect(afterUndo.allNoteIds).not.toContain(noteId);
    expect(afterUndo.boardNoteIds['default'] ?? []).not.toContain(noteId);
  });

  it('撤销后重做会恢复同一个便签 id', () => {
    useStore.getState().addNote(100, 200);

    const [noteId] = useStore.getState().allNoteIds;
    const originalNote = { ...useStore.getState().notesById[noteId] };

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById[noteId]).toBeUndefined();

    const redone = useStore.getState().redoDomainChange();
    expect(redone).toBe(true);

    const afterRedo = useStore.getState();
    expect(afterRedo.notesById[noteId]).toBeDefined();
    expect(afterRedo.notesById[noteId]).toMatchObject({
      id: originalNote.id,
      x: originalNote.x,
      y: originalNote.y,
      content: originalNote.content,
      color: originalNote.color,
      boardId: originalNote.boardId,
    });
    expect(afterRedo.allNoteIds).toContain(noteId);
    expect(afterRedo.layoutNotesById[noteId]).toBeDefined();
  });

  it('addNoteWithContent 撤销/重做会保留正文与 id', () => {
    useStore.getState().addNoteWithContent(50, 60, 'hello world');

    const [noteId] = useStore.getState().allNoteIds;
    expect(useStore.getState().notesById[noteId].content).toBe('hello world');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById[noteId]).toBeUndefined();

    useStore.getState().redoDomainChange();
    const afterRedo = useStore.getState();
    expect(afterRedo.notesById[noteId]).toBeDefined();
    expect(afterRedo.notesById[noteId].content).toBe('hello world');
    expect(afterRedo.notesById[noteId].x).toBe(50);
    expect(afterRedo.notesById[noteId].y).toBe(60);
  });

  it('changeColor 撤销/重做会同步切换 note 与 layout 颜色', () => {
    useStore.setState({
      ...normalizeNotes([{
        id: 'color-note',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '改色',
        content: 'c',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    useStore.getState().changeColor('color-note', '#dbeafe');

    expect(useStore.getState().notesById['color-note'].color).toBe('#dbeafe');
    expect(useStore.getState().layoutNotesById['color-note'].color).toBe('#dbeafe');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['color-note'].color).toBe('#FFFFFF');
    expect(useStore.getState().layoutNotesById['color-note'].color).toBe('#FFFFFF');

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['color-note'].color).toBe('#dbeafe');
    expect(useStore.getState().layoutNotesById['color-note'].color).toBe('#dbeafe');
  });

  it('changeColor 设置相同颜色不会创建历史记录', () => {
    useStore.setState({
      ...normalizeNotes([{
        id: 'same-color-note',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '同色',
        content: 'c',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    const historyBefore = useStore.getState().domainHistory;
    const undoCountBefore = historyBefore.undoStack.length;

    useStore.getState().changeColor('same-color-note', '#FFFFFF');

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
    expect(useStore.getState().undoDomainChange()).toBe(false);
  });

  it('toggleCollapse 撤销/重做会恢复折叠状态', () => {
    useStore.setState({
      ...normalizeNotes([{
        id: 'collapse-note',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '折叠',
        content: 'c',
        color: '#FFFFFF',
        z: 1,
        collapsed: false,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    expect(useStore.getState().notesById['collapse-note'].collapsed).toBe(false);

    useStore.getState().toggleCollapse('collapse-note');
    expect(useStore.getState().notesById['collapse-note'].collapsed).toBe(true);

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['collapse-note'].collapsed).toBe(false);

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['collapse-note'].collapsed).toBe(true);
  });

  it('撤销后执行新操作会清空 redo 栈', () => {
    useStore.getState().addNote(10, 20);
    const [firstId] = useStore.getState().allNoteIds;

    useStore.getState().undoDomainChange();
    expect(useStore.getState().domainHistory.redoStack.length).toBe(1);

    useStore.getState().addNote(30, 40);
    expect(useStore.getState().domainHistory.redoStack.length).toBe(0);

    const redone = useStore.getState().redoDomainChange();
    expect(redone).toBe(false);
    expect(useStore.getState().notesById[firstId]).toBeUndefined();
  });

  it('撤销 addNote 会清理悬挂的选区与新建高亮引用', () => {
    useStore.getState().addNote(100, 200);

    const [noteId] = useStore.getState().allNoteIds;
    expect(useStore.getState().selectedIds).toEqual([noteId]);
    expect(useStore.getState().recentlyCreatedIds).toEqual([noteId]);

    useStore.getState().undoDomainChange();

    expect(useStore.getState().selectedIds).not.toContain(noteId);
    expect(useStore.getState().recentlyCreatedIds).not.toContain(noteId);
    expect(useStore.getState().noteHighlights[noteId]).toBeUndefined();
  });

  it('历史为空时 undoDomainChange 返回 false', () => {
    expect(useStore.getState().undoDomainChange()).toBe(false);
  });

  it('redo 栈为空时 redoDomainChange 返回 false', () => {
    expect(useStore.getState().redoDomainChange()).toBe(false);
  });

  it('undoDomainChange patch 失败时不消费历史栈且领域状态不变', () => {
    useStore.getState().addNote(100, 200);
    const [noteId] = useStore.getState().allNoteIds;

    useStore.setState((state) => {
      delete state.notesById[noteId];
      state.allNoteIds = [];
      state.boardNoteIds = {};
      state.layoutNotesById = {};
    });

    const undoLen = useStore.getState().domainHistory.undoStack.length;
    const redoLen = useStore.getState().domainHistory.redoStack.length;
    const snapshot = useStore.getState().notesById;

    expect(useStore.getState().undoDomainChange()).toBe(false);
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoLen);
    expect(useStore.getState().domainHistory.redoStack.length).toBe(redoLen);
    expect(useStore.getState().notesById).toBe(snapshot);
  });

  it('redoDomainChange patch 失败时不消费历史栈且领域状态不变', () => {
    useStore.getState().addNote(100, 200);
    const [noteId] = useStore.getState().allNoteIds;
    const note = { ...useStore.getState().notesById[noteId] };

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById[noteId]).toBeUndefined();

    useStore.setState((state) => {
      state.notesById[noteId] = note;
      state.allNoteIds = [noteId];
      state.boardNoteIds = { default: [noteId] };
      state.layoutNotesById[noteId] = { id: noteId, x: note.x, y: note.y, boardId: note.boardId, deletedAt: null, color: note.color };
    });

    const undoLen = useStore.getState().domainHistory.undoStack.length;
    const redoLen = useStore.getState().domainHistory.redoStack.length;
    const snapshot = useStore.getState().notesById;

    expect(useStore.getState().redoDomainChange()).toBe(false);
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoLen);
    expect(useStore.getState().domainHistory.redoStack.length).toBe(redoLen);
    expect(useStore.getState().notesById).toBe(snapshot);
  });

  it('commitNoteTextEdit 标题编辑撤销/重做会恢复 title 与 updatedAt', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([{
        id: 'edit-title',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '旧标题',
        content: '内容不变',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    useStore.getState().updateTitle('edit-title', '新标题');
    expect(useStore.getState().notesById['edit-title'].title).toBe('新标题');

    useStore.getState().commitNoteTextEdit('edit-title', '旧标题', '内容不变', 100);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);
    expect(useStore.getState().domainHistory.undoStack[0].label).toBe('edit-text');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['edit-title'].title).toBe('旧标题');
    expect(useStore.getState().notesById['edit-title'].content).toBe('内容不变');
    expect(useStore.getState().notesById['edit-title'].updatedAt).toBe(100);

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['edit-title'].title).toBe('新标题');
    expect(useStore.getState().notesById['edit-title'].content).toBe('内容不变');
    expect(useStore.getState().notesById['edit-title'].updatedAt).toBe(new Date('2026-05-01T10:05:00.000Z').getTime());
  });

  it('commitNoteTextEdit 内容编辑撤销/重做会恢复 content 与 updatedAt', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([{
        id: 'edit-content',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '标题不变',
        content: '旧内容',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    useStore.getState().updateNote('edit-content', '新内容');

    useStore.getState().commitNoteTextEdit('edit-content', '标题不变', '旧内容', 100);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['edit-content'].content).toBe('旧内容');
    expect(useStore.getState().notesById['edit-content'].updatedAt).toBe(100);

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['edit-content'].content).toBe('新内容');
    expect(useStore.getState().notesById['edit-content'].updatedAt).toBe(new Date('2026-05-01T10:05:00.000Z').getTime());
  });

  it('commitNoteTextEdit 同时修改标题和内容时创建单条历史', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([{
        id: 'edit-both',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '旧标题',
        content: '旧内容',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    useStore.getState().updateTitle('edit-both', '新标题');
    useStore.getState().updateNote('edit-both', '新内容');

    useStore.getState().commitNoteTextEdit('edit-both', '旧标题', '旧内容', 100);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['edit-both']).toMatchObject({
      title: '旧标题',
      content: '旧内容',
      updatedAt: 100,
    });

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['edit-both']).toMatchObject({
      title: '新标题',
      content: '新内容',
    });
  });

  it('commitNoteTextEdit 标题和内容均未改变时不创建历史', () => {
    useStore.setState({
      ...normalizeNotes([{
        id: 'no-change',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '不变',
        content: '不变',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().commitNoteTextEdit('no-change', '不变', '不变', 100);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
    expect(useStore.getState().undoDomainChange()).toBe(false);
  });

  it('commitNoteTextEdit 便签不存在时不创建历史', () => {
    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().commitNoteTextEdit('non-existent', 'a', 'b', 100);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('单便签移动后 finalizeLayoutChange 创建位置历史并支持撤销/重做', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([{
        id: 'move-note',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '移动',
        content: 'm',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    useStore.getState().captureMoveSnapshot({
      'move-note': { x: 10, y: 20, updatedAt: 100 },
    });

    useStore.getState().moveNote('move-note', 100, 200);

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    useStore.getState().finalizeLayoutChange(['move-note']);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);
    expect(useStore.getState().domainHistory.undoStack[0].label).toBe('move-note');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['move-note'].x).toBe(10);
    expect(useStore.getState().notesById['move-note'].y).toBe(20);
    expect(useStore.getState().notesById['move-note'].updatedAt).toBe(100);
    expect(useStore.getState().layoutNotesById['move-note'].x).toBe(10);
    expect(useStore.getState().layoutNotesById['move-note'].y).toBe(20);

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['move-note'].x).toBe(100);
    expect(useStore.getState().notesById['move-note'].y).toBe(200);
    expect(useStore.getState().notesById['move-note'].updatedAt).toBe(new Date('2026-05-01T10:05:00.000Z').getTime());
    expect(useStore.getState().layoutNotesById['move-note'].x).toBe(100);
    expect(useStore.getState().layoutNotesById['move-note'].y).toBe(200);
  });

  it('moveNote 单独调用不会创建历史，直到 finalizeLayoutChange', () => {
    useStore.setState({
      ...normalizeNotes([{
        id: 'move-only',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '仅移动',
        content: 'm',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().moveNote('move-only', 100, 200);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
    expect(useStore.getState().notesById['move-only'].x).toBe(100);
    expect(useStore.getState().notesById['move-only'].y).toBe(200);
    expect(useStore.getState().notesById['move-only'].updatedAt).toBe(100);
  });

  it('无快照时 finalizeLayoutChange 不创建移动历史', () => {
    useStore.setState({
      ...normalizeNotes([{
        id: 'no-snapshot',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '无快照',
        content: 'm',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().finalizeLayoutChange(['no-snapshot']);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('位置未变时 finalizeLayoutChange 不创建移动历史', () => {
    useStore.setState({
      ...normalizeNotes([{
        id: 'same-pos',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '同位',
        content: 'm',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100,
        updatedAt: 100,
      }]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    useStore.getState().captureMoveSnapshot({
      'same-pos': { x: 10, y: 20, updatedAt: 100 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().finalizeLayoutChange(['same-pos']);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('多便签移动的 finalizeLayoutChange 不创建移动历史', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'multi-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'multi-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    useStore.getState().captureMoveSnapshot({
      'multi-1': { x: 10, y: 20, updatedAt: 100 },
      'multi-2': { x: 30, y: 40, updatedAt: 200 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().finalizeLayoutChange(['multi-1', 'multi-2']);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('多便签移动后会清理快照，避免后续单便签提交误入历史', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'stale-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'stale-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    useStore.getState().captureMoveSnapshot({
      'stale-1': { x: 10, y: 20, updatedAt: 100 },
      'stale-2': { x: 30, y: 40, updatedAt: 200 },
    });

    useStore.getState().moveNote('stale-1', 100, 200);
    useStore.getState().moveNote('stale-2', 300, 400);
    useStore.getState().finalizeLayoutChange(['stale-1', 'stale-2']);
    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);
    expect(useStore.getState().domainHistory.undoStack[0].label).toBe('move-selected-notes');
    expect(useStore.getState().domainHistory.undoStack[0].undo.type).toBe('compound-patch');

    useStore.getState().moveNote('stale-1', 120, 220);
    useStore.getState().finalizeLayoutChange(['stale-1']);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);
  });

  it('多便签移动后 finalizeLayoutChange 创建 compound-patch 历史并支持撤销/重做', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'mm-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'mm-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    useStore.getState().captureMoveSnapshot({
      'mm-1': { x: 10, y: 20, updatedAt: 100 },
      'mm-2': { x: 30, y: 40, updatedAt: 200 },
    });

    useStore.getState().moveNote('mm-1', 100, 200);
    useStore.getState().moveNote('mm-2', 300, 400);

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    useStore.getState().finalizeLayoutChange(['mm-1', 'mm-2']);

    const undoStack = useStore.getState().domainHistory.undoStack;
    expect(undoStack.length).toBe(1);
    expect(undoStack[0].label).toBe('move-selected-notes');
    expect(undoStack[0].undo.type).toBe('compound-patch');
    expect(undoStack[0].redo.type).toBe('compound-patch');

    const expectedUpdatedAt = new Date('2026-05-01T10:05:00.000Z').getTime();

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['mm-1'].x).toBe(10);
    expect(useStore.getState().notesById['mm-1'].y).toBe(20);
    expect(useStore.getState().notesById['mm-1'].updatedAt).toBe(100);
    expect(useStore.getState().layoutNotesById['mm-1'].x).toBe(10);
    expect(useStore.getState().layoutNotesById['mm-1'].y).toBe(20);
    expect(useStore.getState().notesById['mm-2'].x).toBe(30);
    expect(useStore.getState().notesById['mm-2'].y).toBe(40);
    expect(useStore.getState().notesById['mm-2'].updatedAt).toBe(200);
    expect(useStore.getState().layoutNotesById['mm-2'].x).toBe(30);
    expect(useStore.getState().layoutNotesById['mm-2'].y).toBe(40);

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['mm-1'].x).toBe(100);
    expect(useStore.getState().notesById['mm-1'].y).toBe(200);
    expect(useStore.getState().notesById['mm-1'].updatedAt).toBe(expectedUpdatedAt);
    expect(useStore.getState().layoutNotesById['mm-1'].x).toBe(100);
    expect(useStore.getState().layoutNotesById['mm-1'].y).toBe(200);
    expect(useStore.getState().notesById['mm-2'].x).toBe(300);
    expect(useStore.getState().notesById['mm-2'].y).toBe(400);
    expect(useStore.getState().notesById['mm-2'].updatedAt).toBe(expectedUpdatedAt);
    expect(useStore.getState().layoutNotesById['mm-2'].x).toBe(300);
    expect(useStore.getState().layoutNotesById['mm-2'].y).toBe(400);
  });

  it('多便签 finalize 中已在废纸篓的便签被跳过', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'md-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'md-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    useStore.getState().captureMoveSnapshot({
      'md-1': { x: 10, y: 20, updatedAt: 100 },
      'md-2': { x: 30, y: 40, updatedAt: 200 },
    });

    useStore.getState().moveNote('md-1', 100, 200);
    useStore.getState().deleteNote('md-2');

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    useStore.getState().finalizeLayoutChange(['md-1', 'md-2']);

    const undoStack = useStore.getState().domainHistory.undoStack;
    const moveEntry = undoStack.find((e) => e.label === 'move-selected-notes');
    expect(moveEntry).toBeDefined();

    const undoPatch = moveEntry!.undo as { type: 'compound-patch'; patches: Array<{ type: string; noteId: string; x: number; y: number }> };
    expect(undoPatch.patches).toHaveLength(1);
    expect(undoPatch.patches[0].noteId).toBe('md-1');
    expect(undoPatch.patches[0].x).toBe(10);
    expect(undoPatch.patches[0].y).toBe(20);
  });

  it('多便签 finalize 中无快照的便签被跳过', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'mn-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'mn-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    useStore.getState().captureMoveSnapshot({
      'mn-1': { x: 10, y: 20, updatedAt: 100 },
    });

    useStore.getState().moveNote('mn-1', 100, 200);
    useStore.getState().moveNote('mn-2', 300, 400);

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    useStore.getState().finalizeLayoutChange(['mn-1', 'mn-2']);

    const undoStack = useStore.getState().domainHistory.undoStack;
    expect(undoStack.length).toBe(1);
    expect(undoStack[0].label).toBe('move-selected-notes');

    const undoPatch = undoStack[0].undo as { type: 'compound-patch'; patches: Array<{ type: string; noteId: string }> };
    expect(undoPatch.patches).toHaveLength(1);
    expect(undoPatch.patches[0].noteId).toBe('mn-1');
  });

  it('多便签 finalize 所有便签位置均未变时不创建历史', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'ms-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'ms-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    useStore.getState().captureMoveSnapshot({
      'ms-1': { x: 10, y: 20, updatedAt: 100 },
      'ms-2': { x: 30, y: 40, updatedAt: 200 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().finalizeLayoutChange(['ms-1', 'ms-2']);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('多便签 finalize 后快照被清理，后续单便签 finalize 不会误入历史', () => {
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'mc-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'mc-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    useStore.getState().captureMoveSnapshot({
      'mc-1': { x: 10, y: 20, updatedAt: 100 },
      'mc-2': { x: 30, y: 40, updatedAt: 200 },
    });

    useStore.getState().moveNote('mc-1', 100, 200);
    useStore.getState().moveNote('mc-2', 300, 400);
    useStore.getState().finalizeLayoutChange(['mc-1', 'mc-2']);

    useStore.getState().moveNote('mc-1', 120, 220);
    const undoCountBeforeSecond = useStore.getState().domainHistory.undoStack.length;
    useStore.getState().finalizeLayoutChange(['mc-1']);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBeforeSecond);
  });

  it('跨看板重做时自动切换视口到便签所在看板并居中', () => {
    useStore.setState({
      boards: [
        { id: 'default', name: '默认', icon: '📋', createdAt: 1 },
        { id: 'board-a', name: '看板A', icon: '📌', createdAt: 2 },
      ],
      currentBoardId: 'board-a',
      viewMode: 'BOARD',
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 0 },
    });

    useStore.getState().addNote(500, 600);
    const noteId = useStore.getState().allNoteIds[useStore.getState().allNoteIds.length - 1];

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById[noteId]).toBeUndefined();

    useStore.getState().switchBoard('default');
    expect(useStore.getState().currentBoardId).toBe('default');

    useStore.getState().redoDomainChange();

    expect(useStore.getState().currentBoardId).toBe('board-a');
    expect(useStore.getState().notesById[noteId]).toBeDefined();
    expect(useStore.getState().selectedIds).toContain(noteId);
    expect(useStore.getState().viewport.x).toBeCloseTo(500 + 260 / 2 - 1280 / 2);
    expect(useStore.getState().viewport.y).toBeCloseTo(600 + 100 / 2 - 720 / 2);
  });

  it('同看板可见便签撤销时不强制重置视口', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'visible-note',
          boardId: 'default',
          x: 100,
          y: 120,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
      ]),
      currentBoardId: 'default',
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    const beforeViewport = useStore.getState().viewport;
    useStore.getState().changeColor('visible-note', '#FEF3C7');
    useStore.getState().undoDomainChange();

    expect(useStore.getState().viewport).toEqual(beforeViewport);
    expect(useStore.getState().selectedIds).toEqual(['visible-note']);
    expect(useStore.getState().notesById['visible-note'].color).toBe('#FFFFFF');
  });
});

describe('v1.4.4 软删除与废纸篓恢复领域撤销/重做契约', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'sd-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '便签甲',
          content: 'alpha',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'sd-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: '便签乙',
          content: 'beta',
          color: '#dbeafe',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
        {
          id: 'sd-3',
          boardId: 'default',
          x: 50,
          y: 60,
          title: '便签丙',
          content: 'gamma',
          color: '#fef9c3',
          z: 3,
          createdAt: 300,
          updatedAt: 300,
        },
      ]),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-b', name: '乙板', icon: '📋', createdAt: 1 },
      ],
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 3 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deleteNote 软删除创建历史条目并支持撤销/重做', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');

    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().layoutNotesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);
    expect(useStore.getState().domainHistory.undoStack[0].label).toBe('soft-delete-note');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().layoutNotesById['sd-1'].deletedAt).toBeNull();

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().layoutNotesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
  });

  it('deleteNote 对已在废纸篓中的便签不创建历史', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');
    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);

    useStore.getState().deleteNote('sd-1');
    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);
  });

  it('deleteSelectedNotes 将多张便签合并为一条 compound-patch 历史', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.setState({ selectedIds: ['sd-1', 'sd-2'] });

    useStore.getState().deleteSelectedNotes();

    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().domainHistory.undoStack.length).toBe(1);
    expect(useStore.getState().domainHistory.undoStack[0].label).toBe('soft-delete-selected');
    expect(useStore.getState().domainHistory.undoStack[0].undo.type).toBe('compound-patch');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBeNull();

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
  });

  it('deleteSelectedNotes 选中中含已在废纸篓的便签时跳过并只处理有效便签', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');

    useStore.setState({ selectedIds: ['sd-1', 'sd-2'] });
    useStore.getState().deleteSelectedNotes();

    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().domainHistory.undoStack.length).toBe(2);
  });

  it('deleteSelectedNotes 无有效便签时不创建历史但仍清空选区', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');
    useStore.getState().deleteNote('sd-2');

    useStore.setState({ selectedIds: ['sd-1', 'sd-2'] });
    useStore.getState().deleteSelectedNotes();

    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().domainHistory.undoStack.length).toBe(2);
  });

  it('restoreNote 恢复便签创建历史条目并支持撤销/重做', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');

    const maxZBeforeRestore = useStore.getState().config.maxZ;

    useStore.getState().restoreNote('sd-1');

    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-1'].z).toBe(maxZBeforeRestore + 1);
    expect(useStore.getState().layoutNotesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(2);
    expect(useStore.getState().domainHistory.undoStack[1].label).toBe('restore-note');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().layoutNotesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-1'].z).toBe(maxZBeforeRestore + 1);
  });

  it('restoreNote 对不在废纸篓中的便签不创建历史', () => {
    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;
    useStore.getState().restoreNote('sd-1');
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('restoreSelectedTrash 合并为一条 compound-patch 历史并支持撤销/重做', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');
    useStore.getState().deleteNote('sd-2');

    useStore.getState().restoreSelectedTrash(['sd-1', 'sd-2']);

    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBeNull();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(3);
    expect(useStore.getState().domainHistory.undoStack[2].label).toBe('restore-selected-trash');
    expect(useStore.getState().domainHistory.undoStack[2].undo.type).toBe('compound-patch');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBeNull();
  });

  it('restoreSelectedTrash 无有效废纸篓便签时不创建历史', () => {
    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;
    useStore.getState().restoreSelectedTrash(['sd-1', 'sd-2']);
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('restoreAllTrash 合并为一条 compound-patch 历史并支持撤销/重做', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');
    useStore.getState().deleteNote('sd-2');
    useStore.getState().deleteNote('sd-3');

    useStore.getState().restoreAllTrash();

    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-3'].deletedAt).toBeNull();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(4);
    expect(useStore.getState().domainHistory.undoStack[3].label).toBe('restore-all-trash');
    expect(useStore.getState().domainHistory.undoStack[3].undo.type).toBe('compound-patch');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().notesById['sd-3'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-3'].deletedAt).toBeNull();
  });

  it('restoreAllTrash 废纸篓为空时不创建历史', () => {
    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;
    useStore.getState().restoreAllTrash();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('deleteNotePermanently 不创建领域历史', () => {
    useStore.getState().deleteNote('sd-1');
    const undoCountAfterSoftDelete = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().deleteNotePermanently('sd-1');

    expect(useStore.getState().notesById['sd-1']).toBeUndefined();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountAfterSoftDelete);
  });

  it('deleteSelectedPermanently 不创建领域历史', () => {
    useStore.getState().deleteNote('sd-1');
    useStore.getState().deleteNote('sd-2');
    const undoCountAfterSoftDelete = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().deleteSelectedPermanently(['sd-1', 'sd-2']);

    expect(useStore.getState().notesById['sd-1']).toBeUndefined();
    expect(useStore.getState().notesById['sd-2']).toBeUndefined();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountAfterSoftDelete);
  });

  it('emptyTrash 不创建领域历史', () => {
    useStore.getState().deleteNote('sd-1');
    useStore.getState().deleteNote('sd-2');
    const undoCountAfterSoftDelete = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().emptyTrash();

    expect(useStore.getState().notesById['sd-1']).toBeUndefined();
    expect(useStore.getState().notesById['sd-2']).toBeUndefined();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountAfterSoftDelete);
  });

  it('restoreNote 看板已被删除时回退到当前看板，撤销后保持可用看板', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'sd-1',
          boardId: 'board-b',
          x: 10,
          y: 20,
          title: '便签甲',
          content: 'alpha',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
      ]),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-b', name: '乙板', icon: '📋', createdAt: 1 },
      ],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    useStore.getState().deleteNote('sd-1');
    useStore.setState({
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
    });

    useStore.getState().restoreNote('sd-1');

    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-1'].boardId).toBe('default');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());
    expect(useStore.getState().notesById['sd-1'].boardId).toBe('default');
  });

  it('选中便签软删除后通过撤销可恢复到原看板并保留选区清理', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.setState({ selectedIds: ['sd-1', 'sd-2', 'sd-3'] });

    useStore.getState().deleteSelectedNotes();
    expect(useStore.getState().selectedIds).toEqual([]);

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-3'].deletedAt).toBeNull();
    expect(useStore.getState().notesById['sd-1'].boardId).toBe('default');
    expect(useStore.getState().layoutNotesById['sd-1'].deletedAt).toBeNull();
  });

  it('连续软删除和恢复操作在历史栈中正确累积', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    useStore.getState().deleteNote('sd-1');
    useStore.getState().restoreNote('sd-1');
    useStore.getState().deleteNote('sd-2');

    expect(useStore.getState().domainHistory.undoStack.length).toBe(3);

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-2'].deletedAt).toBeNull();

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBe(new Date('2026-06-01T10:00:00.000Z').getTime());

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].deletedAt).toBeNull();
  });

  it('changeSelectedNotesColor 创建 compound-patch 历史并支持撤销/重做', () => {
    useStore.setState({ selectedIds: ['sd-1', 'sd-2'] });

    useStore.getState().changeSelectedNotesColor('#fef9c3');

    expect(useStore.getState().notesById['sd-1'].color).toBe('#fef9c3');
    expect(useStore.getState().notesById['sd-2'].color).toBe('#fef9c3');
    expect(useStore.getState().layoutNotesById['sd-1'].color).toBe('#fef9c3');
    expect(useStore.getState().layoutNotesById['sd-2'].color).toBe('#fef9c3');

    const undoStack = useStore.getState().domainHistory.undoStack;
    expect(undoStack.length).toBe(1);
    expect(undoStack[0].label).toBe('change-selected-color');
    expect(undoStack[0].undo.type).toBe('compound-patch');
    expect(undoStack[0].redo.type).toBe('compound-patch');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].color).toBe('#FFFFFF');
    expect(useStore.getState().notesById['sd-2'].color).toBe('#dbeafe');
    expect(useStore.getState().layoutNotesById['sd-1'].color).toBe('#FFFFFF');
    expect(useStore.getState().layoutNotesById['sd-2'].color).toBe('#dbeafe');

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['sd-1'].color).toBe('#fef9c3');
    expect(useStore.getState().notesById['sd-2'].color).toBe('#fef9c3');
    expect(useStore.getState().layoutNotesById['sd-1'].color).toBe('#fef9c3');
    expect(useStore.getState().layoutNotesById['sd-2'].color).toBe('#fef9c3');
  });

  it('changeSelectedNotesColor 跳过已在废纸篓的便签', () => {
    useStore.getState().deleteNote('sd-2');
    useStore.setState({ selectedIds: ['sd-1', 'sd-2'] });

    useStore.getState().changeSelectedNotesColor('#fef9c3');

    expect(useStore.getState().notesById['sd-1'].color).toBe('#fef9c3');
    expect(useStore.getState().notesById['sd-2'].color).toBe('#dbeafe');

    const colorEntry = useStore.getState().domainHistory.undoStack.find(
      (e) => e.label === 'change-selected-color',
    );
    expect(colorEntry).toBeDefined();
    expect(colorEntry!.undo.type).toBe('compound-patch');
    const undoPatch = colorEntry!.undo as { type: 'compound-patch'; patches: Array<{ type: string; noteId: string; fields: Record<string, unknown> }> };
    expect(undoPatch.patches).toHaveLength(1);
    expect(undoPatch.patches[0].noteId).toBe('sd-1');
    expect(undoPatch.patches[0].fields.color).toBe('#FFFFFF');
  });

  it('changeSelectedNotesColor 跳过颜色相同的便签', () => {
    useStore.setState({ selectedIds: ['sd-1', 'sd-2'] });
    useStore.getState().changeSelectedNotesColor('#dbeafe');

    expect(useStore.getState().notesById['sd-1'].color).toBe('#dbeafe');
    expect(useStore.getState().notesById['sd-2'].color).toBe('#dbeafe');

    const colorEntry = useStore.getState().domainHistory.undoStack.find(
      (e) => e.label === 'change-selected-color',
    );
    expect(colorEntry).toBeDefined();
    const undoPatch = colorEntry!.undo as { type: 'compound-patch'; patches: Array<{ noteId: string }> };
    expect(undoPatch.patches).toHaveLength(1);
    expect(undoPatch.patches[0].noteId).toBe('sd-1');
  });

  it('changeSelectedNotesColor 空选区不创建历史', () => {
    useStore.setState({ selectedIds: [] });
    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().changeSelectedNotesColor('#dbeafe');

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('changeSelectedNotesColor 所有选中便签颜色已相同时不创建历史', () => {
    useStore.setState({ selectedIds: ['sd-1', 'sd-3'] });
    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().changeSelectedNotesColor('#dbeafe');
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore + 1);

    const undoCountAfterFirst = useStore.getState().domainHistory.undoStack.length;
    useStore.getState().changeSelectedNotesColor('#dbeafe');
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountAfterFirst);
  });

  it('changeSelectedNotesColor 选区含不存在的便签时跳过', () => {
    useStore.setState({ selectedIds: ['sd-1', 'nonexistent-id'] });

    useStore.getState().changeSelectedNotesColor('#fef9c3');

    expect(useStore.getState().notesById['sd-1'].color).toBe('#fef9c3');

    const colorEntry = useStore.getState().domainHistory.undoStack.find(
      (e) => e.label === 'change-selected-color',
    );
    expect(colorEntry).toBeDefined();
    const undoPatch = colorEntry!.undo as { type: 'compound-patch'; patches: Array<{ noteId: string }> };
    expect(undoPatch.patches).toHaveLength(1);
    expect(undoPatch.patches[0].noteId).toBe('sd-1');
  });

  it('changeSelectedNotesColor 混合场景只处理有效便签并支持撤销/重做', () => {
    useStore.getState().deleteNote('sd-2');
    useStore.setState({ selectedIds: ['sd-1', 'sd-2', 'sd-3'] });

    useStore.getState().changeSelectedNotesColor('#fef9c3');

    expect(useStore.getState().notesById['sd-1'].color).toBe('#fef9c3');
    expect(useStore.getState().notesById['sd-2'].color).toBe('#dbeafe');
    expect(useStore.getState().notesById['sd-3'].color).toBe('#fef9c3');

    const colorEntry = useStore.getState().domainHistory.undoStack.find(
      (e) => e.label === 'change-selected-color',
    );
    expect(colorEntry).toBeDefined();
    const undoPatch = colorEntry!.undo as { type: 'compound-patch'; patches: Array<{ noteId: string; fields: Record<string, unknown> }> };
    expect(undoPatch.patches).toHaveLength(1);
    expect(undoPatch.patches[0].noteId).toBe('sd-1');
    expect(undoPatch.patches[0].fields.color).toBe('#FFFFFF');

    useStore.getState().undoDomainChange();
    expect(useStore.getState().notesById['sd-1'].color).toBe('#FFFFFF');

    useStore.getState().redoDomainChange();
    expect(useStore.getState().notesById['sd-1'].color).toBe('#fef9c3');
  });

  it('changeSelectedNotesColor 不影响选区与视口状态', () => {
    useStore.setState({ selectedIds: ['sd-1', 'sd-2'] });
    const viewportBefore = useStore.getState().viewport;
    const selectedBefore = useStore.getState().selectedIds;

    useStore.getState().changeSelectedNotesColor('#fef9c3');

    expect(useStore.getState().viewport).toEqual(viewportBefore);
    expect(useStore.getState().selectedIds).toEqual(selectedBefore);

    useStore.getState().undoDomainChange();
    expect(useStore.getState().viewport).toEqual(viewportBefore);
  });
});

describe('v1.4.4 归拢领域撤销/重做契约', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'ar-1',
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
          id: 'ar-2',
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
        {
          id: 'ar-3',
          boardId: 'default',
          x: 50,
          y: 60,
          title: 'C',
          content: 'gamma',
          color: '#dbeafe',
          z: 3,
          createdAt: 300,
          updatedAt: 300,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 3 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arrangeNotes 创建 compound history 条目并支持 undo/redo', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    useStore.getState().arrangeNotes(100, 120);

    const undoStack = useStore.getState().domainHistory.undoStack;
    const arrangeEntry = undoStack.find((e) => e.label === 'arrange-notes');
    expect(arrangeEntry).toBeDefined();
    expect(arrangeEntry!.undo.type).toBe('compound-patch');
    expect(arrangeEntry!.redo.type).toBe('compound-patch');

    const undoPatch = arrangeEntry!.undo as { type: 'compound-patch'; patches: Array<{ type: string; noteId: string; x: number; y: number; updatedAt: number }> };
    expect(undoPatch.patches).toHaveLength(3);
    expect(undoPatch.patches[0]).toMatchObject({ type: 'update-position', noteId: 'ar-1', x: 10, y: 20, updatedAt: 100 });
    expect(undoPatch.patches[1]).toMatchObject({ type: 'update-position', noteId: 'ar-2', x: 30, y: 40, updatedAt: 200 });
    expect(undoPatch.patches[2]).toMatchObject({ type: 'update-position', noteId: 'ar-3', x: 50, y: 60, updatedAt: 300 });

    const expectedUpdatedAt = new Date('2026-06-01T12:00:00.000Z').getTime();
    expect(getNote('ar-1')).toMatchObject({ x: 100, y: 120 });
    expect(getNote('ar-1')?.updatedAt).toBe(expectedUpdatedAt);

    useStore.getState().undoDomainChange();
    expect(getNote('ar-1')).toMatchObject({ x: 10, y: 20, updatedAt: 100 });
    expect(getNote('ar-2')).toMatchObject({ x: 30, y: 40, updatedAt: 200 });
    expect(getNote('ar-3')).toMatchObject({ x: 50, y: 60, updatedAt: 300 });
    expect(useStore.getState().layoutNotesById['ar-1']).toMatchObject({ x: 10, y: 20 });
    expect(useStore.getState().layoutNotesById['ar-2']).toMatchObject({ x: 30, y: 40 });

    useStore.getState().redoDomainChange();
    expect(getNote('ar-1')).toMatchObject({ x: 100, y: 120 });
    expect(getNote('ar-1')?.updatedAt).toBe(expectedUpdatedAt);
    expect(useStore.getState().layoutNotesById['ar-1']).toMatchObject({ x: 100, y: 120 });
  });

  it('arrangeNotes 所有便签位置未变时不创建历史', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'same-1',
          boardId: 'default',
          x: 100,
          y: 120,
          title: 'A',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().arrangeNotes(100, 120);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
    expect(useStore.getState().undoDomainChange()).toBe(false);
  });

  it('arrangeNotes 跳过废纸篓中的便签', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    useStore.getState().deleteNote('ar-2');

    useStore.getState().arrangeNotes(100, 120);

    const arrangeEntry = useStore.getState().domainHistory.undoStack.find((e) => e.label === 'arrange-notes');
    expect(arrangeEntry).toBeDefined();

    const undoPatch = arrangeEntry!.undo as { type: 'compound-patch'; patches: Array<{ noteId: string }> };
    const noteIds = undoPatch.patches.map((p) => p.noteId);
    expect(noteIds).toContain('ar-1');
    expect(noteIds).toContain('ar-3');
    expect(noteIds).not.toContain('ar-2');
  });

  it('arrangeNotes undo/redo 保持 layoutNotesById 一致', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    useStore.getState().arrangeNotes(100, 120);

    for (const id of ['ar-1', 'ar-2', 'ar-3']) {
      expect(useStore.getState().layoutNotesById[id].x).toBe(getNote(id)?.x);
      expect(useStore.getState().layoutNotesById[id].y).toBe(getNote(id)?.y);
    }

    useStore.getState().undoDomainChange();
    for (const id of ['ar-1', 'ar-2', 'ar-3']) {
      expect(useStore.getState().layoutNotesById[id].x).toBe(getNote(id)?.x);
      expect(useStore.getState().layoutNotesById[id].y).toBe(getNote(id)?.y);
    }

    useStore.getState().redoDomainChange();
    for (const id of ['ar-1', 'ar-2', 'ar-3']) {
      expect(useStore.getState().layoutNotesById[id].x).toBe(getNote(id)?.x);
      expect(useStore.getState().layoutNotesById[id].y).toBe(getNote(id)?.y);
    }
  });

  it('arrangeNotes 无有效目标时不创建历史', () => {
    useStore.setState({
      ...normalizeNotes([]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;
    useStore.getState().arrangeNotes(100, 120);

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('arrangeNotes undo 后 redoDomainChange 恢复归拢位置', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    useStore.getState().arrangeNotes(100, 120);

    const arrangedPos = {
      'ar-1': { x: getNote('ar-1')!.x, y: getNote('ar-1')!.y },
      'ar-2': { x: getNote('ar-2')!.x, y: getNote('ar-2')!.y },
    };

    useStore.getState().undoDomainChange();
    expect(getNote('ar-1')).toMatchObject({ x: 10, y: 20 });

    useStore.getState().redoDomainChange();
    expect(getNote('ar-1')).toMatchObject(arrangedPos['ar-1']);
    expect(getNote('ar-2')).toMatchObject(arrangedPos['ar-2']);
    expect(useStore.getState().layoutNotesById['ar-1']).toMatchObject(arrangedPos['ar-1']);
    expect(useStore.getState().layoutNotesById['ar-2']).toMatchObject(arrangedPos['ar-2']);
  });
});

describe('v1.4.4 拆分与合并领域撤销/重做契约', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'sm-1',
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
          id: 'sm-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: 'B',
          content: 'beta',
          color: '#dbeafe',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
        {
          id: 'sm-3',
          boardId: 'default',
          x: 50,
          y: 60,
          title: '',
          content: '第一段\n\n第二段\n\n第三段',
          color: '#fef3c7',
          z: 3,
          createdAt: 300,
          updatedAt: 300,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: ['sm-1', 'sm-2'],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 3 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mergeSelectedNotes 创建 merge-notes history 条目', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    useStore.getState().mergeSelectedNotes();

    const undoStack = useStore.getState().domainHistory.undoStack;
    const mergeEntry = undoStack.find((e) => e.label === 'merge-notes');
    expect(mergeEntry).toBeDefined();
    expect(mergeEntry!.undo.type).toBe('compound-patch');
    expect(mergeEntry!.redo.type).toBe('compound-patch');
  });

  it('mergeSelectedNotes undo 移除合并便签，redo 恢复同一 UUID', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    const mergedId = useStore.getState().mergeSelectedNotes();
    expect(mergedId).toBeTruthy();

    const mergedNote = getNote(mergedId!);
    expect(mergedNote).toBeDefined();
    expect(mergedNote!.content).toBe('alpha\n\nbeta');

    useStore.getState().undoDomainChange();
    expect(getNote(mergedId!)).toBeUndefined();
    expect(getNote('sm-1')).toBeDefined();
    expect(getNote('sm-2')).toBeDefined();

    useStore.getState().redoDomainChange();
    const restored = getNote(mergedId!);
    expect(restored).toBeDefined();
    expect(restored!.id).toBe(mergedId);
    expect(restored!.content).toBe('alpha\n\nbeta');
    expect(restored!.boardId).toBe('default');
  });

  it('mergeSelectedNotes undo/redo 保持 notesById、allNoteIds、boardNoteIds、layoutNotesById 一致', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    const mergedId = useStore.getState().mergeSelectedNotes();
    expect(mergedId).toBeTruthy();

    const afterMerge = useStore.getState();
    expect(afterMerge.notesById[mergedId!]).toBeDefined();
    expect(afterMerge.allNoteIds).toContain(mergedId);
    expect(afterMerge.boardNoteIds['default']).toContain(mergedId);
    expect(afterMerge.layoutNotesById[mergedId!]).toBeDefined();
    expect(afterMerge.layoutNotesById[mergedId!].x).toBe(afterMerge.notesById[mergedId!].x);
    expect(afterMerge.layoutNotesById[mergedId!].y).toBe(afterMerge.notesById[mergedId!].y);

    useStore.getState().undoDomainChange();
    const afterUndo = useStore.getState();
    expect(afterUndo.notesById[mergedId!]).toBeUndefined();
    expect(afterUndo.allNoteIds).not.toContain(mergedId);
    expect(afterUndo.boardNoteIds['default'] ?? []).not.toContain(mergedId);
    expect(afterUndo.layoutNotesById[mergedId!]).toBeUndefined();

    useStore.getState().redoDomainChange();
    const afterRedo = useStore.getState();
    expect(afterRedo.notesById[mergedId!]).toBeDefined();
    expect(afterRedo.allNoteIds).toContain(mergedId);
    expect(afterRedo.boardNoteIds['default']).toContain(mergedId);
    expect(afterRedo.layoutNotesById[mergedId!]).toBeDefined();
    expect(afterRedo.layoutNotesById[mergedId!].x).toBe(afterRedo.notesById[mergedId!].x);
    expect(afterRedo.layoutNotesById[mergedId!].y).toBe(afterRedo.notesById[mergedId!].y);
  });

  it('mergeSelectedNotes 跨看板合并不创建 domainHistory 条目', () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'cross-1',
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
          id: 'cross-2',
          boardId: 'other-board',
          x: 50,
          y: 60,
          title: 'C',
          content: 'cross',
          color: '#FFFFFF',
          z: 2,
          createdAt: 300,
          updatedAt: 300,
        },
      ]),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'other-board', name: '其他板', icon: '📋', createdAt: 1 },
      ],
      selectedIds: ['cross-1', 'cross-2'],
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;
    const result = useStore.getState().mergeSelectedNotes();

    expect(result).toBeNull();
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('splitNoteByParagraph 创建 split-note history 条目', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    useStore.getState().splitNoteByParagraph('sm-3');

    const undoStack = useStore.getState().domainHistory.undoStack;
    const splitEntry = undoStack.find((e) => e.label === 'split-note');
    expect(splitEntry).toBeDefined();
    expect(splitEntry!.undo.type).toBe('compound-patch');
    expect(splitEntry!.redo.type).toBe('compound-patch');
  });

  it('splitNoteByParagraph undo 移除拆分便签，redo 恢复同一 UUID', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    const createdIds = useStore.getState().splitNoteByParagraph('sm-3');
    expect(createdIds).toHaveLength(3);

    createdIds.forEach((id) => {
      expect(getNote(id)).toBeDefined();
    });
    expect(getNote('sm-3')).toBeUndefined();

    useStore.getState().undoDomainChange();
    createdIds.forEach((id) => {
      expect(getNote(id)).toBeUndefined();
    });
    expect(getNote('sm-3')).toBeDefined();

    useStore.getState().redoDomainChange();
    createdIds.forEach((id) => {
      const note = getNote(id);
      expect(note).toBeDefined();
      expect(note!.id).toBe(id);
    });
    expect(getNote('sm-3')).toBeUndefined();
  });

  it('splitNoteByParagraph undo/redo 保持 notesById、allNoteIds、boardNoteIds、layoutNotesById 一致', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    const createdIds = useStore.getState().splitNoteByParagraph('sm-3');

    const afterSplit = useStore.getState();
    expect(afterSplit.notesById['sm-3']).toBeUndefined();
    createdIds.forEach((id) => {
      expect(afterSplit.notesById[id]).toBeDefined();
      expect(afterSplit.allNoteIds).toContain(id);
      expect(afterSplit.boardNoteIds['default']).toContain(id);
      expect(afterSplit.layoutNotesById[id]).toBeDefined();
      expect(afterSplit.layoutNotesById[id].x).toBe(afterSplit.notesById[id].x);
      expect(afterSplit.layoutNotesById[id].y).toBe(afterSplit.notesById[id].y);
    });

    useStore.getState().undoDomainChange();
    const afterUndo = useStore.getState();
    createdIds.forEach((id) => {
      expect(afterUndo.notesById[id]).toBeUndefined();
      expect(afterUndo.allNoteIds).not.toContain(id);
      expect(afterUndo.boardNoteIds['default'] ?? []).not.toContain(id);
      expect(afterUndo.layoutNotesById[id]).toBeUndefined();
    });
    expect(afterUndo.notesById['sm-3']).toBeDefined();

    useStore.getState().redoDomainChange();
    const afterRedo = useStore.getState();
    expect(afterRedo.notesById['sm-3']).toBeUndefined();
    createdIds.forEach((id) => {
      expect(afterRedo.notesById[id]).toBeDefined();
      expect(afterRedo.allNoteIds).toContain(id);
      expect(afterRedo.boardNoteIds['default']).toContain(id);
      expect(afterRedo.layoutNotesById[id]).toBeDefined();
      expect(afterRedo.layoutNotesById[id].x).toBe(afterRedo.notesById[id].x);
      expect(afterRedo.layoutNotesById[id].y).toBe(afterRedo.notesById[id].y);
    });
  });

  it('splitNoteByParagraph 内容不足两段时不创建 domainHistory 条目', () => {
    useStore.setState({
      notesById: {
        ...useStore.getState().notesById,
        'sm-3': { ...useStore.getState().notesById['sm-3'], content: '单段内容' },
      },
    });

    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;
    const result = useStore.getState().splitNoteByParagraph('sm-3');

    expect(result).toHaveLength(0);
    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('merge undo 后 redo 不重新生成 UUID', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    const mergedId = useStore.getState().mergeSelectedNotes();
    expect(mergedId).toBeTruthy();

    useStore.getState().undoDomainChange();
    useStore.getState().redoDomainChange();

    const redoStack = useStore.getState().domainHistory.redoStack;
    expect(redoStack).toHaveLength(0);

    const undoStack = useStore.getState().domainHistory.undoStack;
    const mergeEntry = undoStack.find((e) => e.label === 'merge-notes');
    expect(mergeEntry).toBeDefined();

    const redoPatch = mergeEntry!.redo;
    expect(redoPatch.type).toBe('compound-patch');
    if (redoPatch.type !== 'compound-patch') throw new Error('redo patch 应为 compound-patch');

    const addPatch = redoPatch.patches.find((p) => p.type === 'add-note');
    expect(addPatch).toBeDefined();
    if (!addPatch || addPatch.type !== 'add-note') throw new Error('redo 应包含 add-note 子 patch');
    expect(addPatch.note.id).toBe(mergedId);
  });

  it('split undo 后 redo 不重新生成 UUID', () => {
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    const createdIds = useStore.getState().splitNoteByParagraph('sm-3');

    useStore.getState().undoDomainChange();
    useStore.getState().redoDomainChange();

    const undoStack = useStore.getState().domainHistory.undoStack;
    const splitEntry = undoStack.find((e) => e.label === 'split-note');
    expect(splitEntry).toBeDefined();

    const redoPatch = splitEntry!.redo;
    expect(redoPatch.type).toBe('compound-patch');
    if (redoPatch.type !== 'compound-patch') throw new Error('redo patch 应为 compound-patch');

    const addPatches = redoPatch.patches.filter((p) => p.type === 'add-note');
    expect(addPatches).toHaveLength(createdIds.length);
    addPatches.forEach((patch, i) => {
      if (patch.type !== 'add-note') throw new Error('redo 子 patch 应为 add-note');
      expect(patch.note.id).toBe(createdIds[i]);
    });
  });
});

describe('v1.4.4 便签编辑尺寸偏好撤销/重做契约', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'rs-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '可调尺寸',
          content: 'alpha',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'rs-2',
          boardId: 'default',
          x: 30,
          y: 40,
          title: '已带尺寸',
          content: 'beta',
          color: '#dbeafe',
          z: 2,
          editingWidth: 300,
          editingHeight: 200,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      currentBoardId: 'default',
      selectedIds: [],
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      config: { ...useStore.getState().config, maxZ: 2 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('commitNoteEditingSize 编辑尺寸变化时创建一条历史并支持撤销/重做', () => {
    vi.setSystemTime(new Date('2026-06-01T14:00:00.000Z'));

    useStore.getState().commitNoteEditingSize('rs-1', 320, 250, {
      editingWidth: undefined,
      editingHeight: undefined,
      renderedWidth: 260,
      renderedHeight: 100,
      updatedAt: 100,
    });

    const note = getNote('rs-1');
    expect(note?.editingWidth).toBe(320);
    expect(note?.editingHeight).toBe(250);
    expect(note?.updatedAt).toBe(new Date('2026-06-01T14:00:00.000Z').getTime());

    const undoStack = useStore.getState().domainHistory.undoStack;
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].label).toBe('resize-editing-size');
    expect(undoStack[0].undo).toMatchObject({
      type: 'update-fields',
      noteId: 'rs-1',
      fields: { editingWidth: undefined, editingHeight: undefined, updatedAt: 100 },
    });
    expect(undoStack[0].redo).toMatchObject({
      type: 'update-fields',
      noteId: 'rs-1',
      fields: { editingWidth: 320, editingHeight: 250 },
    });

    useStore.getState().undoDomainChange();
    expect(getNote('rs-1')?.editingWidth).toBeUndefined();
    expect(getNote('rs-1')?.editingHeight).toBeUndefined();
    expect(getNote('rs-1')?.updatedAt).toBe(100);

    useStore.getState().redoDomainChange();
    expect(getNote('rs-1')?.editingWidth).toBe(320);
    expect(getNote('rs-1')?.editingHeight).toBe(250);
    expect(getNote('rs-1')?.updatedAt).toBe(new Date('2026-06-01T14:00:00.000Z').getTime());
  });

  it('commitNoteEditingSize 编辑尺寸未变时不创建历史', () => {
    useStore.getState().commitNoteEditingSize('rs-2', 300, 200, {
      editingWidth: 300,
      editingHeight: 200,
      renderedWidth: 300,
      renderedHeight: 200,
      updatedAt: 200,
    });

    expect(useStore.getState().undoDomainChange()).toBe(false);
  });

  it('commitNoteEditingSize 便签不存在时不创建历史', () => {
    const undoCountBefore = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().commitNoteEditingSize('nonexistent', 300, 200, {
      editingWidth: undefined,
      editingHeight: undefined,
      renderedWidth: 260,
      renderedHeight: 100,
      updatedAt: 100,
    });

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountBefore);
  });

  it('commitNoteEditingSize 便签已在废纸篓时不创建历史', () => {
    vi.setSystemTime(new Date('2026-06-01T14:00:00.000Z'));
    useStore.getState().deleteNote('rs-1');

    const undoCountAfterDelete = useStore.getState().domainHistory.undoStack.length;

    useStore.getState().commitNoteEditingSize('rs-1', 320, 250, {
      editingWidth: undefined,
      editingHeight: undefined,
      renderedWidth: 260,
      renderedHeight: 100,
      updatedAt: 100,
    });

    expect(useStore.getState().domainHistory.undoStack.length).toBe(undoCountAfterDelete);
  });

  it('commitNoteEditingSize 编辑尺寸低于最小值时自动钳制', () => {
    vi.setSystemTime(new Date('2026-06-01T14:00:00.000Z'));

    useStore.getState().commitNoteEditingSize('rs-1', 50, 30, {
      editingWidth: undefined,
      editingHeight: undefined,
      renderedWidth: 260,
      renderedHeight: 100,
      updatedAt: 100,
    });

    const note = getNote('rs-1');
    expect(note?.editingWidth).toBe(LAYOUT.NOTE_MIN_WIDTH);
    expect(note?.editingHeight).toBe(LAYOUT.NOTE_MIN_HEIGHT);

    const redoPatch = useStore.getState().domainHistory.undoStack[0].redo;
    expect(redoPatch).toMatchObject({
      type: 'update-fields',
      fields: { editingWidth: LAYOUT.NOTE_MIN_WIDTH, editingHeight: LAYOUT.NOTE_MIN_HEIGHT },
    });
  });

  it('commitNoteEditingSize undo 后 editingWidth/editingHeight 正确恢复', () => {
    vi.setSystemTime(new Date('2026-06-01T14:00:00.000Z'));

    useStore.getState().commitNoteEditingSize('rs-1', 350, 280, {
      editingWidth: undefined,
      editingHeight: undefined,
      renderedWidth: 260,
      renderedHeight: 100,
      updatedAt: 100,
    });

    useStore.getState().undoDomainChange();

    const note = getNote('rs-1');
    expect(note?.editingWidth).toBeUndefined();
    expect(note?.editingHeight).toBeUndefined();

    useStore.getState().redoDomainChange();

    const noteRedo = getNote('rs-1');
    expect(noteRedo?.editingWidth).toBe(350);
    expect(noteRedo?.editingHeight).toBe(280);
  });

  it('commitNoteEditingSize 修改已有编辑尺寸便签时正确保存旧值', () => {
    vi.setSystemTime(new Date('2026-06-01T14:00:00.000Z'));

    useStore.getState().commitNoteEditingSize('rs-2', 400, 300, {
      editingWidth: 300,
      editingHeight: 200,
      renderedWidth: 300,
      renderedHeight: 200,
      updatedAt: 200,
    });

    const undoStack = useStore.getState().domainHistory.undoStack;
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].undo).toMatchObject({
      type: 'update-fields',
      noteId: 'rs-2',
      fields: { editingWidth: 300, editingHeight: 200, updatedAt: 200 },
    });

    useStore.getState().undoDomainChange();
    expect(getNote('rs-2')?.editingWidth).toBe(300);
    expect(getNote('rs-2')?.editingHeight).toBe(200);
    expect(getNote('rs-2')?.updatedAt).toBe(200);
  });
});

const VALID_ATTACH_REF: AttachmentRef = {
  id: 'att-001',
  hash: 'a'.repeat(64),
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 1024,
  relativePath: 'attachments/' + 'a'.repeat(64) + '.jpg',
  createdAt: 1700000000000,
};

const VALID_ATTACH_REF_2: AttachmentRef = {
  id: 'att-002',
  hash: 'b'.repeat(64),
  filename: 'doc.pdf',
  mimeType: 'application/pdf',
  size: 2048,
  relativePath: 'attachments/' + 'b'.repeat(64) + '.pdf',
  createdAt: 1700000001000,
};

describe('v1.4.7 附件迁移与归一化契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
  });

  it('init 从 disk 加载无 attachments 字段的 v1 数据后，每个 note 有 attachments: []', async () => {
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: 1,
      storageUpdatedAt: 100,
      notes: [{
        id: 'legacy-no-att',
        boardId: 'default',
        x: 10,
        y: 20,
        title: '旧数据',
        content: '无附件',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
      }],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { version: 2, maxZ: 1, themeMode: 'system' },
    }));

    await useStore.getState().init();

    const note = useStore.getState().notesById['legacy-no-att'];
    expect(note).toBeDefined();
    expect(note.attachments).toEqual([]);

    const savedWal = vi.mocked(db.saveWAL).mock.calls[0]?.[0];
    expect(savedWal?.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('init 从 disk 加载含合法 AttachmentRef 的数据后，引用被完整保留', async () => {
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: 2,
      storageUpdatedAt: 200,
      notes: [{
        id: 'with-ref',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '有附件',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 200,
        attachments: [VALID_ATTACH_REF],
      }],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { version: 2, maxZ: 1, themeMode: 'system' },
    }));

    await useStore.getState().init();

    const note = useStore.getState().notesById['with-ref'];
    expect(note.attachments).toHaveLength(1);
    expect(note.attachments?.[0]).toEqual(VALID_ATTACH_REF);
  });

  it('init 后畸形附件条目被过滤，合法条目保留', async () => {
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: 2,
      storageUpdatedAt: 300,
      notes: [{
        id: 'mixed',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '混合附件',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 300,
        attachments: [
          null,
          42,
          { id: 'bad' },
          { id: 'bad', hash: 'x', filename: 'f', mimeType: 'm', size: 'not-num', relativePath: 'r', createdAt: 1 },
          VALID_ATTACH_REF,
        ],
      }],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { version: 2, maxZ: 1, themeMode: 'system' },
    }));

    await useStore.getState().init();

    const note = useStore.getState().notesById['mixed'];
    expect(note.attachments).toHaveLength(1);
    expect(note.attachments?.[0]).toEqual(VALID_ATTACH_REF);
  });

  it('attachments 为非数组值时归一化为空数组', async () => {
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: 2,
      storageUpdatedAt: 400,
      notes: [{
        id: 'non-array-att',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '异常附件',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 400,
        attachments: 'not-an-array',
      }],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { version: 2, maxZ: 1, themeMode: 'system' },
    }));

    await useStore.getState().init();

    expect(useStore.getState().notesById['non-array-att'].attachments).toEqual([]);
  });

  it('denormalizeNotes 透传附件引用，normalizeNotes + denormalizeRoundTrip 保留附件', () => {
    const notes = [
      {
        id: 'att-rt-1',
        boardId: 'default',
        x: 0,
        y: 0,
        title: 'roundtrip',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
        attachments: [VALID_ATTACH_REF, VALID_ATTACH_REF_2],
      },
      {
        id: 'att-rt-2',
        boardId: 'default',
        x: 10,
        y: 10,
        title: 'no-att',
        content: '',
        color: '#FFFFFF',
        z: 2,
        createdAt: 20,
        updatedAt: 20,
      },
    ];

    const normalized = normalizeNotes(notes);
    useStore.setState({
      ...normalized,
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 2 },
    });

    const denormalized = denormalizeNotes(useStore.getState());

    expect(denormalized).toHaveLength(2);
    expect(denormalized[0].attachments).toHaveLength(2);
    expect(denormalized[0].attachments?.[0]).toEqual(VALID_ATTACH_REF);
    expect(denormalized[0].attachments?.[1]).toEqual(VALID_ATTACH_REF_2);
    expect(denormalized[1].attachments).toBeUndefined();
  });

  it('init 后保存再重新加载，附件引用不丢失', async () => {
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: 2,
      storageUpdatedAt: 500,
      notes: [{
        id: 'persist-ref',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '持久化',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 500,
        attachments: [VALID_ATTACH_REF],
      }],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { version: 2, maxZ: 1, themeMode: 'system' },
    }));

    await useStore.getState().init();

    expect(useStore.getState().notesById['persist-ref'].attachments).toHaveLength(1);

    vi.mocked(db.saveWAL).mockResolvedValueOnce(true);
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, io_duration_ms: 0, retries: 0 });

    await useStore.getState().saveToDisk();

    const savedWal = vi.mocked(db.saveWAL).mock.calls[0]?.[0];
    expect(savedWal).toBeDefined();
    expect(savedWal.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(savedWal.notes[0].attachments).toHaveLength(1);
    expect(savedWal.notes[0].attachments?.[0]).toEqual(VALID_ATTACH_REF);
  });
});

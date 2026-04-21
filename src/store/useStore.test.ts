import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    const saveSpy = vi.fn(async () => true);
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
    const saveSpy = vi.fn(async () => true);
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
    const saveSpy = vi.fn(async () => true);
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
    const saveSpy = vi.fn(async () => true);
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
    const saveSpy = vi.fn(async () => true);
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

describe('useStore 导入契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      notes: [],
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
    expect(useStore.getState().notes).toHaveLength(0);
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

    expect(result.status).toBe('success');
    expect(state.boards).toHaveLength(2);
    expect(state.boards[1].id).toBe('11111111-1111-4111-8111-111111111111');
    expect(state.boards[1].name).toBe('主板（导入）');
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].id).toBe('22222222-2222-4222-8222-222222222222');
    expect(state.notes[0].boardId).toBe('11111111-1111-4111-8111-111111111111');
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

    expect(result.status).toBe('success');
    expect(result.message).toBe('导入完成，已跳过 1 条异常便签。');
    expect(result.summary?.skippedNotesCount).toBe(1);
    expect(result.summary?.issues[0].code).toBe('INVALID_NOTE');
    expect(state.boards).toHaveLength(2);
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].id).toBe('66666666-bbbb-4666-8666-666666666666');
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
    expect(state.notes).toHaveLength(1);
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
    expect(state.notes).toEqual(originalState.notes);
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
    expect(state.notes).toEqual(originalState.notes);
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
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      notes: [],
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
    vi.clearAllMocks();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      notes: [],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('旧 generationId ACK 不得覆盖最新 UI 状态', async () => {
    vi.mocked(db.saveWAL).mockResolvedValue(true);

    let resolveGen1: () => void;
    const gen1Promise = new Promise<void>((res) => { resolveGen1 = res; });
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) => {
      if (args?.generationId === 1) {
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

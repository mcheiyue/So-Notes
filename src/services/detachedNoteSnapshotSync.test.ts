import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitToMock } = vi.hoisted(() => ({
  emitToMock: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: emitToMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('../store/db', () => ({
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

import {
  startDetachedNoteSnapshotSync,
  stopDetachedNoteSnapshotSync,
} from './detachedNoteSnapshotSync';
import { useStore } from '../store/useStore';
import { normalizeNotes } from '../store/normalization';
import type { Note } from '../store/types';
import { DETACHED_NOTE_EVENTS } from '../types/detachedNoteSnapshot';

const createNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  boardId: 'default',
  x: 100,
  y: 200,
  title: '标题',
  content: '内容',
  color: '#FFFFFF',
  z: 1,
  collapsed: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('detachedNoteSnapshotSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    emitToMock.mockClear();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      ...normalizeNotes([
        createNote({ id: 'n1', title: '便签1', content: '内容1', color: '#fef9c3' }),
        createNote({ id: 'n2', title: '便签2', content: '内容2', color: '#dbeafe' }),
      ]),
    });
  });

  afterEach(() => {
    stopDetachedNoteSnapshotSync();
    vi.useRealTimers();
  });

  it('启动后订阅 store 变化，不主动发送快照', () => {
    startDetachedNoteSnapshotSync();
    expect(emitToMock).not.toHaveBeenCalled();
  });

  it('有撕下窗口的便签变更后，经过 throttle 发送快照', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      state.notesById['n1'].title = '新标题';
    });

    expect(emitToMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({
        noteId: 'n1',
        title: '新标题',
        content: '内容1',
        color: '#fef9c3',
        isCollapsed: false,
      }),
    );
  });

  it('没有撕下窗口的便签变更不发送快照', () => {
    useStore.setState({
      detachedNotes: [],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      state.notesById['n1'].title = '新标题';
    });

    vi.advanceTimersByTime(200);

    expect(emitToMock).not.toHaveBeenCalled();
  });

  it('便签软删除后立即发送 missing 事件', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      state.notesById['n1'].deletedAt = Date.now();
    });

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.MISSING,
      { noteId: 'n1' },
    );
  });

  it('便签被永久删除后发送 missing 事件', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      delete state.notesById['n1'];
      state.allNoteIds = state.allNoteIds.filter((id) => id !== 'n1');
    });

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.MISSING,
      { noteId: 'n1' },
    );
  });

  it('快速连续编辑同一便签只发送一次快照（coalesce）', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => { state.notesById['n1'].content = 'A'; });
    useStore.setState((state) => { state.notesById['n1'].content = 'AB'; });
    useStore.setState((state) => { state.notesById['n1'].content = 'ABC'; });

    vi.advanceTimersByTime(100);

    expect(emitToMock).toHaveBeenCalledTimes(1);
    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({ content: 'ABC' }),
    );
  });

  it('多个撕下窗口各自独立发送快照', () => {
    useStore.setState({
      detachedNotes: [
        { noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false },
        { noteId: 'n2', position: { x: 100, y: 100 }, isPinned: false },
      ],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      state.notesById['n1'].title = '新标题1';
      state.notesById['n2'].title = '新标题2';
    });

    vi.advanceTimersByTime(100);

    expect(emitToMock).toHaveBeenCalledTimes(2);
    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({ noteId: 'n1', title: '新标题1' }),
    );
    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n2',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({ noteId: 'n2', title: '新标题2' }),
    );
  });

  it('cleanup 停止同步并清除挂起的定时器', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    const cleanup = startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      state.notesById['n1'].title = '新标题';
    });

    cleanup();

    vi.advanceTimersByTime(200);

    expect(emitToMock).not.toHaveBeenCalled();
  });

  it('快照包含折叠状态', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      state.notesById['n1'].collapsed = true;
    });

    vi.advanceTimersByTime(100);

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({ isCollapsed: true }),
    );
  });
});

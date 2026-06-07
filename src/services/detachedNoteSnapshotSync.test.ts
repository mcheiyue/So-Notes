import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitToMock, listenMock } = vi.hoisted(() => ({
  emitToMock: vi.fn(async () => {}),
  listenMock: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: emitToMock,
  listen: listenMock,
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
import type { AttachmentRef, Note } from '../store/types';
import { DETACHED_NOTE_EVENTS } from '../types/detachedNoteSnapshot';

const createNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  kind: 'text',
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

const createAttachment = (overrides: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'att-1',
  hash: 'a'.repeat(64),
  filename: 'photo.png',
  mimeType: 'image/png',
  size: 1024,
  relativePath: `attachments/${'a'.repeat(64)}.png`,
  createdAt: 1,
  ...overrides,
});

describe('detachedNoteSnapshotSync', () => {
  type ReadyEventHandler = (event: { payload: { noteId: string } }) => void;
  type ListenCall = [string, ReadyEventHandler];

  beforeEach(() => {
    vi.useFakeTimers();
    emitToMock.mockClear();
    listenMock.mockClear();
    listenMock.mockResolvedValue(vi.fn());
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
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

  it('新增撕下窗口后延迟补发图片便签快照，避免窗口监听器晚就绪丢首帧', () => {
    const attachment = createAttachment();
    useStore.setState((state) => {
      state.notesById['n1'].kind = 'image';
      state.notesById['n1'].attachments = [attachment];
      state.notesById['n1'].title = 'photo.png';
      state.notesById['n1'].content = '';
    });

    startDetachedNoteSnapshotSync();

    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    expect(emitToMock).not.toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.anything(),
    );

    vi.advanceTimersByTime(100);

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({
        noteId: 'n1',
        kind: 'image',
        title: 'photo.png',
        attachments: [attachment],
      }),
    );

    emitToMock.mockClear();
    vi.advanceTimersByTime(350);

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({
        noteId: 'n1',
        kind: 'image',
        title: 'photo.png',
        attachments: [attachment],
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

  it('收到 READY 事件后立即发送当前快照', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });

    startDetachedNoteSnapshotSync();

    const readyCall = (listenMock.mock.calls as unknown as ListenCall[]).find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.READY,
    );
    expect(readyCall).toBeDefined();

    const readyCallback = readyCall![1];
    readyCallback({ payload: { noteId: 'n1' } });

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.THEME,
      { themeMode: 'system', isDark: false },
    );
    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({
        noteId: 'n1',
        title: '便签1',
        content: '内容1',
        color: '#fef9c3',
        isCollapsed: false,
      }),
    );
  });

  it('收到 READY 事件后图片便签首帧快照包含 kind 与附件', () => {
    const attachment = createAttachment();
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });
    useStore.setState((state) => {
      state.notesById['n1'].kind = 'image';
      state.notesById['n1'].attachments = [attachment];
      state.notesById['n1'].title = 'photo.png';
      state.notesById['n1'].content = '';
    });

    startDetachedNoteSnapshotSync();

    const readyCall = (listenMock.mock.calls as unknown as ListenCall[]).find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.READY,
    );
    expect(readyCall).toBeDefined();

    const readyCallback = readyCall![1];
    readyCallback({ payload: { noteId: 'n1' } });

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      expect.objectContaining({
        noteId: 'n1',
        kind: 'image',
        title: 'photo.png',
        content: '',
        attachments: [attachment],
      }),
    );
  });

  it('收到 READY 事件后若便签已删除则发送 missing', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false }],
    });
    useStore.setState((state) => {
      state.notesById['n1'].deletedAt = Date.now();
    });

    startDetachedNoteSnapshotSync();

    const readyCall = (listenMock.mock.calls as unknown as ListenCall[]).find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.READY,
    );
    expect(readyCall).toBeDefined();

    const readyCallback = readyCall![1];
    readyCallback({ payload: { noteId: 'n1' } });

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.THEME,
      { themeMode: 'system', isDark: false },
    );
    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.MISSING,
      { noteId: 'n1' },
    );
  });

  it('主题模式变化后向所有撕下窗口发送主题事件', () => {
    useStore.setState({
      detachedNotes: [
        { noteId: 'n1', position: { x: 0, y: 0 }, isPinned: false },
        { noteId: 'n2', position: { x: 100, y: 100 }, isPinned: false },
      ],
    });

    startDetachedNoteSnapshotSync();

    useStore.setState((state) => {
      state.config.themeMode = 'dark';
    });

    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n1',
      DETACHED_NOTE_EVENTS.THEME,
      { themeMode: 'dark', isDark: true },
    );
    expect(emitToMock).toHaveBeenCalledWith(
      'detached-note-n2',
      DETACHED_NOTE_EVENTS.THEME,
      { themeMode: 'dark', isDark: true },
    );
  });

  it('stop 清理 ready 监听器 Promise', async () => {
    const unlistenReadyFn = vi.fn();
    listenMock.mockResolvedValue(unlistenReadyFn);

    startDetachedNoteSnapshotSync();

    expect(listenMock).toHaveBeenCalledWith(
      DETACHED_NOTE_EVENTS.READY,
      expect.any(Function),
    );

    stopDetachedNoteSnapshotSync();

    await vi.waitFor(() => {
      expect(unlistenReadyFn).toHaveBeenCalled();
    });
  });
});

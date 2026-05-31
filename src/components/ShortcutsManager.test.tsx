import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const appControllerMock = vi.hoisted(() => ({
  toggleSpotlight: vi.fn(),
  selectAllNotes: vi.fn(),
  deleteSelectedNotes: vi.fn(),
  duplicateSelectedNotes: vi.fn(),
  resetViewport: vi.fn(),
  smartPasteFromText: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => ''),
}));

vi.mock('../controllers/appController', () => ({
  appController: appControllerMock,
}));

import ShortcutsManager from './ShortcutsManager';
import { useStore } from '../store/useStore';
import { createInitialUIState, useUIStore } from '../store/uiStore';

describe('ShortcutsManager 撤销重做快捷键', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderShortcutsManager = async () => {
    await act(async () => {
      root.render(<ShortcutsManager />);
    });
  };

  const pressModKey = async (key: string, options: KeyboardEventInit = {}) => {
    await act(async () => {
      const active = document.activeElement;
      const target = active instanceof HTMLElement && active !== document.body ? active : document;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        ...options,
      }));
    });
  };

  const addNoteAndReadId = (x = 40, y = 80) => {
    useStore.getState().addNote(x, y);
    const ids = useStore.getState().allNoteIds;
    return ids[ids.length - 1];
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    appControllerMock.toggleSpotlight.mockClear();
    appControllerMock.selectAllNotes.mockClear();
    appControllerMock.deleteSelectedNotes.mockClear();
    appControllerMock.duplicateSelectedNotes.mockClear();
    appControllerMock.resetViewport.mockClear();
    appControllerMock.smartPasteFromText.mockClear();

    useStore.setState(useStore.getInitialState(), true);
    useUIStore.setState(createInitialUIState());

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('BOARD 视图下 Ctrl+Z 撤销上一条领域历史', async () => {
    await renderShortcutsManager();
    const noteId = addNoteAndReadId();

    await pressModKey('z');

    expect(useStore.getState().notesById[noteId]).toBeUndefined();
    expect(useStore.getState().layoutNotesById[noteId]).toBeUndefined();
  });

  it('BOARD 视图下 Ctrl+Y 重做上一条撤销历史', async () => {
    await renderShortcutsManager();
    const noteId = addNoteAndReadId();

    await pressModKey('z');
    await pressModKey('y');

    expect(useStore.getState().domainHistory.redoStack).toHaveLength(0);
    expect(useStore.getState().notesById[noteId]).toMatchObject({ id: noteId, x: 40, y: 80 });
    expect(useStore.getState().layoutNotesById[noteId]).toMatchObject({ id: noteId, x: 40, y: 80 });
  });

  it('BOARD 视图下 Ctrl+Shift+Z 也触发重做', async () => {
    await renderShortcutsManager();
    const noteId = addNoteAndReadId();

    await pressModKey('z');
    expect(useStore.getState().notesById[noteId]).toBeUndefined();

    await pressModKey('z', { shiftKey: true });

    expect(useStore.getState().notesById[noteId]).toMatchObject({ id: noteId, x: 40, y: 80 });
  });

  it('输入框聚焦时不劫持原生 Ctrl+Z', async () => {
    await renderShortcutsManager();
    const noteId = addNoteAndReadId();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    await pressModKey('z');

    expect(useStore.getState().notesById[noteId]).toBeDefined();
    expect(useStore.getState().domainHistory.undoStack).toHaveLength(1);
  });

  it('废纸篓视图下 Ctrl+Z 静默无动作', async () => {
    useUIStore.setState({ viewMode: 'TRASH' });
    await renderShortcutsManager();
    const noteId = addNoteAndReadId();

    await pressModKey('z');

    expect(useStore.getState().notesById[noteId]).toBeDefined();
    expect(useUIStore.getState().viewMode).toBe('TRASH');
  });

  it('Spotlight 打开时阻断 Ctrl+Z', async () => {
    useUIStore.setState({ isSpotlightOpen: true });
    await renderShortcutsManager();
    const noteId = addNoteAndReadId();

    await pressModKey('z');

    expect(useStore.getState().notesById[noteId]).toBeDefined();
  });

  it('快速捕获打开时阻断 Ctrl+Z', async () => {
    useUIStore.setState({ isQuickCaptureOpen: true });
    await renderShortcutsManager();
    const noteId = addNoteAndReadId();

    await pressModKey('z');

    expect(useStore.getState().notesById[noteId]).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SelectionActionBar } from './SelectionActionBar';
import { useStore } from '../store';
import { normalizeNotes } from '../store/normalization';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

describe('SelectionActionBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'note-1',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '',
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
          title: '',
          content: 'beta',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      viewMode: 'BOARD',
      selectedIds: ['note-1', 'note-2'],
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('多选普通便签时显示快捷操作条', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    expect(container.textContent).toContain('已选 2');
    expect(container.textContent).toContain('合并');
    expect(container.textContent).toContain('删除');
    expect(container.textContent).toContain('折叠');
    expect(container.textContent).toContain('归拢');
    expect(container.textContent).toContain('复制');
  });

  it('按钮直接复用 store 批量 action', async () => {
    const mergeSelectedNotes = vi.fn(() => 'merged-note');
    const deleteSelectedNotes = vi.fn();
    const batchToggleCollapse = vi.fn();
    const arrangeNotes = vi.fn();
    const duplicateSelectedNotes = vi.fn();
    const changeSelectedNotesColor = vi.fn();
    useStore.setState({
      mergeSelectedNotes,
      deleteSelectedNotes,
      batchToggleCollapse,
      arrangeNotes,
      duplicateSelectedNotes,
      changeSelectedNotesColor,
    });

    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const clickByText = async (text: string) => {
      const button = buttons.find((candidate) => candidate.textContent?.includes(text));
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    };

    await clickByText('合并');
    await clickByText('删除');
    await clickByText('折叠');
    await clickByText('归拢');
    await clickByText('复制');

    const colorButton = buttons.find((button) => button.getAttribute('aria-label')?.startsWith('改色为'));
    await act(async () => {
      colorButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(mergeSelectedNotes).toHaveBeenCalledTimes(1);
    expect(deleteSelectedNotes).toHaveBeenCalledTimes(1);
    expect(batchToggleCollapse).toHaveBeenCalledWith(['note-1', 'note-2']);
    expect(arrangeNotes).toHaveBeenCalledWith(undefined, undefined, 'position', 'selection');
    expect(duplicateSelectedNotes).toHaveBeenCalledTimes(1);
    expect(changeSelectedNotesColor).toHaveBeenCalledTimes(1);
  });

  it('非多选或回收站视图不显示', async () => {
    useStore.setState({ selectedIds: ['note-1'] });

    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    expect(container.querySelector('[role="toolbar"]')).toBeNull();

    useStore.setState({ selectedIds: ['note-1', 'note-2'], viewMode: 'TRASH' });

    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('pointerdown 阻止默认行为以防止画布焦点抢占', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    const toolbar = container.querySelector('[role="toolbar"]');
    expect(toolbar).not.toBeNull();

    const pointerDownEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(pointerDownEvent, 'preventDefault');

    await act(async () => {
      toolbar!.dispatchEvent(pointerDownEvent);
    });

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });
});

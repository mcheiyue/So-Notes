import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SelectionActionBar } from './SelectionActionBar';
import { useStore } from '../store/useStore';
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
          kind: 'text',
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
          kind: 'text',
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
    expect(container.textContent).toContain('改色');
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

    const colorTrigger = container.querySelector('[aria-label="改色"]') as HTMLButtonElement | null;
    expect(colorTrigger).not.toBeNull();
    await act(async () => {
      colorTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    const colorOption = container.querySelector('[role="option"]') as HTMLButtonElement | null;
    expect(colorOption).not.toBeNull();
    await act(async () => {
      colorOption?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

  it('操作条包含三个语义分组', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    expect(container.querySelector('.selection-actionbar__primary')).not.toBeNull();
    expect(container.querySelector('.selection-actionbar__colors')).not.toBeNull();
    expect(container.querySelector('.selection-actionbar__trailing')).not.toBeNull();
  });

  it('外层容器启用 flex-wrap 以支持窄窗口分组换行', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    const toolbar = container.querySelector('[role="toolbar"]') as HTMLElement | null;
    expect(toolbar).not.toBeNull();
    expect(toolbar!.className).toContain('flex-wrap');
    expect(toolbar!.className).toContain('selection-actionbar');
  });

  it('所有操作按钮均在各分组内，不依赖顶层平铺', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    const primary = container.querySelector('.selection-actionbar__primary')!;
    const colors = container.querySelector('.selection-actionbar__colors')!;
    const trailing = container.querySelector('.selection-actionbar__trailing')!;

    expect(primary.textContent).toContain('已选');
    expect(primary.textContent).toContain('合并');
    expect(primary.textContent).toContain('删除');

    expect(colors.querySelector('[aria-label="改色"]')).not.toBeNull();

    expect(trailing.textContent).toContain('折叠');
    expect(trailing.textContent).toContain('归拢');
    expect(trailing.textContent).toContain('复制');
  });

  it('点击改色触发器打开弹出层，选色后自动关闭', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    const colorTrigger = container.querySelector('[aria-label="改色"]') as HTMLButtonElement | null;
    expect(colorTrigger).not.toBeNull();
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      colorTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    const popover = container.querySelector('[role="listbox"]');
    expect(popover).not.toBeNull();
    const colorOptions = popover!.querySelectorAll('[role="option"]');
    expect(colorOptions).toHaveLength(6);

    await act(async () => {
      (colorOptions[0] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('改色弹出层默认关闭，不永久渲染色块', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it('点击弹出层外部时关闭改色气泡', async () => {
    await act(async () => {
      root.render(<SelectionActionBar />);
    });

    const colorTrigger = container.querySelector('[aria-label="改色"]') as HTMLButtonElement | null;
    expect(colorTrigger).not.toBeNull();

    await act(async () => {
      colorTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});

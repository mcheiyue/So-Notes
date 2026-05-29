import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type React from 'react';
import { useStore } from '../store/useStore';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
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

describe('PinFab WindowShell 浮层交互合同', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderPinFab = async (ui: React.ReactNode) => {
    await act(async () => {
      root.render(ui);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    invokeMock.mockClear();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({ isPinned: true });

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

  it('为取消钉住按钮显式恢复 pointer-events', async () => {
    const { PinFab } = await import('./PinFab');

    await renderPinFab(<PinFab />);

    const button = container.querySelector('button[title="取消钉住"]') as HTMLButtonElement | null;

    expect(button).not.toBeNull();
    expect(button?.className).toContain('pointer-events-auto');
  });

  it('未钉住时不渲染按钮', async () => {
    const { PinFab } = await import('./PinFab');
    useStore.setState({ isPinned: false });

    await renderPinFab(<PinFab />);

    const button = container.querySelector('button[title="取消钉住"]') as HTMLButtonElement | null;
    expect(button).toBeNull();
  });

  it('保持点击与双击的传播保护，并继续调用前端 unpin', async () => {
    const { PinFab } = await import('./PinFab');
    const parentClick = vi.fn();
    const parentDoubleClick = vi.fn();

    await renderPinFab(
      <form onClick={parentClick} onDoubleClick={parentDoubleClick} onKeyDown={() => undefined}>
        <PinFab />
      </form>,
    );

    const button = container.querySelector('button[title="取消钉住"]') as HTMLButtonElement | null;

    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });

    expect(invokeMock).toHaveBeenCalledWith('frontend_unpin');
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentDoubleClick).not.toHaveBeenCalled();
  });
});

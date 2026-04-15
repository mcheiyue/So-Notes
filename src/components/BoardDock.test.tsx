import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

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

import { BoardDock } from './BoardDock';
import { Z_INDEX } from '../constants/layout';
import { useStore } from '../store/useStore';

describe('BoardDock v1.2.4 最小修复', () => {
  let container: HTMLDivElement;
  let root: Root;

  const clickElement = async (element: Element | null) => {
    expect(element).not.toBeNull();

    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const findButtonByText = (text: string) => Array.from(container.querySelectorAll('button')).find(
    button => button.textContent?.includes(text),
  ) ?? null;

  const getSettingsButton = () => container.querySelector('button[aria-label="打开设置"]');
  const getImportFeedback = () => container.querySelector('[data-testid="board-import-feedback"]');

  const renderBoardDock = async () => {
    await act(async () => {
      root.render(<BoardDock />);
    });
  };

  const openDataSettings = async () => {
    await renderBoardDock();
    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
  };

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
        { id: 'board-2', name: '实验板', icon: '🧪', createdAt: 1, viewport: { x: 40, y: 60 } },
      ],
      notes: [],
      currentBoardId: 'default',
      isDockVisible: true,
      viewMode: 'BOARD',
      config: { ...useStore.getState().config, themeMode: 'system' },
      switchBoard: vi.fn(),
      createBoard: vi.fn(),
      deleteBoard: vi.fn(),
      updateBoard: vi.fn(),
      reorderBoard: vi.fn(),
      setDockVisible: vi.fn(),
      setViewMode: vi.fn(),
      clearSelection: vi.fn(),
      exportAll: vi.fn(async () => undefined),
      importFromFile: vi.fn(async () => ({ status: 'cancelled' as const })),
      exportCurrentBoard: vi.fn(async () => undefined),
      setThemeMode: vi.fn(),
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

  it('保持共享浮层层级合同顺序稳定', () => {
    expect(Z_INDEX.MINIMAP).toBeLessThan(Z_INDEX.DOCK_BACKDROP);
    expect(Z_INDEX.DOCK_BACKDROP).toBeLessThan(Z_INDEX.DOCK);
    expect(Z_INDEX.DOCK).toBeLessThan(Z_INDEX.TOOLTIP);
    expect(Z_INDEX.TOOLTIP).toBeLessThan(Z_INDEX.MENU);
    expect(Z_INDEX.MENU).toBeLessThan(Z_INDEX.SPOTLIGHT);
  });

  it('click-away backdrop 显式恢复 pointer-events，并继续关闭 dock', async () => {
    await renderBoardDock();

    const backdrop = container.querySelector('button[aria-label="关闭浮层"]') as HTMLButtonElement | null;

    expect(backdrop).not.toBeNull();
    expect(backdrop?.className).toContain('pointer-events-auto');

    await clickElement(backdrop);

    expect(useStore.getState().setDockVisible).toHaveBeenCalledWith(false);
  });

  it('右键看板时菜单锚点按容器内真实中心点定位', async () => {
    await renderBoardDock();

    const dockContainer = container.querySelector('.board-dock-container') as HTMLDivElement | null;
    const boardButton = container.querySelector('[data-board-id="board-2"]') as HTMLButtonElement | null;

    expect(dockContainer).not.toBeNull();
    expect(boardButton).not.toBeNull();

    Object.defineProperty(dockContainer!, 'offsetWidth', { configurable: true, value: 300 });
    dockContainer!.getBoundingClientRect = vi.fn(() => ({
      x: 40,
      y: 500,
      left: 40,
      top: 500,
      width: 300,
      height: 60,
      right: 340,
      bottom: 560,
      toJSON: () => ({}),
    } as DOMRect));

    Object.defineProperty(boardButton!, 'offsetLeft', { configurable: true, value: 120 });
    Object.defineProperty(boardButton!, 'offsetWidth', { configurable: true, value: 36 });
    Object.defineProperty(boardButton!, 'offsetTop', { configurable: true, value: 12 });
    boardButton!.getBoundingClientRect = vi.fn(() => ({
      x: 146,
      y: 514,
      left: 146,
      top: 514,
      width: 28,
      height: 36,
      right: 174,
      bottom: 550,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      boardButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const menu = container.querySelector('.board-dock-context-menu') as HTMLDivElement | null;

    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('实验板');
    expect(menu?.style.left).toBe('120px');
    expect(menu?.style.left).not.toBe('0px');
  });

  it('锚点计算不依赖 transform 后的屏幕坐标', async () => {
    await renderBoardDock();

    const dockContainer = container.querySelector('.board-dock-container') as HTMLDivElement | null;
    const boardButton = container.querySelector('[data-board-id="board-2"]') as HTMLButtonElement | null;

    expect(dockContainer).not.toBeNull();
    expect(boardButton).not.toBeNull();

    Object.defineProperty(dockContainer!, 'offsetWidth', { configurable: true, value: 400 });
    dockContainer!.getBoundingClientRect = vi.fn(() => ({
      x: 100,
      y: 420,
      left: 100,
      top: 420,
      width: 360,
      height: 72,
      right: 460,
      bottom: 492,
      toJSON: () => ({}),
    } as DOMRect));

    Object.defineProperty(boardButton!, 'offsetLeft', { configurable: true, value: 180 });
    Object.defineProperty(boardButton!, 'offsetWidth', { configurable: true, value: 40 });
    Object.defineProperty(boardButton!, 'offsetTop', { configurable: true, value: 8 });
    boardButton!.getBoundingClientRect = vi.fn(() => ({
      x: 262,
      y: 430,
      left: 262,
      top: 430,
      width: 36,
      height: 36,
      right: 298,
      bottom: 466,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      boardButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const menu = container.querySelector('.board-dock-context-menu') as HTMLDivElement | null;

    expect(menu).not.toBeNull();
    expect(menu?.style.left).toBe('200px');
  });

  it('恢复成功后在数据管理区保留局部反馈', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '导入成功。',
      summary: {
        importedBoardsCount: 1,
        importedNotesCount: 3,
        skippedNotesCount: 0,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('恢复备份'));

    const feedback = getImportFeedback();

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(findButtonByText('恢复备份')).not.toBeNull();
    expect(feedback?.textContent).toContain('导入成功。');
  });

  it('取消恢复时显示取消反馈', async () => {
    const importFromFile = vi.fn(async () => ({ status: 'cancelled' as const }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('恢复备份'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('已取消恢复备份。');
  });

  it('恢复失败时显示错误反馈', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'error' as const,
      message: '导入失败：备份文件损坏。',
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('恢复备份'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('导入失败：备份文件损坏。');
  });

  it('写入失败回滚时额外提示已回滚', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'error' as const,
      message: '导入失败：写入本地存储时出错，已回滚到导入前状态。',
      rolledBack: true,
      summary: {
        importedBoardsCount: 2,
        importedNotesCount: 5,
        skippedNotesCount: 1,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('恢复备份'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('已回滚到导入前状态，当前数据未被改动。');
    expect(getImportFeedback()?.textContent).not.toContain('导入 2 个看板');
  });

  it('存在摘要时显示导入计数', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '导入完成，已跳过 2 条异常便签。',
      summary: {
        importedBoardsCount: 2,
        importedNotesCount: 5,
        skippedNotesCount: 2,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [
          { code: 'INVALID_NOTE' as const, severity: 'error' as const, message: 'bad note', noteIndex: 1 },
          { code: 'ORPHAN_NOTE' as const, severity: 'error' as const, message: 'orphan note', noteIndex: 2 },
        ],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('恢复备份'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('导入 2 个看板 · 5 条便签 · 跳过 2 条异常便签');
  });

  it('存在迁移与回退摘要时显示额外说明', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '已导入旧版备份，并按当前规则完成兼容处理。',
      summary: {
        importedBoardsCount: 1,
        importedNotesCount: 1,
        skippedNotesCount: 0,
        migratedNotesCount: 1,
        renamedBoardsCount: 1,
        usedFallbackCurrentBoard: true,
        createdDefaultBoard: true,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('恢复备份'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('已自动补建默认看板。');
    expect(getImportFeedback()?.textContent).toContain('已兼容迁移 1 条旧版便签。');
    expect(getImportFeedback()?.textContent).toContain('有 1 个同名看板已按规则重命名。');
    expect(getImportFeedback()?.textContent).toContain('导入主板无效，已回退到首个可用看板。');
  });

  it('关闭设置面板后重新打开数据管理时不会残留旧导入反馈', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '导入成功。',
      summary: {
        importedBoardsCount: 1,
        importedNotesCount: 1,
        skippedNotesCount: 0,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('恢复备份'));
    expect(getImportFeedback()?.textContent).toContain('导入成功。');

    await clickElement(getSettingsButton());
    expect(getImportFeedback()).toBeNull();

    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
    expect(getImportFeedback()).toBeNull();
  });
});

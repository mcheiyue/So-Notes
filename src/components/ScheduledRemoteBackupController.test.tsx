import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const {
  mockInitialize,
  mockStart,
  mockStop,
  mockNotifyLocalChange,
  mockCreateService,
  mockLoadScheduledConfig,
  mockSaveScheduledConfig,
  mockLoadScheduledState,
  mockSaveScheduledState,
  mockLoadWebDavConfig,
  mockFlushNow,
  mockReadDiskStorageData,
  mockGetLatestUpdateTimestamp,
  mockTryStartBackupJob,
  mockCreateRemoteBackup,
} = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockStart: vi.fn(),
  mockStop: vi.fn(),
  mockNotifyLocalChange: vi.fn(),
  mockCreateService: vi.fn(),
  mockLoadScheduledConfig: vi.fn(),
  mockSaveScheduledConfig: vi.fn(),
  mockLoadScheduledState: vi.fn(),
  mockSaveScheduledState: vi.fn(),
  mockLoadWebDavConfig: vi.fn(),
  mockFlushNow: vi.fn(),
  mockReadDiskStorageData: vi.fn(),
  mockGetLatestUpdateTimestamp: vi.fn(),
  mockTryStartBackupJob: vi.fn(),
  mockCreateRemoteBackup: vi.fn(),
}));

vi.mock('../services/backup/ScheduledRemoteBackupService', () => ({
  createScheduledRemoteBackupService: mockCreateService,
  registerSchedulerService: vi.fn(),
  unregisterSchedulerService: vi.fn(),
}));

vi.mock('../services/backup/ScheduledRemoteBackupConfigService', () => ({
  loadConfig: mockLoadScheduledConfig,
  saveConfig: mockSaveScheduledConfig,
  loadState: mockLoadScheduledState,
  saveState: mockSaveScheduledState,
}));

vi.mock('../services/backup/WebDavBackupService', () => ({
  loadConfig: mockLoadWebDavConfig,
  createRemoteBackup: mockCreateRemoteBackup,
}));

vi.mock('../services/storage/PersistenceFacade', () => ({
  flushNow: mockFlushNow,
}));

vi.mock('../services/storage/tauriPersistence', () => ({
  readDiskStorageData: mockReadDiskStorageData,
  getLatestUpdateTimestamp: mockGetLatestUpdateTimestamp,
}));

vi.mock('../services/backup/BackupJobCoordinator', () => ({
  tryStartBackupJob: mockTryStartBackupJob,
}));

const {
  mockListen,
  mockInvoke,
} = vi.hoisted(() => ({
  mockListen: vi.fn().mockResolvedValue(vi.fn()),
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../services/backup/quitHandler', () => ({
  handleQuitRequest: vi.fn().mockResolvedValue(undefined),
}));

import { ScheduledRemoteBackupController } from './ScheduledRemoteBackupController';
import type { AppActivitySignals } from '../services/backup/ScheduledRemoteBackupService';
import { useDomainStore } from '../store/domainStore';
import { handleQuitRequest } from '../services/backup/quitHandler';

function stubService() {
  return {
    initialize: mockInitialize,
    start: mockStart,
    stop: mockStop,
    notifyLocalChange: mockNotifyLocalChange,
    runNow: vi.fn(),
    runBeforeExit: vi.fn(),
    updateConfig: vi.fn(),
    clearCredentialFailure: vi.fn(),
    getState: vi.fn(() => ({
      timerId: null,
      config: { enabled: false, frequency: 'daily', quietPeriodMinutes: 5, exitPromptEnabled: true },
      state: {},
      isRunning: false,
      quietPeriodTimer: null,
      hasPendingLocalChanges: false,
    })),
  };
}

describe('ScheduledRemoteBackupController', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInitialize.mockReset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockNotifyLocalChange.mockReset();
    mockCreateService.mockReset();
    mockLoadScheduledConfig.mockReset();
    mockSaveScheduledConfig.mockReset();
    mockLoadScheduledState.mockReset();
    mockSaveScheduledState.mockReset();
    mockLoadWebDavConfig.mockReset();
    mockFlushNow.mockReset();
    mockReadDiskStorageData.mockReset();
    mockGetLatestUpdateTimestamp.mockReset();
    mockTryStartBackupJob.mockReset();
    mockCreateRemoteBackup.mockReset();
    mockListen.mockReset();
    mockListen.mockResolvedValue(vi.fn());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);

    mockCreateService.mockReturnValue(stubService());
    mockLoadScheduledConfig.mockResolvedValue({
      success: true,
      config: { enabled: false, frequency: 'daily', quietPeriodMinutes: 5, exitPromptEnabled: true },
      error: null,
    });
    mockSaveScheduledConfig.mockResolvedValue({ success: true, error: null });
    mockLoadScheduledState.mockResolvedValue({ success: true, state: null, error: null });
    mockSaveScheduledState.mockResolvedValue({ success: true, error: null });
    mockLoadWebDavConfig.mockResolvedValue({ success: false, passwordSaved: false });
    mockFlushNow.mockResolvedValue(true);
    mockReadDiskStorageData.mockResolvedValue(null);
    mockGetLatestUpdateTimestamp.mockReturnValue(0);
    mockTryStartBackupJob.mockReturnValue(null);
    mockCreateRemoteBackup.mockResolvedValue({ success: false });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('挂载时创建并初始化服务', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    expect(mockCreateService).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('卸载时停止服务并清理订阅', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    await act(async () => {
      root.unmount();
    });

    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('domain store 变更时调用 notifyLocalChange', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    await act(async () => {
      useDomainStore.getState().addNote({ x: 100, y: 100 });
    });

    expect(mockNotifyLocalChange).toHaveBeenCalled();
  });

  it('config enabled 时服务被初始化', async () => {
    mockLoadScheduledConfig.mockResolvedValueOnce({
      success: true,
      config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5, exitPromptEnabled: true },
      error: null,
    });

    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('config disabled 时服务被初始化但不启动调度', async () => {
    mockLoadScheduledConfig.mockResolvedValueOnce({
      success: true,
      config: { enabled: false, frequency: 'daily', quietPeriodMinutes: 5, exitPromptEnabled: true },
      error: null,
    });

    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('卸载后不再响应 domain store 变更', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    await act(async () => {
      root.unmount();
    });

    mockNotifyLocalChange.mockClear();

    await act(async () => {
      useDomainStore.getState().addNote({ x: 200, y: 200 });
    });

    expect(mockNotifyLocalChange).not.toHaveBeenCalled();
  });

  it('不依赖 BoardDock 状态', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    expect(mockCreateService).toHaveBeenCalledTimes(1);
  });

  it('initialize 未完成时卸载，initialize 完成后不再启动定时器且 stop 被调用', async () => {
    let resolveInitialize!: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInitialize = resolve;
    });

    const serviceInstance = {
      ...stubService(),
      initialize: vi.fn(() => initPromise),
    };
    mockCreateService.mockReturnValue(serviceInstance);

    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    expect(mockCreateService).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });

    expect(mockStop).toHaveBeenCalledTimes(1);

    mockNotifyLocalChange.mockClear();

    await act(async () => {
      resolveInitialize();
    });

    expect(mockStop).toHaveBeenCalledTimes(2);

    await act(async () => {
      useDomainStore.getState().addNote({ x: 300, y: 300 });
    });

    expect(mockNotifyLocalChange).not.toHaveBeenCalled();
  });

  it('退出前事件传入的 runBeforeExit 调用当前调度服务', async () => {
    const runBeforeExit = vi.fn().mockResolvedValue(undefined);
    const serviceInstance = {
      ...stubService(),
      runBeforeExit,
    };
    mockCreateService.mockReturnValue(serviceInstance);

    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    const listener = mockListen.mock.calls.find(
      ([event]) => event === 'remote-backup-before-quit-requested',
    )?.[1] as (() => Promise<void>) | undefined;

    expect(listener).toBeDefined();

    await act(async () => {
      await listener!();
    });

    const { calls: quitCalls } = vi.mocked(handleQuitRequest).mock;
    const passedRunBeforeExit = quitCalls[quitCalls.length - 1]?.[0];
    const passedDeps = quitCalls[quitCalls.length - 1]?.[1];
    expect(passedRunBeforeExit).toBeDefined();
    expect(passedDeps?.flushNow).toBe(mockFlushNow);

    await passedRunBeforeExit!();

    expect(runBeforeExit).toHaveBeenCalledTimes(1);
  });

  it('退出前调度服务不可用时 runBeforeExit reject，避免未备份就退出', async () => {
    const serviceInstance = {
      ...stubService(),
      initialize: vi.fn().mockRejectedValue(new Error('初始化失败')),
    };
    mockCreateService.mockReturnValue(serviceInstance);

    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const listener = mockListen.mock.calls.find(
      ([event]) => event === 'remote-backup-before-quit-requested',
    )?.[1] as (() => Promise<void>) | undefined;

    expect(listener).toBeDefined();

    await act(async () => {
      await listener!();
    });

    const { calls: quitCallsRetry } = vi.mocked(handleQuitRequest).mock;
    const passedRunBeforeExit = quitCallsRetry[quitCallsRetry.length - 1]?.[0];
    expect(passedRunBeforeExit).toBeDefined();

    await expect(passedRunBeforeExit!()).rejects.toThrow('退出前备份服务尚未就绪');
  });
});

describe('ScheduledRemoteBackupController getAppActivity', () => {
  let container: HTMLDivElement;
  let root: Root;
  let capturedGetAppActivity: (() => AppActivitySignals) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInitialize.mockReset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockNotifyLocalChange.mockReset();
    mockCreateService.mockReset();
    mockLoadScheduledConfig.mockReset();
    mockSaveScheduledConfig.mockReset();
    mockLoadScheduledState.mockReset();
    mockSaveScheduledState.mockReset();
    mockLoadWebDavConfig.mockReset();
    mockFlushNow.mockReset();
    mockReadDiskStorageData.mockReset();
    mockGetLatestUpdateTimestamp.mockReset();
    mockTryStartBackupJob.mockReset();
    mockCreateRemoteBackup.mockReset();
    mockListen.mockReset();
    mockListen.mockResolvedValue(vi.fn());
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);

    capturedGetAppActivity = undefined;
    mockCreateService.mockImplementation((deps: Record<string, unknown>) => {
      capturedGetAppActivity = deps.getAppActivity as () => AppActivitySignals;
      return stubService();
    });
    mockLoadScheduledConfig.mockResolvedValue({
      success: true,
      config: { enabled: false, frequency: 'daily', quietPeriodMinutes: 5, exitPromptEnabled: true },
      error: null,
    });
    mockSaveScheduledConfig.mockResolvedValue({ success: true, error: null });
    mockLoadScheduledState.mockResolvedValue({ success: true, state: null, error: null });
    mockSaveScheduledState.mockResolvedValue({ success: true, error: null });
    mockLoadWebDavConfig.mockResolvedValue({ success: false, passwordSaved: false });
    mockFlushNow.mockResolvedValue(true);
    mockReadDiskStorageData.mockResolvedValue(null);
    mockGetLatestUpdateTimestamp.mockReturnValue(0);
    mockTryStartBackupJob.mockReturnValue(null);
    mockCreateRemoteBackup.mockResolvedValue({ success: false });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scheduler 依赖注入了 getAppActivity', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    expect(mockCreateService).toHaveBeenCalledTimes(1);
    expect(capturedGetAppActivity).toBeDefined();
  });

  it('无焦点元素时 isTextEditing 为 false', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    expect(capturedGetAppActivity).toBeDefined();
    expect(capturedGetAppActivity!().isTextEditing).toBe(false);
  });

  it('input 获焦时 isTextEditing 为 true', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    expect(capturedGetAppActivity!().isTextEditing).toBe(true);

    input.blur();
    document.body.removeChild(input);
  });

  it('textarea 获焦时 isTextEditing 为 true', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    expect(capturedGetAppActivity!().isTextEditing).toBe(true);

    textarea.blur();
    document.body.removeChild(textarea);
  });

  it('contentEditable 元素获焦时 isTextEditing 为 true', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');

    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(Document.prototype, 'activeElement', {
      get: () => div,
      configurable: true,
    });

    const result = capturedGetAppActivity!().isTextEditing;

    Object.defineProperty(Document.prototype, 'activeElement', originalDescriptor!);

    expect(result).toBe(true);
  });

  it('非编辑元素获焦时 isTextEditing 为 false', async () => {
    await act(async () => {
      root.render(<ScheduledRemoteBackupController />);
    });

    const div = document.createElement('div');
    document.body.appendChild(div);
    div.focus();

    expect(capturedGetAppActivity!().isTextEditing).toBe(false);

    div.blur();
    document.body.removeChild(div);
  });
});

describe('ScheduledRemoteBackupController detached 隔离', () => {
  it('detached-main.tsx 不导入 ScheduledRemoteBackupController', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const detachedMainPath = path.resolve(__dirname, '../detached-main.tsx');
    const content = fs.readFileSync(detachedMainPath, 'utf-8');

    expect(content).not.toContain('ScheduledRemoteBackupController');
  });

  it('App.tsx 是唯一的挂载位置', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appPath = path.resolve(__dirname, '../App.tsx');
    const appContent = fs.readFileSync(appPath, 'utf-8');

    expect(appContent).toContain('ScheduledRemoteBackupController');
  });
});

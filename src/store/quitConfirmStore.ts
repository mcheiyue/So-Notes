import { create } from 'zustand';

/** 退出前确认的用户选择 */
export type QuitChoice = 'backup-and-quit' | 'quit-now' | 'cancel';

export type BackupFailedChoice = 'quit-anyway' | 'cancel';

type ResolveFn = (value: QuitChoice) => void;
type BackupFailedResolveFn = (value: BackupFailedChoice) => void;

interface QuitConfirmStoreState {
  isOpen: boolean;
  resolve: ResolveFn | null;
  isBackingUp: boolean;
  backupError: string | null;
  resolveBackupFailed: BackupFailedResolveFn | null;
  open: (resolve: ResolveFn) => void;
  close: () => void;
  setBackingUp: (value: boolean) => void;
  setBackupError: (error: string | null, resolve: BackupFailedResolveFn | null) => void;
}

export const useQuitConfirmStore = create<QuitConfirmStoreState>()((set) => ({
  isOpen: false,
  resolve: null,
  isBackingUp: false,
  backupError: null,
  resolveBackupFailed: null,
  open: (resolve) => {
    const previousResolve = useQuitConfirmStore.getState().resolve;
    previousResolve?.('cancel');
    set({ isOpen: true, resolve, isBackingUp: false, backupError: null, resolveBackupFailed: null });
  },
  close: () => set({ isOpen: false, resolve: null, isBackingUp: false, backupError: null, resolveBackupFailed: null }),
  setBackingUp: (value) => set({ isBackingUp: value }),
  setBackupError: (error, resolve) => set({ backupError: error, resolveBackupFailed: resolve, isBackingUp: false, isOpen: true }),
}));

/**
 * 命令式退出确认 API，返回用户选择结果。
 *
 * ```ts
 * const choice = await promptQuitConfirm();
 * // 'backup-and-quit' | 'quit-now' | 'cancel'
 * ```
 */
export const promptQuitConfirm = (): Promise<QuitChoice> => {
  return new Promise<QuitChoice>((resolve) => {
    useQuitConfirmStore.getState().open(resolve);
  });
};

export const promptBackupFailed = (error: string): Promise<BackupFailedChoice> => {
  return new Promise<BackupFailedChoice>((resolve) => {
    useQuitConfirmStore.getState().setBackupError(error, resolve);
  });
};

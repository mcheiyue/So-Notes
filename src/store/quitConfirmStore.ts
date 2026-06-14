import { create } from 'zustand';

/** 退出前确认的用户选择 */
export type QuitChoice = 'backup-and-quit' | 'quit-now' | 'cancel';

type ResolveFn = (value: QuitChoice) => void;

interface QuitConfirmStoreState {
  isOpen: boolean;
  resolve: ResolveFn | null;
  /** 备份进行中标志，防止重复触发 */
  isBackingUp: boolean;
  open: (resolve: ResolveFn) => void;
  close: () => void;
  setBackingUp: (value: boolean) => void;
}

export const useQuitConfirmStore = create<QuitConfirmStoreState>()((set) => ({
  isOpen: false,
  resolve: null,
  isBackingUp: false,
  open: (resolve) => {
    // 关闭已有的等待
    const previousResolve = useQuitConfirmStore.getState().resolve;
    previousResolve?.('cancel');
    set({ isOpen: true, resolve, isBackingUp: false });
  },
  close: () => set({ isOpen: false, resolve: null, isBackingUp: false }),
  setBackingUp: (value) => set({ isBackingUp: value }),
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

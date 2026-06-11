import { create } from 'zustand';

/** 命令式确认对话框的选项 */
export interface ConfirmOptions {
  title?: string;
  message: string;
  /** 'default' 使用常规样式，'danger' 使用红色警告样式 */
  kind?: 'default' | 'danger';
  confirmText?: string;
  cancelText?: string;
}

type ResolveFn = (value: boolean) => void;

interface ConfirmStoreState {
  isOpen: boolean;
  options: ConfirmOptions;
  resolve: ResolveFn | null;
  open: (options: ConfirmOptions, resolve: ResolveFn) => void;
  close: () => void;
}

const DEFAULT_OPTIONS: ConfirmOptions = { message: '' };

export const useConfirmStore = create<ConfirmStoreState>()((set) => ({
  isOpen: false,
  options: DEFAULT_OPTIONS,
  resolve: null,
  open: (options, resolve) => set((state) => {
    state.resolve?.(false);

    return { isOpen: true, options, resolve };
  }),
  close: () => set({ isOpen: false, options: DEFAULT_OPTIONS, resolve: null }),
}));

/**
 * 命令式确认 API，返回用户选择结果。
 *
 * ```ts
 * const ok = await confirm({ title: '确认', message: '是否继续？' });
 * ```
 */
export const confirm = (options: ConfirmOptions): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().open(options, resolve);
  });
};

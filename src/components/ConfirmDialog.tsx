import React, { useCallback, useEffect, useRef } from 'react';
import { useConfirmStore } from '../store/confirmStore';
import { Z_INDEX } from '../constants/layout';

/**
 * 全局确认对话框，由 App.tsx 挂载一次。
 * 通过 `confirmStore.confirm()` 命令式调用。
 */
export const ConfirmDialog: React.FC = () => {
  const isOpen = useConfirmStore((s) => s.isOpen);
  const options = useConfirmStore((s) => s.options);
  const resolve = useConfirmStore((s) => s.resolve);
  const close = useConfirmStore((s) => s.close);

  const resolvedRef = useRef(false);

  const handleResolve = useCallback(
    (value: boolean) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      resolve?.(value);
      close();
    },
    [resolve, close],
  );

  // 每次打开时重置防重复标志
  useEffect(() => {
    if (isOpen) {
      resolvedRef.current = false;
    }
  }, [isOpen]);

  // Escape 键关闭
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        handleResolve(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleResolve]);

  if (!isOpen) return null;

  const kind = options.kind ?? 'default';
  const confirmText = options.confirmText ?? '确认';
  const cancelText = options.cancelText ?? '取消';

  return (
    <div
      className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm"
      style={{ zIndex: Z_INDEX.CONFIRM_DIALOG }}
      role="dialog"
      aria-modal="true"
      aria-label={options.title ?? '确认操作'}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* 背景遮罩：danger 不响应遮罩点击，防止误关 */}
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="关闭确认对话框"
        onClick={kind !== 'danger' ? () => handleResolve(false) : undefined}
      />

      {/* 面板 */}
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-secondary-bg/95 shadow-2xl animate-in fade-in zoom-in-95 duration-150 origin-center">
        {options.title && (
          <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-text-secondary">
            {options.title}
          </div>
        )}

        <div className="px-5 py-4 text-sm text-text-primary whitespace-pre-line leading-relaxed">
          {options.message}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-primary-bg transition-colors"
            onClick={() => handleResolve(false)}
            autoFocus={kind === 'danger'}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              kind === 'danger'
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
            onClick={() => handleResolve(true)}
            autoFocus={kind !== 'danger'}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

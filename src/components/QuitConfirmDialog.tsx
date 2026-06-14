import React, { useCallback, useEffect, useRef } from 'react';
import { useQuitConfirmStore } from '../store/quitConfirmStore';
import type { QuitChoice } from '../store/quitConfirmStore';
import { Z_INDEX } from '../constants/layout';

/**
 * 退出前备份确认对话框，由 App.tsx 挂载一次。
 * 提供三选项："先备份再退出"、"直接退出"、"取消"。
 * 备份进行中时禁用按钮防止重复操作。
 */
export const QuitConfirmDialog: React.FC = () => {
  const isOpen = useQuitConfirmStore((s) => s.isOpen);
  const resolve = useQuitConfirmStore((s) => s.resolve);
  const close = useQuitConfirmStore((s) => s.close);
  const isBackingUp = useQuitConfirmStore((s) => s.isBackingUp);
  const backupError = useQuitConfirmStore((s) => s.backupError);
  const resolveBackupFailed = useQuitConfirmStore((s) => s.resolveBackupFailed);

  const resolvedRef = useRef(false);

  const handleChoice = useCallback(
    (choice: QuitChoice) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      resolve?.(choice);
      if (choice !== 'backup-and-quit') {
        close();
      }
    },
    [resolve, close],
  );

  // 每次打开时重置防重复标志
  useEffect(() => {
    if (isOpen) {
      resolvedRef.current = false;
    }
  }, [isOpen]);

  const handleBackupFailedChoice = useCallback(
    (choice: 'quit-anyway' | 'cancel') => {
      resolveBackupFailed?.(choice);
      close();
    },
    [resolveBackupFailed, close],
  );

  // Escape 键关闭（等同取消）
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        if (backupError) {
          handleBackupFailedChoice('cancel');
        } else {
          handleChoice('cancel');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleChoice, backupError, handleBackupFailedChoice]);

  if (!isOpen) return null;

  return (
    <div
      className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm"
      style={{ zIndex: Z_INDEX.CONFIRM_DIALOG }}
      role="dialog"
      aria-modal="true"
      aria-label="退出前备份确认"
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* 背景遮罩：不可点击关闭，防止误操作 */}
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="关闭退出确认对话框"
      />

      {/* 面板 */}
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-secondary-bg/95 shadow-2xl animate-in fade-in zoom-in-95 duration-150 origin-center">
        <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-text-secondary">
          退出前备份
        </div>

        <div className="px-5 py-4 text-sm text-text-primary whitespace-pre-line leading-relaxed">
          {backupError
            ? `备份失败：${backupError}\n是否仍然退出？`
            : isBackingUp
              ? '正在创建远端备份，请稍候…'
              : '检测到远端备份已启用。是否在退出前先创建一次远端备份？'}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          {backupError ? (
            <>
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-primary-bg transition-colors"
                onClick={() => handleBackupFailedChoice('cancel')}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
                onClick={() => handleBackupFailedChoice('quit-anyway')}
                autoFocus
              >
                仍然退出
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-primary-bg transition-colors"
                onClick={() => handleChoice('cancel')}
                disabled={isBackingUp}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-primary-bg transition-colors"
                onClick={() => handleChoice('quit-now')}
                disabled={isBackingUp}
              >
                直接退出
              </button>
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
                onClick={() => handleChoice('backup-and-quit')}
                disabled={isBackingUp}
                autoFocus
              >
                {isBackingUp ? '备份中…' : '先备份再退出'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

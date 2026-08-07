import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store/useStore';
import { attach } from '../services/storage/StorageService';
import type { AttachResult } from '../services/storage/types';
import * as persistenceFacade from '../services/storage/PersistenceFacade';

const getCurrentDomainState = () => {
  const state = useStore.getState();
  return {
    notesById: state.notesById,
    allNoteIds: state.allNoteIds,
    boardNoteIds: state.boardNoteIds,
    layoutNotesById: state.layoutNotesById,
    boards: state.boards,
    currentBoardId: state.currentBoardId,
    config: state.config,
  };
};

const getTraySaveStatusCopy = (saveStatus: string, saveError: string | null): string | null => {
  if (saveStatus === 'saving') return '保存中';
  if (saveStatus === 'error') {
    const detail = saveError?.trim();
    if (!detail) return '保存失败';
    const clippedDetail = detail.length > 24 ? `${detail.slice(0, 24)}…` : detail;
    return `保存失败：${clippedDetail}`;
  }
  return null;
};

const buildTrayTooltip = (boardName: string, saveStatus: string, saveError: string | null) => {
  const normalizedBoardName = boardName.trim() || '主板';
  const statusCopy = getTraySaveStatusCopy(saveStatus, saveError);
  if (!statusCopy) return `SoNotes · 当前看板：${normalizedBoardName}`;
  return `SoNotes · 当前看板：${normalizedBoardName} · ${statusCopy}`;
};

export const PersistenceController = () => {
  const storageHandleRef = useRef<AttachResult | null>(null);
  const boards = useStore((s) => s.boards);
  const currentBoardId = useStore((s) => s.currentBoardId);
  const saveStatus = useStore((s) => s.saveStatus);
  const saveError = useStore((s) => s.saveError);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      if (!useStore.getState().isLoaded) {
        await useStore.getState().init();
        if (cancelled) return;
      }

      const handle = attach({
        initialState: getCurrentDomainState(),
        onStatusChange: (status) => {
          switch (status) {
            case 'writing-wal':
            case 'writing-disk':
              useStore.setState({ isSaving: true, saveStatus: 'saving', saveError: null });
              break;
            case 'idle':
              useStore.setState({ isSaving: false, saveStatus: 'saved', saveError: null, lastSavedAt: Date.now() });
              break;
            case 'error':
              useStore.setState({ isSaving: false, saveStatus: 'error', saveError: '持久化写入失败。' });
              break;
          }
        },
      });

      storageHandleRef.current = handle;
      persistenceFacade.attach(handle);
    };

    bootstrap();

    return () => {
      cancelled = true;
      persistenceFacade.detach();
      storageHandleRef.current?.detach();
      storageHandleRef.current = null;
    };
  }, []);

  // 托盘 tooltip：saveStatus 仅在 useStore，随 Persistence 白名单文件订阅
  useEffect(() => {
    const currentBoard = boards.find((board) => board.id === currentBoardId);
    const tooltip = buildTrayTooltip(currentBoard?.name ?? '主板', saveStatus, saveError);
    invoke('set_tray_tooltip', { tooltip }).catch((error) => {
      console.warn('Failed to update tray tooltip:', error);
    });
  }, [boards, currentBoardId, saveError, saveStatus]);

  return null;
};

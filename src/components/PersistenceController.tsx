import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { attach } from '../services/storage/StorageService';
import type { AttachResult } from '../services/storage/types';
import * as persistenceFacade from '../services/storage/PersistenceFacade';

export const PersistenceController = () => {
  const storageHandleRef = useRef<AttachResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      if (!useStore.getState().isLoaded) {
        await useStore.getState().init();
        if (cancelled) return;
      }

      const handle = attach({
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

  return null;
};

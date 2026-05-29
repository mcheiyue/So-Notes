import { useEffect, useRef, useCallback, useState } from 'react';
import { useDomainStore } from '../store';
import { Note, Board } from '../store/types';
import type {
  SearchWorkerMessage,
  SearchWorkerResponse,
  SearchFilter,
  SearchResultsGroup,
} from '../workers/searchWorker';

export function useSearchWorker() {
  const workerRef = useRef<Worker | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [groups, setGroups] = useState<SearchResultsGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const pendingQueryRef = useRef<string | null>(null);

  const notesById = useDomainStore((state) => state.notesById);
  const boards = useDomainStore((state) => state.boards);
  const currentBoardId = useDomainStore((state) => state.currentBoardId);

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/searchWorker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e: MessageEvent<SearchWorkerResponse>) => {
      const msg = e.data;

      switch (msg.type) {
        case 'INDEX_BUILT':
          setIsReady(true);
          break;

        case 'SEARCH_RESULTS':
          if (msg.query === pendingQueryRef.current) {
            setGroups(msg.groups);
            setTotal(msg.total);
            setIsSearching(false);
            pendingQueryRef.current = null;
          }
          break;

        case 'ERROR':
          console.error('Search worker error:', msg.error);
          setIsSearching(false);
          break;
      }
    };

    worker.onerror = (error) => {
      console.error('Search worker error:', error);
      setIsSearching(false);
    };

    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workerRef.current) return;

    const notes = Object.values(notesById);
    const msg: SearchWorkerMessage = {
      type: 'BUILD_INDEX',
      notes,
      boards,
    };
    workerRef.current.postMessage(msg);
  }, [notesById, boards]);

  const search = useCallback((query: string, filter: SearchFilter) => {
    if (!workerRef.current || !isReady) return;

    pendingQueryRef.current = query;
    setIsSearching(true);

    const msg: SearchWorkerMessage = {
      type: 'SEARCH',
      query,
      filter,
    };
    workerRef.current.postMessage(msg);
  }, [isReady]);

  const clearSearch = useCallback(() => {
    pendingQueryRef.current = null;
    setIsSearching(false);
    setGroups([]);
    setTotal(0);
  }, []);

  const updateNotes = useCallback((notes: Note[]) => {
    if (!workerRef.current) return;

    const msg: SearchWorkerMessage = {
      type: 'UPDATE_NOTES',
      notes,
    };
    workerRef.current.postMessage(msg);
  }, []);

  const updateBoards = useCallback((boards: Board[]) => {
    if (!workerRef.current) return;

    const msg: SearchWorkerMessage = {
      type: 'UPDATE_BOARDS',
      boards,
    };
    workerRef.current.postMessage(msg);
  }, []);

  return {
    isReady,
    isSearching,
    groups,
    total,
    search,
    clearSearch,
    updateNotes,
    updateBoards,
    currentBoardId,
  };
}

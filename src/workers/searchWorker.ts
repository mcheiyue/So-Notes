import { Note, Board } from '../store/types';

export interface SearchResultItem {
  note: Note;
  score: number;
  matchType: 'title-exact' | 'title-starts' | 'title-contains' | 'content-contains';
  boardName?: string;
}

export interface SearchResultsGroup {
  type: 'current-board' | 'other-board' | 'title-match' | 'content-match';
  label: string;
  items: SearchResultItem[];
}

export interface SearchFilter {
  scope: 'current-board' | 'all-boards';
  currentBoardId?: string;
}

export type SearchWorkerMessage =
  | { type: 'BUILD_INDEX'; notes: Note[]; boards: Board[] }
  | { type: 'SEARCH'; query: string; filter: SearchFilter }
  | { type: 'UPDATE_NOTES'; notes: Note[] }
  | { type: 'UPDATE_BOARDS'; boards: Board[] };

export type SearchWorkerResponse =
  | { type: 'INDEX_BUILT' }
  | { type: 'SEARCH_RESULTS'; query: string; groups: SearchResultsGroup[]; total: number }
  | { type: 'ERROR'; error: string };

interface SearchIndex {
  notesById: Map<string, Note>;
  boardsById: Map<string, Board>;
  titleIndex: Map<string, string[]>;
  contentIndex: Map<string, string[]>;
}

let index: SearchIndex | null = null;

function buildIndex(notes: Note[], boards: Board[]): void {
  const notesById = new Map<string, Note>();
  const boardsById = new Map<string, Board>();
  const titleIndex = new Map<string, string[]>();
  const contentIndex = new Map<string, string[]>();

  for (const board of boards) {
    boardsById.set(board.id, board);
  }

  for (const note of notes) {
    notesById.set(note.id, note);

    const title = (note.title || '').toLowerCase();
    if (title) {
      const words = title.split(/\s+/).filter(w => w.length > 0);
      for (const word of words) {
        if (!titleIndex.has(word)) {
          titleIndex.set(word, []);
        }
        titleIndex.get(word)!.push(note.id);
      }
      if (!titleIndex.has(title)) {
        titleIndex.set(title, []);
      }
      titleIndex.get(title)!.push(note.id);
    }

    const content = (note.content || '').toLowerCase().slice(0, 1000);
    if (content) {
      const words = content.split(/\s+/).filter(w => w.length > 0);
      for (const word of words) {
        if (!contentIndex.has(word)) {
          contentIndex.set(word, []);
        }
        contentIndex.get(word)!.push(note.id);
      }
    }
  }

  index = { notesById, boardsById, titleIndex, contentIndex };
}

function search(query: string, filter: SearchFilter): { groups: SearchResultsGroup[]; total: number } {
  if (!index) {
    return { groups: [], total: 0 };
  }

  const q = query.toLowerCase().trim();
  if (!q) {
    return { groups: [], total: 0 };
  }

  const { notesById, boardsById, titleIndex, contentIndex } = index;
  const scored = new Map<string, { note: Note; score: number; matchType: SearchResultItem['matchType'] }>();

  for (const [key, noteIds] of titleIndex.entries()) {
    if (key.includes(q)) {
      for (const id of noteIds) {
        if (scored.has(id)) continue;
        
        const note = notesById.get(id);
        if (!note) continue;

        // 应用筛选
        if (!matchesFilter(note, filter)) continue;

        const title = (note.title || '').toLowerCase();
        let matchType: SearchResultItem['matchType'] = 'title-contains';
        let score = 60;

        if (title === q) {
          matchType = 'title-exact';
          score = 100;
        } else if (title.startsWith(q)) {
          matchType = 'title-starts';
          score = 80;
        }

        scored.set(id, { note, score, matchType });
      }
    }
  }

  for (const [key, noteIds] of contentIndex.entries()) {
    if (key.includes(q)) {
      for (const id of noteIds) {
        if (scored.has(id)) continue;

        const note = notesById.get(id);
        if (!note) continue;

        if (!matchesFilter(note, filter)) continue;

        scored.set(id, { note, score: 40, matchType: 'content-contains' });
      }
    }
  }

  const results = Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  const items: SearchResultItem[] = results.map(r => ({
    ...r,
    boardName: boardsById.get(r.note.boardId)?.name,
  }));

  const groups = groupResults(items, filter);

  return { groups, total: items.length };
}

function matchesFilter(note: Note, filter: SearchFilter): boolean {
  if (note.deletedAt) {
    return false;
  }

  if (filter.scope === 'current-board' && filter.currentBoardId) {
    return note.boardId === filter.currentBoardId;
  }

  return true;
}

function groupResults(items: SearchResultItem[], filter: SearchFilter): SearchResultsGroup[] {
  const groups: SearchResultsGroup[] = [];

  if (filter.currentBoardId) {
    const currentBoardItems = items.filter(item => 
      item.note.boardId === filter.currentBoardId && !item.note.deletedAt
    );
    if (currentBoardItems.length > 0) {
      groups.push({
        type: 'current-board',
        label: '当前看板',
        items: currentBoardItems,
      });
    }
  }

  const titleMatchItems = items.filter(item => 
    item.matchType !== 'content-contains' && 
    item.note.boardId !== filter.currentBoardId &&
    !item.note.deletedAt
  );
  if (titleMatchItems.length > 0) {
    groups.push({
      type: 'title-match',
      label: '标题匹配',
      items: titleMatchItems,
    });
  }

  const contentMatchItems = items.filter(item => 
    item.matchType === 'content-contains' && 
    !item.note.deletedAt
  );
  if (contentMatchItems.length > 0) {
    groups.push({
      type: 'content-match',
      label: '内容匹配',
      items: contentMatchItems,
    });
  }

  return groups;
}

self.onmessage = (e: MessageEvent<SearchWorkerMessage>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case 'BUILD_INDEX': {
        buildIndex(msg.notes, msg.boards);
        self.postMessage({ type: 'INDEX_BUILT' } as SearchWorkerResponse);
        break;
      }

      case 'SEARCH': {
        const result = search(msg.query, msg.filter);
        self.postMessage({
          type: 'SEARCH_RESULTS',
          query: msg.query,
          groups: result.groups,
          total: result.total,
        } as SearchWorkerResponse);
        break;
      }

      case 'UPDATE_NOTES': {
        if (index) {
          for (const note of msg.notes) {
            index.notesById.set(note.id, note);
            
            const title = (note.title || '').toLowerCase();
            if (title) {
              const words = title.split(/\s+/).filter(w => w.length > 0);
              for (const word of words) {
                if (!index.titleIndex.has(word)) {
                  index.titleIndex.set(word, []);
                }
                const ids = index.titleIndex.get(word)!;
                if (!ids.includes(note.id)) {
                  ids.push(note.id);
                }
              }
            }

            const content = (note.content || '').toLowerCase().slice(0, 1000);
            if (content) {
              const words = content.split(/\s+/).filter(w => w.length > 0);
              for (const word of words) {
                if (!index.contentIndex.has(word)) {
                  index.contentIndex.set(word, []);
                }
                const ids = index.contentIndex.get(word)!;
                if (!ids.includes(note.id)) {
                  ids.push(note.id);
                }
              }
            }
          }
        }
        break;
      }

      case 'UPDATE_BOARDS': {
        if (index) {
          for (const board of msg.boards) {
            index.boardsById.set(board.id, board);
          }
        }
        break;
      }

      default: {
        self.postMessage({ type: 'ERROR', error: `Unknown message type: ${(msg as { type: string }).type}` } as SearchWorkerResponse);
      }
    }
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
    } as SearchWorkerResponse);
  }
};

export type {};

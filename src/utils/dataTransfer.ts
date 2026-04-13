import { Note, Board, AppConfig, DEFAULT_BOARD } from '../store/types';

export const EXPORT_DATA_VERSION = 1;

type ExportType = 'FULL_BACKUP' | 'SINGLE_BOARD';
type ImportCompatibility = 'COMPATIBLE' | 'LEGACY' | 'UNSUPPORTED';

interface ParsedImportData {
  version: number;
  type: ExportType;
  source: 'so-notes';
  timestamp: number;
  payload: {
    boards: Board[];
    notes: unknown[];
    config?: AppConfig;
    currentBoardId?: string;
  };
}

interface ImportParseMeta {
  createdDefaultBoard: boolean;
}

export interface ExportData {
  version: number;
  type: ExportType;
  source: 'so-notes';
  timestamp: number;
  payload: {
    boards: Board[];
    notes: Note[];
    config?: AppConfig;
    currentBoardId?: string;
  };
}

export type ImportFailureCode =
  | 'INVALID_JSON'
  | 'INVALID_SOURCE'
  | 'INVALID_STRUCTURE'
  | 'UNSUPPORTED_VERSION';

export type ImportIssueCode =
  | 'INVALID_NOTE'
  | 'ORPHAN_NOTE'
  | 'MIGRATED_NOTE'
  | 'RENAMED_BOARD'
  | 'FALLBACK_CURRENT_BOARD'
  | 'CREATED_DEFAULT_BOARD';

export interface ImportIssue {
  code: ImportIssueCode;
  message: string;
  severity: 'warning' | 'error';
  noteIndex?: number;
  noteId?: string;
  boardName?: string;
}

export interface ImportSummary {
  importedBoardsCount: number;
  importedNotesCount: number;
  skippedNotesCount: number;
  migratedNotesCount: number;
  renamedBoardsCount: number;
  usedFallbackCurrentBoard: boolean;
  createdDefaultBoard: boolean;
  issues: ImportIssue[];
}

export interface SuccessfulImportResult {
  status: 'success';
  compatibility: Exclude<ImportCompatibility, 'UNSUPPORTED'>;
  data: {
    boards: Board[];
    notes: Note[];
    suggestedCurrentBoardId: string | null;
    type: ExportType;
    summary: ImportSummary;
  };
}

export interface FailedImportResult {
  status: 'error';
  code: ImportFailureCode;
  message: string;
}

export type ImportResult = SuccessfulImportResult | FailedImportResult;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isBoard = (value: unknown): value is Board => {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.icon === 'string' &&
    typeof value.createdAt === 'number'
  );
};

const isNote = (value: unknown): value is Note => {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === 'string' &&
    typeof value.boardId === 'string' &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.title === 'string' &&
    typeof value.content === 'string' &&
    typeof value.color === 'string' &&
    typeof value.z === 'number' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
};

const isAppConfig = (value: unknown): value is AppConfig => {
  if (!isRecord(value)) return false;

  return (
    typeof value.version === 'number' &&
    typeof value.maxZ === 'number' &&
    typeof value.themeMode === 'string'
  );
};

const isExportType = (value: unknown): value is ExportType =>
  value === 'FULL_BACKUP' || value === 'SINGLE_BOARD';

const buildImportError = (code: ImportFailureCode, message: string): FailedImportResult => ({
  status: 'error',
  code,
  message,
});

const buildImportIssue = (
  code: ImportIssueCode,
  message: string,
  severity: 'warning' | 'error',
  extras: Partial<Pick<ImportIssue, 'noteIndex' | 'noteId' | 'boardName'>> = {},
): ImportIssue => ({
  code,
  message,
  severity,
  ...extras,
});

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const getStringOrFallback = (value: unknown, fallback: string) =>
  typeof value === 'string' ? value : fallback;

const getNumberOrFallback = (value: unknown, fallback: number) =>
  isFiniteNumber(value) ? value : fallback;

const normalizeLegacyBoard = (value: unknown, index: number): Board | null => {
  if (!isRecord(value)) {
    return null;
  }

  const fallbackName = index === 0 ? DEFAULT_BOARD.name : `导入看板 ${index + 1}`;

  return {
    id: getStringOrFallback(value.id, `legacy-board-${index + 1}`),
    name: getStringOrFallback(value.name, fallbackName),
    icon: getStringOrFallback(value.icon, DEFAULT_BOARD.icon),
    createdAt: getNumberOrFallback(value.createdAt, Date.now()),
  };
};

const normalizeCompatibleExport = (data: Record<string, unknown>): ParsedImportData | null => {
  if (!isExportType(data.type)) {
    return null;
  }

  if (!isRecord(data.payload)) {
    return null;
  }

  const boards = data.payload.boards;
  const notes = data.payload.notes;
  const config = data.payload.config;
  const currentBoardId = data.payload.currentBoardId;

  if (!Array.isArray(boards) || !boards.every(isBoard)) {
    return null;
  }

  if (!Array.isArray(notes)) {
    return null;
  }

  if (config !== undefined && !isAppConfig(config)) {
    return null;
  }

  if (currentBoardId !== undefined && typeof currentBoardId !== 'string') {
    return null;
  }

  return {
    version: EXPORT_DATA_VERSION,
    type: data.type,
    source: 'so-notes',
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
    payload: {
      boards,
      notes,
      config,
      currentBoardId,
    },
  };
};

const normalizeLegacyExport = (data: Record<string, unknown>): {
  data: ParsedImportData | null;
  meta: ImportParseMeta;
} => {
  if (!isExportType(data.type)) {
    return {
      data: null,
      meta: { createdDefaultBoard: false },
    };
  }

  if (!isRecord(data.payload)) {
    return {
      data: null,
      meta: { createdDefaultBoard: false },
    };
  }

  const rawBoards = data.payload.boards;
  const notes = data.payload.notes;
  const config = data.payload.config;
  const currentBoardId = data.payload.currentBoardId;
  let createdDefaultBoard = false;

  let boards: Board[] = [];

  if (Array.isArray(rawBoards) && rawBoards.length > 0) {
    boards = rawBoards
      .map((board, index) => normalizeLegacyBoard(board, index))
      .filter((board): board is Board => board !== null);
  }

  if (boards.length === 0) {
    boards = [{
      ...DEFAULT_BOARD,
      id: DEFAULT_BOARD.id,
      name: DEFAULT_BOARD.name,
      icon: DEFAULT_BOARD.icon,
      createdAt: Date.now(),
    }];
    createdDefaultBoard = true;
  }

  if (!Array.isArray(notes)) {
    return {
      data: null,
      meta: { createdDefaultBoard },
    };
  }

  if (config !== undefined && !isAppConfig(config)) {
    return {
      data: null,
      meta: { createdDefaultBoard },
    };
  }

  if (currentBoardId !== undefined && typeof currentBoardId !== 'string') {
    return {
      data: null,
      meta: { createdDefaultBoard },
    };
  }

  return {
    data: {
      version: EXPORT_DATA_VERSION,
      type: data.type,
      source: 'so-notes',
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      payload: {
        boards,
        notes,
        config,
        currentBoardId,
      },
    },
    meta: { createdDefaultBoard },
  };
};

const normalizeLegacyNote = (
  rawNote: unknown,
  noteIndex: number,
  fallbackBoardId: string,
): {
  note: Note | null;
  migrated: boolean;
} => {
  if (!isRecord(rawNote)) {
    return {
      note: null,
      migrated: false,
    };
  }

  const createdAt = getNumberOrFallback(rawNote.createdAt, Date.now());
  const nextNote: Note = {
    id: getStringOrFallback(rawNote.id, `legacy-note-${noteIndex + 1}`),
    boardId: getStringOrFallback(rawNote.boardId, fallbackBoardId),
    x: getNumberOrFallback(rawNote.x, 20 + noteIndex * 10),
    y: getNumberOrFallback(rawNote.y, 20 + noteIndex * 10),
    title: getStringOrFallback(rawNote.title, ''),
    content: typeof rawNote.content === 'string'
      ? rawNote.content
      : getStringOrFallback(rawNote.text, ''),
    color: getStringOrFallback(rawNote.color, '#FFFFFF'),
    z: getNumberOrFallback(rawNote.z, noteIndex + 1),
    collapsed: typeof rawNote.collapsed === 'boolean' ? rawNote.collapsed : false,
    createdAt,
    updatedAt: getNumberOrFallback(rawNote.updatedAt, createdAt),
  };

  if (rawNote.deletedAt === null || isFiniteNumber(rawNote.deletedAt)) {
    nextNote.deletedAt = rawNote.deletedAt;
  }

  const migrated = !isNote(rawNote);

  return {
    note: nextNote,
    migrated,
  };
};

const parseImportData = (jsonContent: string): {
  compatibility: ImportCompatibility;
  data?: ParsedImportData;
  error?: FailedImportResult;
  meta: ImportParseMeta;
} => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonContent);
  } catch (error) {
    console.error('Import failed: invalid JSON', error);
    return {
      compatibility: 'UNSUPPORTED',
      meta: { createdDefaultBoard: false },
      error: buildImportError('INVALID_JSON', '导入失败：文件内容不是合法的 JSON。'),
    };
  }

  if (!isRecord(parsed)) {
    return {
      compatibility: 'UNSUPPORTED',
      meta: { createdDefaultBoard: false },
      error: buildImportError('INVALID_STRUCTURE', '导入失败：数据结构不是有效的对象。'),
    };
  }

  if (parsed.source !== 'so-notes') {
    return {
      compatibility: 'UNSUPPORTED',
      meta: { createdDefaultBoard: false },
      error: buildImportError('INVALID_SOURCE', '导入失败：该文件不是 SoNotes 导出的数据。'),
    };
  }

  if (parsed.version === undefined) {
    const legacyData = normalizeLegacyExport(parsed);
    if (!legacyData.data) {
      return {
        compatibility: 'UNSUPPORTED',
        meta: legacyData.meta,
        error: buildImportError('INVALID_STRUCTURE', '导入失败：缺少可识别的版本信息，且旧格式识别失败。'),
      };
    }

    return {
      compatibility: 'LEGACY',
      data: legacyData.data,
      meta: legacyData.meta,
    };
  }

  if (typeof parsed.version !== 'number') {
    return {
      compatibility: 'UNSUPPORTED',
      meta: { createdDefaultBoard: false },
      error: buildImportError('INVALID_STRUCTURE', '导入失败：版本字段格式不正确。'),
    };
  }

  if (parsed.version !== EXPORT_DATA_VERSION) {
    return {
      compatibility: 'UNSUPPORTED',
      meta: { createdDefaultBoard: false },
      error: buildImportError('UNSUPPORTED_VERSION', `导入失败：暂不支持版本 ${String(parsed.version)} 的备份文件。`),
    };
  }

  const normalized = normalizeCompatibleExport(parsed);
  if (!normalized) {
    return {
      compatibility: 'UNSUPPORTED',
      meta: { createdDefaultBoard: false },
      error: buildImportError('INVALID_STRUCTURE', '导入失败：SoNotes 数据结构不完整或字段类型不正确。'),
    };
  }

  return {
    compatibility: 'COMPATIBLE',
    data: normalized,
    meta: { createdDefaultBoard: false },
  };
};

const resolveImportedBoardName = (baseName: string, usedNames: Set<string>) => {
  const trimmedName = baseName.trim() || '未命名看板';
  if (!usedNames.has(trimmedName)) {
    usedNames.add(trimmedName);
    return trimmedName;
  }

  let suffix = 1;
  let candidate = `${trimmedName}（导入）`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${trimmedName}（导入 ${suffix}）`;
  }

  usedNames.add(candidate);
  return candidate;
};

/**
 * Export a single board and its notes
 */
export const generateBoardExport = (board: Board, allNotes: Note[]): string => {
  const boardNotes = allNotes.filter(n => n.boardId === board.id && !n.deletedAt);

  const data: ExportData = {
    version: EXPORT_DATA_VERSION,
    type: 'SINGLE_BOARD',
    source: 'so-notes',
    timestamp: Date.now(),
    payload: {
      boards: [board],
      notes: boardNotes,
      currentBoardId: board.id,
    },
  };

  return JSON.stringify(data, null, 2);
};

/**
 * Export all data (Full Backup)
 */
export const generateFullBackup = (
  boards: Board[],
  notes: Note[],
  config: AppConfig,
  currentBoardId: string,
): string => {
  const data: ExportData = {
    version: EXPORT_DATA_VERSION,
    type: 'FULL_BACKUP',
    source: 'so-notes',
    timestamp: Date.now(),
    payload: {
      boards,
      notes,
      config,
      currentBoardId,
    },
  };

  return JSON.stringify(data, null, 2);
};

/**
 * Process import data
 * Strategy: Always "Deep Clone" & "Merge".
 * IDs are regenerated to prevent conflicts with existing data.
 */
export const processImport = (jsonContent: string, existingBoardNames: string[] = []): ImportResult => {
  const parsed = parseImportData(jsonContent);

  if (!parsed.data || parsed.compatibility === 'UNSUPPORTED') {
    return parsed.error ?? buildImportError('INVALID_STRUCTURE', '导入失败：无法识别的数据结构。');
  }

  const { data } = parsed;
  const now = Date.now();
  const usedNames = new Set(existingBoardNames);
  const newBoards: Board[] = [];
  const newNotes: Note[] = [];
  const issues: ImportIssue[] = [];
  const boardIdMap = new Map<string, string>();
  let migratedNotesCount = 0;
  let renamedBoardsCount = 0;

  if (parsed.meta.createdDefaultBoard) {
    issues.push(buildImportIssue('CREATED_DEFAULT_BOARD', '导入数据缺少有效看板，已自动创建默认看板承接旧数据。', 'warning'));
  }

  // v1.2.7 约定：保留导入包中的看板相对顺序；与本地合并时由 store 整批追加到末尾。
  data.payload.boards.forEach(oldBoard => {
    const newId = crypto.randomUUID();
    boardIdMap.set(oldBoard.id, newId);
    const resolvedName = resolveImportedBoardName(oldBoard.name, usedNames);

    if (resolvedName !== oldBoard.name) {
      renamedBoardsCount += 1;
      issues.push(buildImportIssue('RENAMED_BOARD', `看板“${oldBoard.name}”与本地重名，已重命名为“${resolvedName}”。`, 'warning', {
        boardName: resolvedName,
      }));
    }

    newBoards.push({
      ...oldBoard,
      id: newId,
      name: resolvedName,
      createdAt: now,
    });
  });

  data.payload.notes.forEach((rawNote, noteIndex) => {
    const normalizedNote = parsed.compatibility === 'LEGACY'
      ? normalizeLegacyNote(rawNote, noteIndex, data.payload.boards[0]?.id ?? DEFAULT_BOARD.id)
      : { note: isNote(rawNote) ? rawNote : null, migrated: false };

    if (!normalizedNote.note) {
      issues.push({
        ...buildImportIssue('INVALID_NOTE', `第 ${noteIndex + 1} 条便签结构无效，已跳过。`, 'error', {
          noteIndex,
        }),
      });
      return;
    }

    if (normalizedNote.migrated) {
      migratedNotesCount += 1;
      issues.push(buildImportIssue('MIGRATED_NOTE', `第 ${noteIndex + 1} 条便签缺少旧版字段，已按当前规则自动补全。`, 'warning', {
        noteIndex,
        noteId: normalizedNote.note.id,
      }));
    }

    const newBoardId = boardIdMap.get(normalizedNote.note.boardId);

    if (!newBoardId) {
      issues.push({
        ...buildImportIssue('ORPHAN_NOTE', `第 ${noteIndex + 1} 条便签所属看板不存在，已跳过。`, 'error', {
          noteIndex,
          noteId: normalizedNote.note.id,
        }),
      });
      return;
    }

    newNotes.push({
      ...normalizedNote.note,
      id: crypto.randomUUID(),
      boardId: newBoardId,
      createdAt: now,
      updatedAt: now,
    });
  });

  const rawCurrentBoardId = data.payload.currentBoardId;
  const mappedCurrentBoardId = rawCurrentBoardId ? boardIdMap.get(rawCurrentBoardId) ?? null : null;
  const usedFallbackCurrentBoard = data.type === 'FULL_BACKUP' && !mappedCurrentBoardId && newBoards.length > 0;

  if (usedFallbackCurrentBoard) {
    issues.push(buildImportIssue('FALLBACK_CURRENT_BOARD', '导入数据中的主板定义无效，已回退到第一个有效看板。', 'warning'));
  }

  const suggestedCurrentBoardId = data.type === 'FULL_BACKUP'
    ? mappedCurrentBoardId ?? newBoards[0]?.id ?? null
    : null;

  const skippedNotesCount = issues.filter(issue => issue.code === 'INVALID_NOTE' || issue.code === 'ORPHAN_NOTE').length;

  return {
    status: 'success',
    compatibility: parsed.compatibility,
    data: {
      boards: newBoards,
      notes: newNotes,
      suggestedCurrentBoardId,
      type: data.type,
      summary: {
        importedBoardsCount: newBoards.length,
        importedNotesCount: newNotes.length,
        skippedNotesCount,
        migratedNotesCount,
        renamedBoardsCount,
        usedFallbackCurrentBoard,
        createdDefaultBoard: parsed.meta.createdDefaultBoard,
        issues,
      },
    },
  };
};

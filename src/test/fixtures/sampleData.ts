import type { Note, Board, StorageData } from '../../store/types';
import { NOTE_COLORS, DEFAULT_CONFIG, STORAGE_SCHEMA_VERSION } from '../../store/types';

export interface SampleConfig {
  noteCount: number;
  boardCount: number;
  scenario: 'dense' | 'sparse' | 'long-text' | 'trash-heavy';
  textLength?: 'short' | 'medium' | 'long';
}

export const SAMPLE_PRESETS = {
  NOTES_100: { noteCount: 100, boardCount: 1, scenario: 'dense' as const },
  NOTES_500: { noteCount: 500, boardCount: 3, scenario: 'sparse' as const },
  NOTES_1000: { noteCount: 1000, boardCount: 5, scenario: 'sparse' as const },
  NOTES_3000: { noteCount: 3000, boardCount: 8, scenario: 'sparse' as const },
  LONG_TEXT: { noteCount: 100, boardCount: 1, scenario: 'long-text' as const, textLength: 'long' as const },
  TRASH_HEAVY: { noteCount: 500, boardCount: 2, scenario: 'trash-heavy' as const },
};

const BOARD_ICONS = ['💡', '🚀', '🎨', '🧸', '📅', '🛒', '🎵', '📚', '💼', '🏠', '🌟', '🔥', '💎', '🌈', '🎯'];

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function generateText(length: 'short' | 'medium' | 'long' | undefined): string {
  const lengths = {
    short: { min: 10, max: 50 },
    medium: { min: 100, max: 300 },
    long: { min: 500, max: 2000 },
  };
  
  const { min, max } = length ? lengths[length] : lengths.medium;
  const targetLength = Math.floor(Math.random() * (max - min + 1)) + min;
  
  const words = [
    'Lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
    '笔记', '任务', '提醒', '重要', '待办', '会议', '想法', '灵感', '项目', '进度',
    '设计', '开发', '测试', '部署', '优化', '重构', '文档', '评审', '回顾', '总结',
    '这是一个', '我们需要', '记得要', '别忘了', '关键是', '重点是', '目标是',
    '明天', '下周', '下个月', '本季度', '今年', '长期', '短期', '中期',
  ];
  
  let text = '';
  while (text.length < targetLength) {
    const word = words[Math.floor(Math.random() * words.length)];
    text += (text ? ' ' : '') + word;
  }
  
  return text.slice(0, targetLength) + (text.length > targetLength ? '...' : '');
}

function generateTitle(): string {
  const titles = [
    '待办事项', '会议纪要', '灵感笔记', '项目计划', '购物清单',
    '学习笔记', '代码片段', 'Bug 记录', '需求文档', '设计思路',
    '待跟进', '重要提醒', '临时记录', '想法收集', '进度跟踪',
    'Weekly Plan', 'Daily Notes', 'Quick Thoughts', 'Action Items',
    'Review Notes', 'Brainstorm', 'Research', 'TODO List',
  ];
  return titles[Math.floor(Math.random() * titles.length)];
}

export function generateBoard(index: number): Board {
  const names = [
    '主板', '工作', '个人', '学习',
    '创意', '项目 A', '项目 B', '项目 C',
    '待办', '归档', '灵感', '计划',
  ];
  
  return {
    id: generateId('board'),
    name: names[index % names.length] || `看板 ${index + 1}`,
    icon: BOARD_ICONS[index % BOARD_ICONS.length],
    createdAt: Date.now() - Math.floor(Math.random() * 1000000000),
    viewport: { x: 0, y: 0 },
  };
}

export function generateSampleBoards(count: number): Board[] {
  return Array.from({ length: count }, (_, i) => generateBoard(i));
}

function calculatePosition(
  index: number,
  total: number,
  scenario: SampleConfig['scenario']
): { x: number; y: number } {
  const NOTE_WIDTH = 224;
  const NOTE_HEIGHT = 160;
  
  switch (scenario) {
    case 'dense': {
      const cols = Math.ceil(Math.sqrt(total));
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        x: 100 + col * (NOTE_WIDTH + 20),
        y: 100 + row * (NOTE_HEIGHT + 20),
      };
    }
    case 'sparse': {
      const cols = Math.ceil(Math.sqrt(total / 2));
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        x: 200 + col * (NOTE_WIDTH + 100),
        y: 200 + row * (NOTE_HEIGHT + 100),
      };
    }
    case 'long-text':
    case 'trash-heavy':
    default: {
      const cols = Math.ceil(Math.sqrt(total));
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        x: 150 + col * (NOTE_WIDTH + 60),
        y: 150 + row * (NOTE_HEIGHT + 60),
      };
    }
  }
}

export function generateNote(
  index: number,
  total: number,
  boards: Board[],
  config: SampleConfig
): Note {
  const position = calculatePosition(index, total, config.scenario);
  const boardId = boards[index % boards.length]?.id || boards[0]?.id || 'default';
  const now = Date.now();
  
  const isInTrash = config.scenario === 'trash-heavy' && Math.random() < 0.5;
  
  return {
    id: generateId('note'),
    kind: 'text',
    boardId,
    x: position.x,
    y: position.y,
    title: generateTitle(),
    content: generateText(config.textLength),
    color: NOTE_COLORS[index % NOTE_COLORS.length],
    z: index + 1,
    width: undefined,
    height: undefined,
    collapsed: false,
    createdAt: now - Math.floor(Math.random() * 1000000000),
    updatedAt: now - Math.floor(Math.random() * 100000000),
    deletedAt: isInTrash ? now - Math.floor(Math.random() * 10000000) : null,
  };
}

export function generateSampleNotes(config: SampleConfig & { boards: Board[] }): Note[] {
  return Array.from(
    { length: config.noteCount },
    (_, i) => generateNote(i, config.noteCount, config.boards, config)
  );
}

export function generateSampleState(config: SampleConfig): StorageData {
  const boards = generateSampleBoards(config.boardCount);
  const notes = generateSampleNotes({ ...config, boards });
  
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    storageUpdatedAt: notes.length > 0 ? Math.max(...notes.map((note) => note.updatedAt || 0)) : 0,
    notes,
    boards,
    currentBoardId: boards[0]?.id || 'default',
    config: {
      ...DEFAULT_CONFIG,
      maxZ: notes.length + 1,
    },
  };
}

export function generatePresetSample(presetName: keyof typeof SAMPLE_PRESETS): StorageData {
  const config = SAMPLE_PRESETS[presetName];
  return generateSampleState(config);
}

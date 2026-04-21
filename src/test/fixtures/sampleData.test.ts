import { describe, it, expect } from 'vitest';
import {
  generateSampleBoards,
  generateSampleNotes,
  generateSampleState,
  generatePresetSample,
} from './sampleData';

describe('Sample Data Factory', () => {
  describe('generateSampleBoards', () => {
    it('应生成指定数量的看板', () => {
      const boards = generateSampleBoards(5);
      expect(boards).toHaveLength(5);
    });

    it('每个看板应有唯一 ID', () => {
      const boards = generateSampleBoards(10);
      const ids = boards.map(b => b.id);
      expect(new Set(ids).size).toBe(10);
    });

    it('应包含必要字段', () => {
      const board = generateSampleBoards(1)[0];
      expect(board).toHaveProperty('id');
      expect(board).toHaveProperty('name');
      expect(board).toHaveProperty('icon');
      expect(board).toHaveProperty('createdAt');
    });
  });

  describe('generateSampleNotes', () => {
    it('应生成指定数量的便签', () => {
      const boards = generateSampleBoards(1);
      const notes = generateSampleNotes({
        noteCount: 100,
        boardCount: 1,
        scenario: 'dense',
        boards,
      });
      expect(notes).toHaveLength(100);
    });

    it('每个便签应有唯一 ID', () => {
      const boards = generateSampleBoards(1);
      const notes = generateSampleNotes({
        noteCount: 50,
        boardCount: 1,
        scenario: 'dense',
        boards,
      });
      const ids = notes.map(n => n.id);
      expect(new Set(ids).size).toBe(50);
    });

    it('便签应分配到看板', () => {
      const boards = generateSampleBoards(3);
      const notes = generateSampleNotes({
        noteCount: 100,
        boardCount: 3,
        scenario: 'sparse',
        boards,
      });
      const boardIds = boards.map(b => b.id);
      notes.forEach(note => {
        expect(boardIds).toContain(note.boardId);
      });
    });

    it('长文本场景应生成较长内容', () => {
      const boards = generateSampleBoards(1);
      const notes = generateSampleNotes({
        noteCount: 10,
        boardCount: 1,
        scenario: 'long-text',
        textLength: 'long',
        boards,
      });
      const avgLength = notes.reduce((sum, n) => sum + n.content.length, 0) / notes.length;
      expect(avgLength).toBeGreaterThan(200);
    });

    it('trash-heavy 场景应有部分在废纸篓', () => {
      const boards = generateSampleBoards(2);
      const notes = generateSampleNotes({
        noteCount: 100,
        boardCount: 2,
        scenario: 'trash-heavy',
        boards,
      });
      const trashedCount = notes.filter(n => n.deletedAt !== null).length;
      expect(trashedCount).toBeGreaterThan(30);
      expect(trashedCount).toBeLessThan(70);
    });
  });

  describe('generateSampleState', () => {
    it('应生成完整状态', () => {
      const state = generateSampleState({
        noteCount: 100,
        boardCount: 2,
        scenario: 'dense',
      });
      
      expect(state).toHaveProperty('notes');
      expect(state).toHaveProperty('boards');
      expect(state).toHaveProperty('currentBoardId');
      expect(state).toHaveProperty('config');
      
      expect(state.notes).toHaveLength(100);
      expect(state.boards).toHaveLength(2);
    });

    it('currentBoardId 应是看板之一', () => {
      const state = generateSampleState({
        noteCount: 50,
        boardCount: 3,
        scenario: 'sparse',
      });
      const boardIds = state.boards.map(b => b.id);
      expect(boardIds).toContain(state.currentBoardId);
    });
  });

  describe('generatePresetSample', () => {
    it('应正确生成 100 条样本', () => {
      const state = generatePresetSample('NOTES_100');
      expect(state.notes).toHaveLength(100);
    });

    it('应正确生成 3000 条样本', () => {
      const state = generatePresetSample('NOTES_3000');
      expect(state.notes).toHaveLength(3000);
      expect(state.boards).toHaveLength(8);
    });

    it('应正确生成长文本样本', () => {
      const state = generatePresetSample('LONG_TEXT');
      expect(state.notes).toHaveLength(100);
      const avgLength = state.notes.reduce((sum, n) => sum + n.content.length, 0) / state.notes.length;
      expect(avgLength).toBeGreaterThan(200);
    });
  });

  describe('数据可序列化', () => {
    it('应能被 JSON 序列化和反序列化', () => {
      const state = generateSampleState({
        noteCount: 50,
        boardCount: 2,
        scenario: 'dense',
      });
      
      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);
      
      expect(parsed.notes).toHaveLength(50);
      expect(parsed.boards).toHaveLength(2);
      expect(parsed.notes[0]).toHaveProperty('id');
      expect(parsed.notes[0]).toHaveProperty('title');
      expect(parsed.notes[0]).toHaveProperty('content');
    });
  });
});

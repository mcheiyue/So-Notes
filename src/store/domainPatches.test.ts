import { describe, expect, it } from 'vitest';
import { Note } from './types';
import { DomainState, createInitialDomainState } from './domainStore';
import { extractLayoutNote } from './normalization';
import { applyDomainPatch } from './domainPatches';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    boardId: 'default',
    x: 100,
    y: 200,
    title: '标题',
    content: '正文',
    color: '#FFFFFF',
    z: 1,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function seedNote(state: DomainState, note: Note): DomainState {
  return applyDomainPatch(state, { type: 'add-note', note });
}

function assertNormalizedConsistency(state: DomainState, noteId: string, note: Note) {
  expect(state.notesById[noteId]).toEqual(note);
  expect(state.allNoteIds).toContain(noteId);
  expect(state.boardNoteIds[note.boardId]).toContain(noteId);
  expect(state.layoutNotesById[noteId]).toEqual(extractLayoutNote(note));
}

function assertNoteAbsent(state: DomainState, noteId: string, boardId: string) {
  expect(state.notesById[noteId]).toBeUndefined();
  expect(state.allNoteIds).not.toContain(noteId);
  expect(state.boardNoteIds[boardId] ?? []).not.toContain(noteId);
  expect(state.layoutNotesById[noteId]).toBeUndefined();
}

describe('applyDomainPatch', () => {
  describe('add-note：新增便签', () => {
    it('将便签插入 notesById、allNoteIds、boardNoteIds 与 layoutNotesById', () => {
      const state = createInitialDomainState();
      const note = makeNote();
      const next = applyDomainPatch(state, { type: 'add-note', note });

      assertNormalizedConsistency(next, note.id, note);
      expect(next.allNoteIds).toEqual([note.id]);
      expect(next.config.maxZ).toBeGreaterThanOrEqual(note.z);
    });

    it('追加第二张便签后两个 id 均存在于 allNoteIds 与 boardNoteIds 中', () => {
      const note1 = makeNote({ id: 'n1', z: 1 });
      const note2 = makeNote({ id: 'n2', z: 2 });
      let state = createInitialDomainState();
      state = applyDomainPatch(state, { type: 'add-note', note: note1 });
      state = applyDomainPatch(state, { type: 'add-note', note: note2 });

      expect(state.allNoteIds).toEqual(['n1', 'n2']);
      expect(state.boardNoteIds['default']).toEqual(['n1', 'n2']);
      assertNormalizedConsistency(state, 'n1', note1);
      assertNormalizedConsistency(state, 'n2', note2);
    });

    it('maxZ 更新为现有最大 z、allNoteIds 长度和原 maxZ 的最大值', () => {
      const state = createInitialDomainState();
      const note = makeNote({ z: 50 });
      const next = applyDomainPatch(state, { type: 'add-note', note });

      expect(next.config.maxZ).toBe(Math.max(50, 1, state.config.maxZ));
    });
  });

  describe('add-note：幂等与去重', () => {
    it('同一 noteId 重复添加时不改变状态', () => {
      const note = makeNote();
      let state = createInitialDomainState();
      state = applyDomainPatch(state, { type: 'add-note', note });
      const stateBefore = state;

      const next = applyDomainPatch(state, { type: 'add-note', note });

      expect(next).toBe(stateBefore);
      expect(next.allNoteIds.filter((id) => id === note.id)).toHaveLength(1);
      expect(next.boardNoteIds[note.boardId].filter((id) => id === note.id)).toHaveLength(1);
    });
  });

  describe('remove-note：移除便签', () => {
    it('从所有归一化结构中移除便签', () => {
      const note = makeNote();
      const state = seedNote(createInitialDomainState(), note);
      const next = applyDomainPatch(state, { type: 'remove-note', noteId: note.id });

      assertNoteAbsent(next, note.id, note.boardId);
    });

    it('看板桶变空时删除该桶', () => {
      const note = makeNote({ boardId: 'board-x' });
      let state = createInitialDomainState();
      state = { ...state, boards: [...state.boards, { id: 'board-x', name: 'X', icon: 'X', createdAt: 0 }] };
      state = seedNote(state, note);

      const next = applyDomainPatch(state, { type: 'remove-note', noteId: note.id });

      expect(next.boardNoteIds['board-x']).toBeUndefined();
    });

    it('看板桶中有多张便签时只移除目标便签', () => {
      const note1 = makeNote({ id: 'n1' });
      const note2 = makeNote({ id: 'n2', x: 300, y: 400 });
      let state = createInitialDomainState();
      state = seedNote(state, note1);
      state = seedNote(state, note2);

      const next = applyDomainPatch(state, { type: 'remove-note', noteId: 'n1' });

      assertNoteAbsent(next, 'n1', 'default');
      assertNormalizedConsistency(next, 'n2', note2);
    });

    it('移除不存在的便签时返回原状态引用', () => {
      const state = createInitialDomainState();
      const next = applyDomainPatch(state, { type: 'remove-note', noteId: 'ghost' });

      expect(next).toBe(state);
    });
  });

  describe('update-fields：字段变更', () => {
    it('更新 title 后同步到 notesById，但不刷新 layoutNotesById', () => {
      const note = makeNote();
      const state = seedNote(createInitialDomainState(), note);

      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { title: '新标题' },
      });

      expect(next.notesById[note.id]?.title).toBe('新标题');
      expect(next.layoutNotesById[note.id]).toEqual(state.layoutNotesById[note.id]);
    });

    it('更新 color 后同步刷新 layoutNotesById', () => {
      const note = makeNote();
      const state = seedNote(createInitialDomainState(), note);

      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { color: '#fef9c3' },
      });

      expect(next.notesById[note.id]?.color).toBe('#fef9c3');
      expect(next.layoutNotesById[note.id]?.color).toBe('#fef9c3');
    });

    it('更新 z 后触发 maxZ 重算', () => {
      const note = makeNote({ z: 1 });
      const state = seedNote(createInitialDomainState(), note);

      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { z: 999 },
      });

      expect(next.notesById[note.id]?.z).toBe(999);
      expect(next.config.maxZ).toBeGreaterThanOrEqual(999);
    });

    it('更新 collapsed 不影响 layoutNotesById', () => {
      const note = makeNote();
      const state = seedNote(createInitialDomainState(), note);
      const layoutBefore = state.layoutNotesById[note.id];

      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { collapsed: true },
      });

      expect(next.notesById[note.id]?.collapsed).toBe(true);
      expect(next.layoutNotesById[note.id]).toEqual(layoutBefore);
    });

    it('更新不存在的便签时返回原状态引用', () => {
      const state = createInitialDomainState();
      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: 'ghost',
        fields: { title: 'nope' },
      });

      expect(next).toBe(state);
    });
  });

  describe('update-fields：boardId 变更（跨看板移动）', () => {
    it('变更 boardId 时在 boardNoteIds 桶间移动 id 并刷新 layoutNotesById', () => {
      const note = makeNote({ boardId: 'board-a' });
      let state = createInitialDomainState();
      state = { ...state, boards: [...state.boards, { id: 'board-a', name: 'A', icon: 'A', createdAt: 0 }, { id: 'board-b', name: 'B', icon: 'B', createdAt: 0 }] };
      state = seedNote(state, note);

      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { boardId: 'board-b' },
      });

      expect(next.notesById[note.id]?.boardId).toBe('board-b');
      expect(next.boardNoteIds['board-a'] ?? []).not.toContain(note.id);
      expect(next.boardNoteIds['board-b']).toContain(note.id);
      expect(next.layoutNotesById[note.id]?.boardId).toBe('board-b');
    });

    it('原看板桶变空时删除该桶', () => {
      const note = makeNote({ boardId: 'board-a' });
      let state = createInitialDomainState();
      state = { ...state, boards: [...state.boards, { id: 'board-a', name: 'A', icon: 'A', createdAt: 0 }, { id: 'board-b', name: 'B', icon: 'B', createdAt: 0 }] };
      state = seedNote(state, note);

      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { boardId: 'board-b' },
      });

      expect(next.boardNoteIds['board-a']).toBeUndefined();
    });
  });

  describe('update-position：位置变更', () => {
    it('更新 x/y 后同步到 notesById 与 layoutNotesById', () => {
      const note = makeNote({ x: 10, y: 20 });
      const state = seedNote(createInitialDomainState(), note);

      const next = applyDomainPatch(state, {
        type: 'update-position',
        noteId: note.id,
        x: 500,
        y: 600,
      });

      expect(next.notesById[note.id]?.x).toBe(500);
      expect(next.notesById[note.id]?.y).toBe(600);
      expect(next.layoutNotesById[note.id]?.x).toBe(500);
      expect(next.layoutNotesById[note.id]?.y).toBe(600);
    });

    it('位置变更不影响 boardNoteIds 和 allNoteIds', () => {
      const note = makeNote({ x: 10, y: 20 });
      const state = seedNote(createInitialDomainState(), note);

      const next = applyDomainPatch(state, {
        type: 'update-position',
        noteId: note.id,
        x: 999,
        y: 888,
      });

      expect(next.allNoteIds).toEqual(state.allNoteIds);
      expect(next.boardNoteIds).toEqual(state.boardNoteIds);
    });

    it('更新不存在的便签位置时返回原状态引用', () => {
      const state = createInitialDomainState();
      const next = applyDomainPatch(state, {
        type: 'update-position',
        noteId: 'ghost',
        x: 0,
        y: 0,
      });

      expect(next).toBe(state);
    });
  });

  describe('输入不可变性', () => {
    it('add-note 不变异原始 state 的 notesById', () => {
      const state = createInitialDomainState();
      const notesByIdRef = state.notesById;
      const note = makeNote();

      applyDomainPatch(state, { type: 'add-note', note });

      expect(state.notesById).toBe(notesByIdRef);
      expect(state.notesById[note.id]).toBeUndefined();
    });

    it('add-note 不变异原始 state 的 allNoteIds', () => {
      const state = createInitialDomainState();
      const allNoteIdsRef = state.allNoteIds;
      const note = makeNote();

      applyDomainPatch(state, { type: 'add-note', note });

      expect(state.allNoteIds).toBe(allNoteIdsRef);
      expect(state.allNoteIds).toEqual([]);
    });

    it('add-note 不变异原始 state 的 boardNoteIds', () => {
      const state = createInitialDomainState();
      const boardNoteIdsRef = state.boardNoteIds;
      const note = makeNote();

      applyDomainPatch(state, { type: 'add-note', note });

      expect(state.boardNoteIds).toBe(boardNoteIdsRef);
    });

    it('remove-note 不变异已归一化的 state', () => {
      const note = makeNote();
      const state = seedNote(createInitialDomainState(), note);
      const notesByIdRef = state.notesById;
      const allNoteIdsRef = state.allNoteIds;
      const boardNoteIdsRef = state.boardNoteIds;
      const layoutRef = state.layoutNotesById;

      applyDomainPatch(state, { type: 'remove-note', noteId: note.id });

      expect(state.notesById).toBe(notesByIdRef);
      expect(state.notesById[note.id]).toBeDefined();
      expect(state.allNoteIds).toBe(allNoteIdsRef);
      expect(state.boardNoteIds).toBe(boardNoteIdsRef);
      expect(state.layoutNotesById).toBe(layoutRef);
    });

    it('update-fields 不变异 notesById 中的 note 对象', () => {
      const note = makeNote();
      const state = seedNote(createInitialDomainState(), note);
      const originalNote = state.notesById[note.id];

      const next = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { title: '新标题' },
      });

      expect(state.notesById[note.id]?.title).toBe('标题');
      expect(next.notesById[note.id]?.title).toBe('新标题');
      expect(originalNote?.title).toBe('标题');
    });

    it('update-position 不变异 notesById 中的 note 对象', () => {
      const note = makeNote({ x: 10, y: 20 });
      const state = seedNote(createInitialDomainState(), note);

      applyDomainPatch(state, {
        type: 'update-position',
        noteId: note.id,
        x: 999,
        y: 888,
      });

      expect(state.notesById[note.id]?.x).toBe(10);
      expect(state.notesById[note.id]?.y).toBe(20);
    });
  });

  describe('多看板场景', () => {
    it('不同看板的便签各自维护独立的 boardNoteIds 桶', () => {
      const note1 = makeNote({ id: 'n1', boardId: 'board-a' });
      const note2 = makeNote({ id: 'n2', boardId: 'board-b', x: 300 });
      let state = createInitialDomainState();
      state = { ...state, boards: [...state.boards, { id: 'board-a', name: 'A', icon: 'A', createdAt: 0 }, { id: 'board-b', name: 'B', icon: 'B', createdAt: 0 }] };
      state = seedNote(state, note1);
      state = seedNote(state, note2);

      expect(state.boardNoteIds['board-a']).toEqual(['n1']);
      expect(state.boardNoteIds['board-b']).toEqual(['n2']);
      expect(state.allNoteIds).toEqual(['n1', 'n2']);
    });
  });

  describe('完整往返：add → field-update → position-update → remove', () => {
    it('一系列 patch 应用后归一化状态始终一致', () => {
      const note = makeNote();
      let state = createInitialDomainState();

      state = applyDomainPatch(state, { type: 'add-note', note });
      assertNormalizedConsistency(state, note.id, note);

      state = applyDomainPatch(state, {
        type: 'update-fields',
        noteId: note.id,
        fields: { title: '更新后标题', color: '#dcfce7' },
      });
      expect(state.notesById[note.id]?.title).toBe('更新后标题');
      expect(state.layoutNotesById[note.id]?.color).toBe('#dcfce7');

      state = applyDomainPatch(state, {
        type: 'update-position',
        noteId: note.id,
        x: 500,
        y: 600,
      });
      expect(state.notesById[note.id]?.x).toBe(500);
      expect(state.layoutNotesById[note.id]?.x).toBe(500);

      state = applyDomainPatch(state, { type: 'remove-note', noteId: note.id });
      assertNoteAbsent(state, note.id, note.boardId);
    });
  });
});

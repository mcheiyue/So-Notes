import { describe, it, expect } from 'vitest';

import type { AttachmentRef, Note } from '../../store/types';
import {
  collectLiveAttachmentRefs,
  collectLiveHashes,
  detectMissingReferences,
  detectOrphanAttachments,
} from './attachmentConsistency';

// ---------------------------------------------------------------------------
// 测试辅助工厂
// ---------------------------------------------------------------------------

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const makeRef = (overrides: Partial<AttachmentRef> & Pick<AttachmentRef, 'hash'>): AttachmentRef => ({
  id: `att-${overrides.hash.slice(0, 8)}`,
  filename: `${overrides.hash.slice(0, 8)}.jpg`,
  mimeType: 'image/jpeg',
  size: 1024,
  relativePath: `attachments/${overrides.hash.slice(0, 8)}.jpg`,
  createdAt: 1700000000000,
  ...overrides,
});

const makeNote = (overrides: Partial<Note> & Pick<Note, 'id' | 'boardId'>): Note => ({
  x: 0,
  y: 0,
  title: 't',
  content: 'c',
  color: '#FFFFFF',
  z: 1,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// collectLiveAttachmentRefs
// ---------------------------------------------------------------------------

describe('collectLiveAttachmentRefs', () => {
  it('空 notes 数组返回空列表', () => {
    expect(collectLiveAttachmentRefs([])).toEqual([]);
  });

  it('无附件的 Note 不产生引用', () => {
    const notes = [makeNote({ id: 'n1', boardId: 'default' })];
    expect(collectLiveAttachmentRefs(notes)).toEqual([]);
  });

  it('attachments 缺失（undefined）不崩溃', () => {
    const note = makeNote({ id: 'n1', boardId: 'default' });
    // note.attachments 是 undefined
    expect(collectLiveAttachmentRefs([note])).toEqual([]);
  });

  it('attachments 为非数组值不崩溃', () => {
    const note = makeNote({ id: 'n1', boardId: 'default' });
    (note as unknown as Record<string, unknown>).attachments = 'not-an-array';
    expect(collectLiveAttachmentRefs([note])).toEqual([]);
  });

  it('attachments 含非法元素时跳过非法项', () => {
    const validRef = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const note = makeNote({ id: 'n1', boardId: 'default' });
    (note as unknown as Record<string, unknown>).attachments = [
      validRef,
      null,
      { id: 'bad' }, // 缺少必填字段
      42,
      { id: '', hash: '', filename: '', mimeType: '', size: 0, relativePath: '', createdAt: 0 }, // 空字符串 id
    ];
    const refs = collectLiveAttachmentRefs([note]);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(validRef.id);
  });

  it('收集所有 Note 的附件引用，含重复', () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const refB = makeRef({ hash: HASH_B, relativePath: `attachments/${HASH_B.slice(0, 8)}.jpg` });
    const notes = [
      makeNote({ id: 'n1', boardId: 'default', attachments: [refA] }),
      makeNote({ id: 'n2', boardId: 'default', attachments: [refA, refB] }),
    ];
    const refs = collectLiveAttachmentRefs(notes);
    expect(refs).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// collectLiveHashes
// ---------------------------------------------------------------------------

describe('collectLiveHashes', () => {
  it('空 notes 数组返回空 Set', () => {
    const hashes = collectLiveHashes([]);
    expect(hashes.size).toBe(0);
  });

  it('收集去重的附件 hash', () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const refB = makeRef({ hash: HASH_B, relativePath: `attachments/${HASH_B.slice(0, 8)}.jpg` });
    const notes = [
      makeNote({ id: 'n1', boardId: 'default', attachments: [refA] }),
      makeNote({ id: 'n2', boardId: 'default', attachments: [refA, refB] }),
    ];
    const hashes = collectLiveHashes(notes);
    expect(hashes.size).toBe(2);
    expect(hashes.has(HASH_A)).toBe(true);
    expect(hashes.has(HASH_B)).toBe(true);
  });

  it('Trash 中的 Note（deletedAt 存在）仍计入存活引用', () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const trashNote = makeNote({
      id: 'n-trash',
      boardId: 'default',
      deletedAt: 1700000000000,
      attachments: [refA],
    });
    const hashes = collectLiveHashes([trashNote]);
    expect(hashes.has(HASH_A)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 共享附件与 Trash 引用存活
// ---------------------------------------------------------------------------

describe('共享附件与 Trash 引用存活', () => {
  const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });

  it('hash 被活跃 Note 和 Trash Note 共同时不视为孤儿', () => {
    const activeNote = makeNote({ id: 'n-active', boardId: 'default', attachments: [refA] });
    const trashNote = makeNote({
      id: 'n-trash',
      boardId: 'default',
      deletedAt: 1700000000000,
      attachments: [refA],
    });
    const allNotes = [activeNote, trashNote];

    // 该 hash 在已知文件列表中
    const knownFiles = [`attachments/${HASH_A.slice(0, 8)}.jpg`];
    const orphans = detectOrphanAttachments(knownFiles, allNotes);
    expect(orphans).toEqual([]);
  });

  it('附件仅被 Trash Note 引用时仍视为存活', () => {
    const trashOnlyNote = makeNote({
      id: 'n-trash-only',
      boardId: 'default',
      deletedAt: 1700000000000,
      attachments: [refA],
    });

    const hashes = collectLiveHashes([trashOnlyNote]);
    expect(hashes.has(HASH_A)).toBe(true);

    const knownFiles = [`attachments/${HASH_A.slice(0, 8)}.jpg`];
    const orphans = detectOrphanAttachments(knownFiles, [trashOnlyNote]);
    expect(orphans).toEqual([]);
  });

  it('两个 Trash Note 共享同一附件时仍视为存活', () => {
    const trash1 = makeNote({
      id: 'n-trash-1',
      boardId: 'default',
      deletedAt: 1700000000000,
      attachments: [refA],
    });
    const trash2 = makeNote({
      id: 'n-trash-2',
      boardId: 'b2',
      deletedAt: 1700000100000,
      attachments: [refA],
    });

    const hashes = collectLiveHashes([trash1, trash2]);
    expect(hashes.size).toBe(1);
    expect(hashes.has(HASH_A)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectMissingReferences
// ---------------------------------------------------------------------------

describe('detectMissingReferences', () => {
  it('所有附件文件存在时返回空列表', async () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const notes = [makeNote({ id: 'n1', boardId: 'default', attachments: [refA] })];
    const existsFn = async () => true;

    const missing = await detectMissingReferences(notes, existsFn);
    expect(missing).toEqual([]);
  });

  it('附件文件不存在时返回缺失报告', async () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const notes = [makeNote({ id: 'n1', boardId: 'default', attachments: [refA] })];
    const existsFn = async () => false;

    const missing = await detectMissingReferences(notes, existsFn);
    expect(missing).toHaveLength(1);
    expect(missing[0].noteId).toBe('n1');
    expect(missing[0].ref.hash).toBe(HASH_A);
  });

  it('同一附件被多个 Note 引用且缺失时，为每个 Note 生成报告', async () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const notes = [
      makeNote({ id: 'n1', boardId: 'default', attachments: [refA] }),
      makeNote({ id: 'n2', boardId: 'default', attachments: [refA] }),
    ];
    const existsFn = async () => false;

    const missing = await detectMissingReferences(notes, existsFn);
    expect(missing).toHaveLength(2);
    expect(missing.map((m) => m.noteId)).toEqual(['n1', 'n2']);
  });

  it('对同一 relativePath 只调用一次 existsFn', async () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const notes = [
      makeNote({ id: 'n1', boardId: 'default', attachments: [refA] }),
      makeNote({ id: 'n2', boardId: 'default', attachments: [refA] }),
    ];
    let callCount = 0;
    const existsFn = async () => {
      callCount++;
      return true;
    };

    await detectMissingReferences(notes, existsFn);
    expect(callCount).toBe(1);
  });

  it('无附件的 Note 不触发 existsFn 调用', async () => {
    const notes = [makeNote({ id: 'n1', boardId: 'default' })];
    let callCount = 0;
    const existsFn = async () => {
      callCount++;
      return true;
    };

    const missing = await detectMissingReferences(notes, existsFn);
    expect(missing).toEqual([]);
    expect(callCount).toBe(0);
  });

  it('空 notes 数组不调用 existsFn', async () => {
    let callCount = 0;
    const existsFn = async () => {
      callCount++;
      return true;
    };

    const missing = await detectMissingReferences([], existsFn);
    expect(missing).toEqual([]);
    expect(callCount).toBe(0);
  });

  it('混合存在与缺失时只报告缺失项', async () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const refB = makeRef({ hash: HASH_B, relativePath: `attachments/${HASH_B.slice(0, 8)}.jpg` });
    const notes = [makeNote({ id: 'n1', boardId: 'default', attachments: [refA, refB] })];
    const existsFn = async (relativePath: string) => relativePath.includes(HASH_A.slice(0, 8));

    const missing = await detectMissingReferences(notes, existsFn);
    expect(missing).toHaveLength(1);
    expect(missing[0].ref.hash).toBe(HASH_B);
  });
});

// ---------------------------------------------------------------------------
// detectOrphanAttachments
// ---------------------------------------------------------------------------

describe('detectOrphanAttachments', () => {
  it('空文件列表返回空孤儿列表', () => {
    const notes = [makeNote({ id: 'n1', boardId: 'default' })];
    expect(detectOrphanAttachments([], notes)).toEqual([]);
  });

  it('所有文件都被引用时无孤儿', () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const notes = [makeNote({ id: 'n1', boardId: 'default', attachments: [refA] })];
    const knownFiles = [`attachments/${HASH_A.slice(0, 8)}.jpg`];

    expect(detectOrphanAttachments(knownFiles, notes)).toEqual([]);
  });

  it('未被引用的文件识别为孤儿', () => {
    const notes = [makeNote({ id: 'n1', boardId: 'default' })];
    const knownFiles = [`attachments/${HASH_C.slice(0, 8)}.jpg`];

    const orphans = detectOrphanAttachments(knownFiles, notes);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].hash).toBe(undefined); // 短路径无法解析 64 位哈希
  });

  it('标准 64 位哈希路径可正确解析哈希', () => {
    const notes = [makeNote({ id: 'n1', boardId: 'default' })];
    const knownFiles = [`attachments/${HASH_D}.png`];

    const orphans = detectOrphanAttachments(knownFiles, notes);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].hash).toBe(HASH_D);
    expect(orphans[0].relativePath).toBe(`attachments/${HASH_D}.png`);
  });

  it('被 Trash Note 引用的附件不视为孤儿', () => {
    const refA = makeRef({
      hash: HASH_A,
      relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg`,
    });
    const trashNote = makeNote({
      id: 'n-trash',
      boardId: 'default',
      deletedAt: 1700000000000,
      attachments: [refA],
    });
    const knownFiles = [`attachments/${HASH_A.slice(0, 8)}.jpg`];

    expect(detectOrphanAttachments(knownFiles, [trashNote])).toEqual([]);
  });

  it('混合情况：部分被引用、部分为孤儿', () => {
    const refA = makeRef({ hash: HASH_A, relativePath: `attachments/${HASH_A.slice(0, 8)}.jpg` });
    const notes = [makeNote({ id: 'n1', boardId: 'default', attachments: [refA] })];
    const knownFiles = [
      `attachments/${HASH_A.slice(0, 8)}.jpg`,
      `attachments/${HASH_C.slice(0, 8)}.jpg`,
    ];

    const orphans = detectOrphanAttachments(knownFiles, notes);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].relativePath).toBe(`attachments/${HASH_C.slice(0, 8)}.jpg`);
  });

  it('knownFiles 含重复路径时每个独立检测', () => {
    const notes = [makeNote({ id: 'n1', boardId: 'default' })];
    const knownFiles = [
      `attachments/${HASH_A.slice(0, 8)}.jpg`,
      `attachments/${HASH_A.slice(0, 8)}.jpg`,
    ];

    const orphans = detectOrphanAttachments(knownFiles, notes);
    expect(orphans).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 畸形 / 边界输入
// ---------------------------------------------------------------------------

describe('畸形与边界输入处理', () => {
  it('attachments 为空数组不崩溃', () => {
    const note = makeNote({ id: 'n1', boardId: 'default', attachments: [] });
    expect(collectLiveAttachmentRefs([note])).toEqual([]);
    expect(collectLiveHashes([note]).size).toBe(0);
  });

  it('attachments 含对象但缺少 required 字段时不崩溃', () => {
    const note = makeNote({ id: 'n1', boardId: 'default' });
    (note as unknown as Record<string, unknown>).attachments = [
      { id: 'x' },
      { hash: HASH_A },
      { id: 'y', hash: '', filename: '', mimeType: '', size: -1, relativePath: '', createdAt: 0 },
    ];
    expect(collectLiveAttachmentRefs([note])).toEqual([]);
    expect(collectLiveHashes([note]).size).toBe(0);
  });

  it('size 为 NaN 或 Infinity 时跳过该引用', () => {
    const note = makeNote({ id: 'n1', boardId: 'default' });
    (note as unknown as Record<string, unknown>).attachments = [
      { id: 'x', hash: HASH_A, filename: 'f.jpg', mimeType: 'image/jpeg', size: NaN, relativePath: 'r', createdAt: 1 },
      { id: 'y', hash: HASH_B, filename: 'f.jpg', mimeType: 'image/jpeg', size: Infinity, relativePath: 'r', createdAt: 1 },
    ];
    expect(collectLiveAttachmentRefs([note])).toEqual([]);
  });

  it('createdAt 为 NaN 时跳过该引用', () => {
    const note = makeNote({ id: 'n1', boardId: 'default' });
    (note as unknown as Record<string, unknown>).attachments = [
      { id: 'x', hash: HASH_A, filename: 'f.jpg', mimeType: 'image/jpeg', size: 100, relativePath: 'r', createdAt: NaN },
    ];
    expect(collectLiveAttachmentRefs([note])).toEqual([]);
  });

  it('detectOrphanAttachments 对空 notes 数组正常工作', () => {
    const knownFiles = [`attachments/${HASH_A.slice(0, 8)}.jpg`];
    const orphans = detectOrphanAttachments(knownFiles, []);
    expect(orphans).toHaveLength(1);
  });

  it('detectMissingReferences 对畸形附件的 Note 不崩溃', async () => {
    const note = makeNote({ id: 'n1', boardId: 'default' });
    (note as unknown as Record<string, unknown>).attachments = [
      null,
      42,
      { id: '' },
    ];
    let callCount = 0;
    const existsFn = async () => {
      callCount++;
      return true;
    };

    const missing = await detectMissingReferences([note], existsFn);
    expect(missing).toEqual([]);
    expect(callCount).toBe(0);
  });
});

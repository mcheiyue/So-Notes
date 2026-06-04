/**
 * 附件引用一致性检测工具
 *
 * 提供从 Domain state（全部 Note，含 Trash）收集附件引用、
 * 检测缺失附件引用与识别孤儿附件文件的纯/近纯函数。
 *
 * 设计约束：
 * - Trash 中的 Note（deletedAt 存在）仍计入存活引用集合。
 * - `attachmentExists` 通过依赖注入传入，便于测试 mock。
 * - 畸形或缺失的 attachments 数组不会导致异常。
 */

import type { AttachmentRef, Note } from '../../store/types';

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/**
 * 从未知值中提取合法的 AttachmentRef 数组。
 * 对 undefined / null / 非数组 / 含非法元素的情况均做安全降级。
 * 复用与 normalization.ts 相同的字段校验逻辑。
 */
const extractValidAttachments = (attachments: unknown): AttachmentRef[] => {
  if (!Array.isArray(attachments)) return [];

  const result: AttachmentRef[] = [];
  for (const entry of attachments) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = entry as Record<string, unknown>;
    if (
      typeof ref.id === 'string' &&
      ref.id.length > 0 &&
      typeof ref.hash === 'string' &&
      ref.hash.length > 0 &&
      typeof ref.relativePath === 'string' &&
      ref.relativePath.length > 0 &&
      typeof ref.filename === 'string' &&
      ref.filename.length > 0 &&
      typeof ref.mimeType === 'string' &&
      ref.mimeType.length > 0 &&
      typeof ref.size === 'number' &&
      Number.isFinite(ref.size) &&
      typeof ref.createdAt === 'number' &&
      Number.isFinite(ref.createdAt)
    ) {
      result.push({
        id: ref.id,
        hash: ref.hash,
        filename: ref.filename,
        mimeType: ref.mimeType,
        size: ref.size,
        relativePath: ref.relativePath,
        createdAt: ref.createdAt,
      });
    }
  }
  return result;
};

// ---------------------------------------------------------------------------
// 公开 API：引用收集
// ---------------------------------------------------------------------------

/**
 * 从所有 Note（含 Trash）中收集合法的 AttachmentRef 列表。
 *
 * @param notes 完整 Domain state 的 notes 数组
 * @returns 扁平化的合法 AttachmentRef 数组（可能含重复 hash）
 */
export const collectLiveAttachmentRefs = (notes: Note[]): AttachmentRef[] => {
  const refs: AttachmentRef[] = [];
  for (const note of notes) {
    refs.push(...extractValidAttachments(note.attachments));
  }
  return refs;
};

/**
 * 从所有 Note（含 Trash）中收集存活的附件 hash 集合。
 *
 * @param notes 完整 Domain state 的 notes 数组
 * @returns 去重的附件 hash Set
 */
export const collectLiveHashes = (notes: Note[]): Set<string> => {
  const hashes = new Set<string>();
  for (const note of notes) {
    for (const ref of extractValidAttachments(note.attachments)) {
      hashes.add(ref.hash);
    }
  }
  return hashes;
};

// ---------------------------------------------------------------------------
// 公开 API：缺失引用检测
// ---------------------------------------------------------------------------

/** 单条缺失附件引用的描述 */
export interface MissingAttachmentReport {
  /** 引用该附件的 Note ID */
  noteId: string;
  /** 附件引用 */
  ref: AttachmentRef;
}

/**
 * 检测 Note 引用的附件文件是否实际存在于磁盘。
 *
 * @param notes           完整 Domain state 的 notes 数组
 * @param existsFn        检查附件文件是否存在的函数（注入 `attachmentExists` 或 mock）
 * @returns 缺失附件引用报告列表
 */
export const detectMissingReferences = async (
  notes: Note[],
  existsFn: (relativePath: string) => Promise<boolean>,
): Promise<MissingAttachmentReport[]> => {
  // 先按 relativePath 去重，避免对同一文件重复调用 existsFn
  const pathToExistence = new Map<string, Promise<boolean>>();
  const pathToRefs = new Map<string, { noteId: string; ref: AttachmentRef }[]>();

  for (const note of notes) {
    for (const ref of extractValidAttachments(note.attachments)) {
      if (!pathToExistence.has(ref.relativePath)) {
        pathToExistence.set(ref.relativePath, existsFn(ref.relativePath));
      }
      const existing = pathToRefs.get(ref.relativePath);
      if (existing) {
        existing.push({ noteId: note.id, ref });
      } else {
        pathToRefs.set(ref.relativePath, [{ noteId: note.id, ref }]);
      }
    }
  }

  // 并行等待所有存在性检查结果
  const pathEntries = Array.from(pathToExistence.entries());
  const existenceResults = await Promise.all(pathEntries.map(([, p]) => p));

  const missing: MissingAttachmentReport[] = [];
  for (let i = 0; i < pathEntries.length; i++) {
    const exists = existenceResults[i];
    if (!exists) {
      const refsForPath = pathToRefs.get(pathEntries[i][0]);
      if (refsForPath) {
        for (const { noteId, ref } of refsForPath) {
          missing.push({ noteId, ref });
        }
      }
    }
  }

  return missing;
};

// ---------------------------------------------------------------------------
// 公开 API：孤儿附件检测
// ---------------------------------------------------------------------------

/** 单条孤儿附件的描述 */
export interface OrphanAttachmentReport {
  /** 孤儿文件的相对路径 */
  relativePath: string;
  /** 从路径中解析出的哈希（若可解析） */
  hash: string | undefined;
}

/**
 * 从 relativePath 中尝试解析哈希值。
 * 期望格式: `attachments/<hash>.<ext>` 或 `attachments/<hash>`
 */
const extractHashFromPath = (relativePath: string): string | undefined => {
  // 取最后一段文件名，去掉扩展名
  const segments = relativePath.split('/');
  const filename = segments[segments.length - 1];
  if (!filename) return undefined;
  const dotIndex = filename.indexOf('.');
  const hash = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  // SHA-256 哈希为 64 位十六进制
  return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
};

/**
 * 识别孤儿附件：在磁盘上存在但不被任何 Note 引用的附件文件。
 *
 * 判断策略：
 * 1. 若 knownFiles 路径中可解析出 64 位 SHA-256 哈希，优先与 liveHashes 做匹配。
 * 2. 若无法解析完整哈希（例如测试用短路径），退回到 liveRelativePaths 做路径级匹配。
 * 3. 两种方式均未命中时判定为孤儿。
 *
 * @param knownFiles 磁盘上已知的附件相对路径列表
 * @param notes      完整 Domain state 的 notes 数组（含 Trash）
 * @returns 孤儿附件报告列表
 */
export const detectOrphanAttachments = (
  knownFiles: readonly string[],
  notes: Note[],
): OrphanAttachmentReport[] => {
  const liveHashes = collectLiveHashes(notes);

  // 同时收集所有 live relativePath，用于无法解析完整哈希时的退化匹配
  const liveRelativePaths = new Set<string>();
  for (const ref of collectLiveAttachmentRefs(notes)) {
    liveRelativePaths.add(ref.relativePath);
  }

  const orphans: OrphanAttachmentReport[] = [];
  for (const relativePath of knownFiles) {
    const hash = extractHashFromPath(relativePath);
    // 优先按哈希匹配；哈希无法解析时退回按 relativePath 匹配
    const isLive = hash
      ? liveHashes.has(hash)
      : liveRelativePaths.has(relativePath);
    if (!isLive) {
      orphans.push({ relativePath, hash });
    }
  }

  return orphans;
};

/**
 * 文案守卫基础件（C14 + C15）
 *
 * 提供同步类词与审计/遥测类词的禁止正则，供 BoardDock 测试复用。
 * 正则与 plan SSOT（docs/plans/v1.5.9-prep-and-experience-baseline.md §8 SYNC_BANNED）逐字同步。
 */

/** C14 禁止同步类词：用户可见文案不得出现这些词 */
export const SYNC_LIKE_BANNED =
  /同步|云同步|自动同步|双向|合并|sync|synchronize|自动拉取|自动下载|自动恢复/i;

/** C15 禁止审计/遥测类词：活动日志区不得出现这些词 */
export const AUDIT_TELEMETRY_BANNED =
  /审计|遥测|上报|诊断|上传诊断/;

/** 断言文本不含同步类词；空文本视为通过（无禁止词） */
export function assertNoSyncLike(text: string): void {
  const match = SYNC_LIKE_BANNED.exec(text);
  if (match) {
    throw new Error(
      `文案守卫: 文本包含同步类禁止词「${match[0]}」，不得出现在用户可见文案中`,
    );
  }
}

/** 断言文本不含审计/遥测类词；空文本视为通过 */
export function assertNoAuditTelemetry(text: string): void {
  const match = AUDIT_TELEMETRY_BANNED.exec(text);
  if (match) {
    throw new Error(
      `文案守卫: 文本包含审计/遥测禁止词「${match[0]}」，不得出现在用户可见文案中`,
    );
  }
}

/** 断言文本至少包含给定正向词之一；空文本视为失败 */
export function assertHasPositiveTerms(
  text: string,
  terms: readonly string[],
  contextLabel: string,
): void {
  const normalizedText = text.replace(/\s+/g, '');
  if (!normalizedText) {
    throw new Error(
      `文案守卫: ${contextLabel} 用户可见文本为空，缺少必要正向语义词`,
    );
  }
  const found = terms.some((t) => normalizedText.includes(t));
  if (!found) {
    throw new Error(
      `文案守卫: ${contextLabel} 用户可见文本缺少正向语义词（期望至少含其一：${terms.join('、')}）`,
    );
  }
}

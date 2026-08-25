# 三层锁职责矩阵

- **状态**：Accepted
- **日期**：2026-08-25

## 上下文

来源：`D:\BACK\So-Notes-v1.5.2-v1.6.0-代码质量审查报告.md` **R3**（P1：三层锁语义重叠且不同步；审查建议统一为单一锁源，以 Rust `try_lock` 为准）。

总规划书 [`v1.6.1-to-v1.7.0-planning-recommendations.md`](../plans/v1.6.1-to-v1.7.0-planning-recommendations.md) **§11.2 不做** 写死：**不合并三层锁为单一锁源**（R3 降级边界；若未来要做，另开安全/可靠性专项）。v1.6.8 实施稿对齐该 Non-goal。

当前事实是四条互斥路径并存，职责与超时语义不一致，但合并为单一锁源会跨 TS/Rust 进程边界，超出本版安全/可靠性范围。

## 决策

**有意降级**：本版**不**合并为单一锁源。以本 ADR 为真源，输出三层锁职责矩阵（持有者 / 等待者 / 超时 / 释放条件），并写明退役条件。超时缺口仅在 TS `activeJob` 层由后续 C-R4 补齐；Rust 层保持既有 `try_lock` + scope exit，不改锁实现。

## 三层锁职责矩阵

| 锁层 | 持有者 | 等待者 | 超时（本版后） | 释放条件 |
| --- | --- | --- | --- | --- |
| TS `activeJob` | `tryStartBackupJob(kind)` | 其他 `tryStartBackupJob` 调用 | **C-R4 新增**：可配置超时（默认 `DEFAULT_BACKUP_JOB_TIMEOUT_MS = 5 * 60 * 1000`，5min） | `handle.release()` / 超时自动 release |
| Coordinator/Runner 协作 | `BackupJobCoordinator` | 调用方 | 无（依赖 TS 层） | 调用方 `finally` 块 `release()` |
| Rust `webdav_create_backup_lock` | `webdav_create_backup_lock().try_lock()` 在备份创建路径 | 并发同路径备份 | tokio Mutex 默认无超时；`try_lock` 失败即返回 | `try_lock` 失败跳过 / scope exit 自动释放 |
| Rust `persistence lock_file` | `lock_file.try_lock_exclusive()` | 并发文件操作 | OS flock 默认无超时；`try_lock_exclusive` 失败即返回 | `try_lock_exclusive` 成功 / scope exit 自动释放 |

## 超时策略

- **TS 层**：C-R4 在 `BackupJobCoordinator` 为 `activeJob` 单点补可配置超时（默认 5min）；超时只释放占用，不回滚已提交写路径。
- **Rust 层**：依赖既有 `try_lock` / `try_lock_exclusive`（失败即返回）+ scope exit 自动释放；本版不改 Rust 锁实现、不加超时。

## 退役条件

未来若要将三层锁合并为单一锁源，须另开安全/可靠性专项（跨 TS/Rust 边界的占用真相、超时与失败语义、已提交写路径不回滚）。在该专项落地并替换本矩阵之前，本 ADR 仍为职责真源；本版不启动合并。

## 状态字声明

R3 = **已澄清（有意降级）**。审查「统一单一锁源」本版不完成；本 ADR 只澄清职责边界，不把 R3 记成实现闭环。

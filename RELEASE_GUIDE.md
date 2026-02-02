# SoNotes 发布工作流指南 (Release Protocol)

本文档旨在规范 **SoNotes** 的版本发布流程。AI 助手（Sisyphus）在执行发布任务时**必须严格遵循**以下步骤。

## 核心原则
1.  **验证优先**: 必须在本地构建通过后，才能进行发布操作。
2.  **文档先行**: 代码变更后，必须先更新文档 (`CHANGELOG.md` 和 `RELEASE_TEMPLATE.md`)，再打 Tag。
3.  **中文优先**: 所有对外发布的文档 (Release Notes, Changelog) 必须使用**简体中文**。
4.  **原子化**: 发布相关的文档变更应单独提交，commit message 固定格式。

## 详细发布步骤

### 第一步：本地构建验证 (Local Build Verification)
在开始发布流程前，必须确保当前代码在本地能够成功构建，避免将破坏性代码推送到 Release。

```bash
# 1. 运行类型检查 (Type Check)
npm run tsc

# 2. 运行本地构建 (Build Check)
# 这一步会同时编译前端和 Rust 后端，确保两者都无错误
npm run tauri build -- --debug
```
*如果构建失败，立即停止发布流程并修复代码。*

### 第二步：更新版本号 (Version Bump)
将项目中的所有版本号统一更新为目标版本 `vX.Y.Z`。

必须检查并更新以下**两个**文件：
1.  **package.json**: 更新 `"version"` 字段。
2.  **src-tauri/tauri.conf.json**: 更新 `"version"` 字段。
3.  **src-tauri/Cargo.toml**: 更新 `"version"` 字段。

> **注意**: 如果没有同步更新这三个文件，可能导致前端显示版本与安装包属性不一致。

### 第三步：更新变更日志 (Update Changelog)
在 `CHANGELOG.md` 顶部添加新版本区块。请严格遵循以下风格指南。

**风格指南 (Style Guide)**:
1.  **标题格式**: `## [vX.Y.Z] - YYYY-MM-DD`
2.  **分类标题**:
    *   `### ⚠️ 重大变更 (Breaking Changes)` (仅在发生破坏性更新时使用)
    *   `### ✨ 新特性 (Features)`
    *   `### 🐛 问题修复 (Bug Fixes)`
    *   `### 🚀 优化 (Optimizations)`
    *   `### 🧹 清理 (Cleanup)` (用于代码重构、移除废弃功能等)
3.  **列表项格式**:
    *   统一使用 `*` 作为列表符。
    *   **关键词导向**: 每个条目以 `* **核心功能 (English Term)**` 开头。
    *   **详尽描述**: 对于重要特性，**强烈建议**使用引用块 (`>`) 或多行子列表进行详细阐述。不要只写“实现了X功能”，而要解释“它带来了什么价值”或“用户该如何使用”。
    *   **场景化**: 描述使用场景，而不仅仅是技术实现。

**示例**:
```markdown
## [v1.0.5] - 2026-02-02

### ✨ 新特性 (Features)
*   **交互式待办 (Interactive Todo)**
    > 不再是静态文本。现在您可以直接点击 Markdown 列表中的 `[ ]` 方框来勾选任务，无需进入编辑模式，体验如同原生 App 般丝滑。

### 🐛 问题修复 (Bug Fixes)
*   **数据同步 (Sync)**: 引入了时间戳仲裁机制，彻底修复了多环境（开发版/发布版）下数据可能被旧缓存覆盖的严重 Bug。
```

### 第四步：准备发布模板 (Prepare Release Template)
将本次版本的更新内容（即 `CHANGELOG.md` 中对应的新版本部分）复制并覆盖到 `RELEASE_TEMPLATE.md`。

**注意**:
- `RELEASE_TEMPLATE.md` 仅包含**当前版本**的更新说明。
- CI/CD 工具会自动读取此文件作为 GitHub Release 的 Body。

### 第五步：提交变更 (Commit)
将上述文件的变更提交到 git。

```bash
git add package.json src-tauri/tauri.conf.json CHANGELOG.md RELEASE_TEMPLATE.md
git commit -m "chore(release): prepare vX.Y.Z"
```

### 第六步：打标签与推送 (Tag & Push)
**必须在提交变更后执行**。

```bash
# 打标签
git tag vX.Y.Z

# 推送代码和标签 (触发 CI/CD)
git push origin main --tags
```

## CI/CD 机制说明
- **触发器**: 推送 `v*` 格式的 tag 会触发 `.github/workflows/release.yml`。
- **发布内容**:
    - Release Title: `vX.Y.Z`
    - Release Body: 读取自 `RELEASE_TEMPLATE.md`。
    - Assets: 自动构建并上传 `SoNotes_x.y.z_x64-setup.nsis.zip` 等产物。

## 紧急补救 (Hotfix)
如果在打 tag 后发现文档错误：
1.  **不修改代码库历史**（避免 force push tag）。
2.  使用 GitHub CLI 直接修正线上 Release Note：
    ```bash
    gh release edit vX.Y.Z --notes-file RELEASE_TEMPLATE.md
    ```
3.  在 `main` 分支补交修正后的 `CHANGELOG.md`。

# SoNotes 发布工作流指南 (Release Protocol)

本文档旨在规范 **SoNotes** 的版本发布流程。AI 助手（Sisyphus）在执行发布任务时**必须严格遵循**以下步骤。

## 核心原则
1.  **文档先行**: 代码变更后，必须先更新文档 (`CHANGELOG.md` 和 `RELEASE_TEMPLATE.md`)，再打 Tag。
2.  **中文优先**: 所有对外发布的文档（Release Notes, Changelog）必须使用**简体中文**。
3.  **原子化**: 发布相关的文档变更应单独提交，commit message 固定格式。

## 详细发布步骤

### 第一步：更新变更日志 (Update Changelog)
在 `CHANGELOG.md` 顶部添加新版本区块。

**格式要求**:
- 标题: `## [vX.Y.Z] - YYYY-MM-DD`
- 分类:
    - `### ⚠️ 重大变更 (Breaking Changes)` (如有)
    - `### ✨ 新特性 (Features)`
    - `### 🐛 问题修复 (Bug Fixes)`
    - `### 🚀 优化 (Optimizations)`
- 内容: 使用中文简练描述变更点。

### 第二步：准备发布模板 (Prepare Release Template)
将本次版本的更新内容（即 `CHANGELOG.md` 中对应的新版本部分）复制并覆盖到 `RELEASE_TEMPLATE.md`。

**注意**:
- `RELEASE_TEMPLATE.md` 仅包含**当前版本**的更新说明。
- CI/CD 工具会自动读取此文件作为 GitHub Release 的 Body。

### 第三步：提交文档变更 (Commit)
将上述两个文件的变更提交到 git。

```bash
git add CHANGELOG.md RELEASE_TEMPLATE.md
git commit -m "docs: prepare release vX.Y.Z"
```

### 第四步：打标签与推送 (Tag & Push)
**必须在提交文档变更后执行**。

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

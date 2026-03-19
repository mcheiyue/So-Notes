# SoNotes 发布工作流指南 (Release Protocol)

本文档用于规范 **SoNotes** 的版本发布流程。发布流程采用 **CHANGELOG 单一事实来源 + Build / Release 双工作流分层** 的方式：

- `.github/workflows/build.yml` 负责日常构建校验与调试产物归档。
- `.github/workflows/release.yml` 负责 `v*` 标签触发的正式发布。
- `CHANGELOG.md` 是 GitHub Release Notes 的唯一内容来源。

## 核心原则

1. **验证优先**：本地构建未通过时，严禁继续发布。
2. **文档先行**：发布前必须先更新 `CHANGELOG.md`，并评估是否需要同步更新 `README.md`。
3. **单一事实来源**：GitHub Release Notes 仅从 `CHANGELOG.md` 中按版本自动提取，不再维护独立的发布模板文件。
4. **中文优先**：所有对外发布文档（Release Notes、Changelog、必要时的 README 更新）必须使用简体中文。
5. **原子化**：版本号、日志与发布说明相关改动应在同一轮发布准备中完成，并以清晰 commit 提交。

## 详细发布步骤

### 第一步：本地构建验证 (Local Build Verification)

开始发布前，必须先确认当前代码在本地可通过前端构建与 Tauri 调试构建。

```bash
# 1. 前端构建校验（包含 TypeScript 检查）
npm run build

# 2. Tauri 调试构建校验（同时验证前端 + Rust 侧）
npm run tauri build -- --debug
```

如果任一命令失败，必须先修复后再继续发布。

> 说明：`npm run build` 已包含 `tsc && vite build`，因此不再使用不存在的 `npm run tsc`。

### 第二步：更新版本号 (Version Bump)

将项目中的版本号统一更新为目标版本 `vX.Y.Z`（文件内字段为 `X.Y.Z`）。

必须检查并更新以下 **三个** 文件：

1. **`package.json`**：更新 `"version"` 字段。
2. **`src-tauri/tauri.conf.json`**：更新 `"version"` 字段。
3. **`src-tauri/Cargo.toml`**：更新 `version` 字段。

> **注意**：这三个文件必须保持一致，否则可能出现前端展示版本、Tauri 应用元数据与实际发布版本不一致的问题。

### 第三步：更新变更日志 (Update Changelog)

在 `CHANGELOG.md` 顶部添加新版本区块。GitHub Release 页面会直接读取这里对应版本的内容，因此这里既是项目更新日志，也是发布说明来源。

**风格指南 (Style Guide)**

1. **标题格式**：`## [vX.Y.Z] - YYYY-MM-DD`
2. **分类标题**：
   - `### ⚠️ 重大变更 (Breaking Changes)`（仅在发生破坏性更新时使用）
   - `### ✨ 新特性 (Features)`
   - `### 🐛 问题修复 (Bug Fixes)`
   - `### 🚀 优化 (Optimizations)`
   - `### 🧹 清理 (Cleanup)`（用于重构、删除废弃逻辑等）
3. **列表项格式**：
   - 统一使用 `*` 作为列表符。
   - 每个条目尽量以清晰的功能关键词开头。
   - 对重要更新，优先说明**用户价值**、**使用场景**或**行为变化**，而不仅是技术实现。

**示例**：

```markdown
## [v1.0.5] - 2026-02-02

### ✨ 新特性 (Features)
* **交互式待办 (Interactive Todo)**
  > 现在可以直接点击 Markdown 列表中的 `[ ]` 方框勾选任务，无需进入编辑模式。

### 🐛 问题修复 (Bug Fixes)
* **数据同步 (Sync)**：引入时间戳仲裁机制，修复旧缓存覆盖新内容的问题。
```

### 第四步：README 同步检查 (README Sync Check)

每次发布前，必须评估 `README.md` 是否需要同步更新。至少检查以下内容：

- 新特性、快捷键、使用方式是否有变化。
- 截图、说明文案、安装/运行方式是否仍然准确。
- 技术栈、版本徽章、发布说明入口是否需要更新。

如果 README 无需修改，也应在发布准备时显式确认一次，而不是默认跳过。

### 第五步：确认 Build 工作流预期 (Build Workflow Check)

SoNotes 现有 CI 分为两条线：

1. **`build.yml`**：用于 `main` 分支 push / PR 的构建校验。
2. **`release.yml`**：用于 `v*` 标签触发的正式发布。

在准备打标签前，应确保：

- 当前提交对应的本地构建已通过。
- 如果相关变更已经推送到 GitHub，则 `build.yml` 应为绿色。
- 如需给测试人员或自己做发布前验收，可下载 `build.yml` 上传的 artifact：`SoNotes-windows-debug`。

### 第六步：提交变更 (Commit)

将版本号与文档改动提交到 Git。

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml CHANGELOG.md

# 如果 README.md 有更新，再补充加入
git add README.md

git commit -m "chore(release): prepare vX.Y.Z"
```

如果本次发布没有改动 README，可省略第二条 `git add README.md`。

### 第七步：打标签与推送 (Tag & Push)

必须在提交变更后执行：

```bash
git tag vX.Y.Z
git push origin main --tags
```

## CI/CD 机制说明

### 1. Build 工作流：`.github/workflows/build.yml`

- **触发器**：`main` 分支 push、面向 `main` 的 pull request，并限定在源码/构建相关文件变更时触发。
- **职责**：
  - 安装 Node.js 与 Rust 工具链。
  - 执行 `npm install`。
  - 执行 `npm run build`。
  - 执行 `npm run tauri build -- --debug`。
  - 上传调试构建产物 `SoNotes-windows-debug`。

### 2. Release 工作流：`.github/workflows/release.yml`

- **触发器**：推送 `v*` 格式的 tag。
- **职责**：
  - 安装 Node.js 与 Rust 工具链。
  - 执行 `npm install`。
  - 执行 `npm run tauri build` 生成正式构建。
  - 将 `src-tauri/target/release/so-notes.exe` 重命名为 `SoNotes-vX.Y.Z.exe`。
  - 从 `CHANGELOG.md` 中提取当前版本区块，作为 GitHub Release Notes。
  - 创建或更新 GitHub Release，并上传最终资产 `SoNotes-vX.Y.Z.exe`。

## 紧急补救 (Hotfix)

如果打 tag 后发现发布说明有误：

1. **不要改写历史**（避免 force push tag）。
2. 先修正 `CHANGELOG.md` 中对应版本区块，并补交到 `main`。
3. 再使用 GitHub CLI 修正线上 Release Note，内容应与修正后的 `CHANGELOG.md` 对应区块保持一致。

```bash
gh release edit vX.Y.Z --title "vX.Y.Z" --notes "<将 CHANGELOG 中对应版本区块内容粘贴到这里>"
```

如果线上 Release 附件有误，可继续使用 `gh release upload vX.Y.Z <file> --clobber` 覆盖同名资产。

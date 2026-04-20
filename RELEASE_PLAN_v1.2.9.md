# SoNotes v1.2.9 发布规划（待确认）

> 依据：`RELEASE_GUIDE.md`（Build / Release 双工作流 + `CHANGELOG.md` 单一事实来源）
> 
> 规划日期：2026-04-18
> 
> 当前基线：`main` 相对 `origin/main` 为 `ahead 4`（本次 session 已完成的 4 个功能提交）

---

## 0. 本次版本纳入范围（来自已完成提交）

1. `4a60c4f`：画布平移 rAF 改为事件驱动，静止即停，失焦停机。
2. `1eddc60`：Pin 状态上收到全局 store，App 常驻监听 `pin-state-changed`，并补强保存状态契约。
3. `2bec918`：壳内浮层分层合同固定，补齐 `BOARD_BADGE` / `PIN_FAB` 层级常量与 stacking context。
4. `aaa8d0a`：数据管理区增加保存状态可见反馈（保存中/已保存/失败）。

---

## 第一步：本地构建验证（已完成）

按指南要求执行并通过：

```bash
npm run build
npm run tauri build -- --debug
```

结果记录：

- `npm run build`：通过。
- `npm run tauri build -- --debug`：首次因 `target/debug/so-notes.exe` 被占用失败（os error 5）；释放占用进程后重跑通过。

---

## 第二步：版本号统一更新（待执行）

目标版本：`v1.2.9`（文件字段写 `1.2.9`）

需同步修改三个文件：

1. `package.json`：`"version": "1.2.8" -> "1.2.9"`
2. `src-tauri/tauri.conf.json`：`"version": "1.2.8" -> "1.2.9"`
3. `src-tauri/Cargo.toml`：`version = "1.2.8" -> "1.2.9"`

---

## 第三步：CHANGELOG 更新草案（待确认后落盘）

建议新增到 `CHANGELOG.md` 顶部：

```markdown
## [v1.2.9] - 2026-04-18

### 🐛 问题修复 (Bug Fixes)
* **画布平移事件循环收口**
  > 修复背景平移在静止状态下仍持续请求动画帧的问题；改为事件驱动唤醒，交互停止、失焦与卸载路径均显式停机，减少空转带来的资源占用。
* **钉住状态回显一致性**
  > 修复 BOARD/TRASH 切换后 Pin 按钮状态可能丢失的问题；将钉住状态上收至全局 store，并由 App 常驻监听系统事件同步，返回看板后状态回显稳定。
* **壳内浮层层级稳定性**
  > 修复壳内浮层在高 z 便签（含拖拽态）下可能被遮挡的问题；补齐统一层级常量并固定壳层 stacking context，保证浮层可见性与命中稳定。
* **保存失败可见反馈**
  > 修复保存异常仅控制台可见的问题；在数据管理区补齐“保存中 / 已保存 / 保存失败”状态反馈，并展示失败原因。

### 🚀 优化 (Optimizations)
* **保存状态契约增强**
  > 存储层新增 `saveStatus`、`saveError`、`lastSavedAt`，将保存过程从单一布尔态扩展为可观测状态机，提升问题诊断与交互一致性。
* **回归保障补强**
  > 补充并更新 `Canvas`、`App`、`PinFab`、`WindowShell`、`BoardDock`、`useStore` 测试，覆盖事件停机、状态同步、层级合同与保存反馈关键路径。
```

---

## 第四步：README 同步检查（已评估，建议小幅更新）

检查结论：

- 核心安装/运行方式、快捷键、技术栈未变化。
- 本次存在明确用户可见行为变化：**保存状态反馈（保存中/已保存/失败）**。

建议：

- 在 README 的“数据安全与管理”小节补一条简短说明（1 行），避免文档与实际行为不一致。

---

## 第五步：Build 工作流预期检查（部分已完成）

- 本地构建：已通过（见第一步）。
- 远端 `build.yml` 历史：最近一次 `main` 构建（`chore(release): prepare v1.2.8`）为绿色。
- 当前状态：本地分支 `ahead 4`，尚未推送本次功能提交，**本批改动对应的远端 build 状态待推送后确认**。

---

## 第六步：发布准备提交（待确认后执行）

计划提交内容：版本号三文件 + `CHANGELOG.md` +（若采用建议）`README.md`

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml CHANGELOG.md
# 若 README 同步更新：
git add README.md
git commit -m "chore(release): prepare v1.2.9"
```

---

## 第七步：打标签与推送（待确认后执行）

```bash
git tag v1.2.9
git push origin main --tags
```

---

## 确认闸门（请确认）

请确认以下三项后进入发布执行：

1. 是否采纳上述 `CHANGELOG` 文案（可逐条改）。
2. 是否采纳 README 的 1 行同步说明。
3. 确认后我将按第 2~7 步落地执行（含提交、打 tag、推送）。

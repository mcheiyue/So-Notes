<p align="center">
  <img src="./icon.svg" width="128" height="128" alt="SoNotes Logo">
</p>

<h1 align="center">SoNotes (随心记)</h1>

<p align="center">
  <strong>一款灵感源自 Windows 11 Fluent Design 的极简主义桌面便签应用。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

---

SoNotes 是一款常驻于系统托盘的本地化便签工具。它追求零摩擦的操作体验，通过前端壳层驱动的半透明玻璃化视觉与极简交互设计，让记录灵感变得如同呼吸般自然。

## ✨ 核心特性

### 🎨 极致视觉与交互
*   **Windows 风格桌面美学**: 采用前端壳层驱动的圆角与玻璃化视觉，支持 **深色模式** 与 **玻璃拟态 (Glassmorphism)**，日夜皆美。
*   **无限画布**: 突破屏幕限制，支持 **推墙扩展** 与 **全域漫游**，配合 **交互式小地图** 快速定位。
*   **零摩擦体验**: 双击空白处新建、右键粘贴即创、拖拽吸附、自动折叠、交互式 Todo 勾选，让记录如同呼吸般自然。

### 🗂️ 强大的组织能力
*   **多看板系统**: 一键切换工作、生活、灵感等不同维度的便签板。
*   **全局搜索 (Spotlight)**: `Ctrl+P` 极速唤起，支持模糊搜索与跨看板跳转。
*   **智能归拢**: 一键整理杂乱便签，治愈强迫症。
*   **批量管理**: 支持框选、Ctrl+点击多选，可批量移动、复制或删除便签。

### 🛡️ 数据安全与管理
*   **废纸篓**: 误删无忧，支持一键还原或永久粉碎。
*   **数据主权**: 数据完全本地存储 (IndexedDB + JSON)，支持 **全量备份/恢复** 与 **单板导出**，并可兼容恢复旧版备份。
*   **原子化存储**: 智能防崩溃设计，恢复备份在写入失败时会自动回滚，并提供更清晰的导入结果反馈。
*   **保存状态反馈**: 数据管理区提供“保存中 / 已保存 / 保存失败”可见提示，便于及时确认当前持久化状态。

### ⚡ 高效辅助
*   **快捷键系统**: 丰富的快捷键支持 (详见下方指南)。
*   **托盘优先**: 点击托盘图标快速显隐，支持 **可视化钉住** (Pin Mode) 保持窗口置顶。
*   **一键复制**: 便签顶部提供快捷复制按钮，自动格式化标题与内容。

## ⌨️ 快捷键指南

| 全局操作 | 快捷键 |
| :--- | :--- |
| **全局搜索** | `Ctrl + P` / `Cmd + P` |
| **重置视口** | `Ctrl + 0` / `Cmd + 0` |
| **显隐窗口** | `Ctrl + Alt + S` (默认) |

| 画布操作 | 快捷键 |
| :--- | :--- |
| **新建便签** | 双击空白处 |
| **平移画布** | 按住 `Space` + 拖拽 |
| **多选便签** | 鼠标框选 / `Ctrl` + 点击 |
| **删除选中** | `Delete` / `Backspace` |
| **复制选中** | `Ctrl + D` / `Cmd + D` |
| **全选** | `Ctrl + A` / `Cmd + A` |

## 🛠️ 技术栈

*   **核心核心**: [Tauri v2](https://v2.tauri.app/) (Rust) - 提供轻量级的跨平台支持与底层系统交互。
*   **前端框架**: React 19 + TypeScript + Vite - 构建响应式且类型安全的交互界面。
*   **样式处理**: TailwindCSS - 实现灵活且高性能的 Fluent Design 风格。
*   **状态管理**: Zustand + Immer - 简洁高效的数据流控。

## 🚀 快速开始

### 环境准备

确保您的系统中已安装 Rust 和 Node.js 环境。

### 运行开发版本

1.  克隆仓库并进入目录。
2.  安装依赖：
    ```bash
    npm install
    ```
3.  启动开发服务器：
    ```bash
    npm run tauri dev
    ```

## 📦 构建发布

执行以下命令构建生产环境可执行文件：

```bash
npm run tauri build
```

本地构建完成后，主产物位于 `src-tauri/target/release/so-notes.exe`。

如果通过 GitHub Release 发布，工作流会将该产物重命名为带版本号的 `SoNotes-<tag>.exe` 后再上传。

## 📄 开源许可

本项目基于 [MIT](./LICENSE) 许可证开源。

---

<p align="center">
  由 Antigravity 强力驱动 · 记录每一个闪光的灵感
</p>

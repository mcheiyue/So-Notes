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

SoNotes 是一款常驻于系统托盘的本地化便签工具。它追求零摩擦的操作体验，通过优雅的 Mica 云母效果和极简的交互设计，让记录灵感变得如同呼吸般自然。

## ✨ 核心特性

*   ✨ **Windows 11 原生美学**: 深度集成 Mica 效果、柔和阴影与莫兰迪配色，与系统完美融合。
*   🚀 **托盘优先工作流**: 点击系统托盘图标即可快速切换显隐，便签优雅地浮动在任务栏之上。
*   ⚡ **零摩擦体验**: 在应用内任何位置双击即可创建新便签。支持自动保存，无需担心数据丢失。
*   🛡️ **数据安全保障**: 基于原子化写入、IndexedDB WAL (预写式日志) 以及智能崩溃恢复机制，确保您的记录万无一失。
*   🎨 **简约而不简单**: 自动调整大小的卡片、直观的拖拽交互，以及隐藏式控制按钮，保持界面纯净。
*   🇨🇳 **完全本地化**: 专为中文用户优化的简体中文界面。

## 📸 预览

> *此处为截图占位符，即将更新...*
<!-- <p align="center">
  <img src="./docs/screenshots/main.png" width="800" alt="SoNotes Screenshot">
</p> -->

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

执行以下命令构建生产环境安装包：

```bash
npm run tauri build
```

构建产物将位于 `src-tauri/target/release/bundle` 目录下。

## 📄 开源许可

本项目基于 [MIT](./LICENSE) 许可证开源。

---

<p align="center">
  由 Antigravity 强力驱动 · 记录每一个闪光的灵感
</p>

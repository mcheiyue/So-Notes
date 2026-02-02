## 🚀 SoNotes v1.0.3 Release Notes

此版本主要解决了数据安全性问题，并正式完成从 "TrayNotes" 到 "SoNotes" 的品牌更名。

### ⚠️ 重大变更 (Breaking Changes)
* **项目更名**: 应用名称、进程名及内部标识已全面变更为 **SoNotes**。
* **数据路径迁移**:
  * **旧路径**: `Documents/TrayNotes`
  * **新路径**: `Documents/SoNotes`
  * **迁移指南**: 请手动将旧文件夹中的 `data.json` 和 `assets` 移动到新目录，即可恢复旧数据。

### 🐛 核心修复 (Critical Fixes)
* **数据持久化增强 (Data Persistence)**: 修复了 `OS Error 2` (Disk Save Failed) 问题。实现了原子写入失败回退机制，确保存储被占用时仍能写入。
* **启动数据恢复 (Data Recovery)**: 修复了启动时未从磁盘读取数据的问题。优先检查浏览器缓存，若为空则从磁盘恢复。

### ✨ 新特性 (Features)
* **边界卫士 (Boundary Guard)**: 实现了便签防丢失机制。当便签被拖拽出屏幕左侧或上方时，会自动吸附回 `(0, 0)`。

# Changelog

All notable changes to this project will be documented in this file.

## [v1.0.3] - 2026-02-02

### ⚠️ Breaking Changes
- **Rename**: Project renamed from "TrayNotes" to "SoNotes".
- **Storage**: Data storage path moved from `Documents/TrayNotes` to `Documents/SoNotes`. Manual migration required for existing users.

### Fixed
- **Data Persistence**: Implemented atomic save with fallback to direct write to fix "OS Error 2".
- **Data Recovery**: Application now correctly loads data from `data.json` if local state is empty on startup.

### Added
- **Boundary Guard**: Added logic to snap notes to `(0,0)` if dragged off-screen (negative coordinates).

## [v1.0.2] - 2026-02-02

### Fixed
- **Build**: Fixed CI/CD workflow issues.
- **Deps**: Minor dependency updates.

## [v1.0.1] - 2026-02-02

### Changed
- **Documentation**: Updated README and documentation assets.

## [v1.0.0] - 2026-02-01

### Added
- Initial release of SoNotes (formerly TrayNotes).
- Basic sticky note functionality with markdown support.
- Local storage persistence.

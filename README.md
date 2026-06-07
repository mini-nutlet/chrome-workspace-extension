# Workspace Browser Companion — Standalone

纯前端版本，**无需 Go 后端服务**。所有数据存储在浏览器 IndexedDB 中。

## 与后端版本的差异

| 特性 | 后端版本 | 纯前端版本 |
|------|---------|-----------|
| 存储 | SQLite (Go Service) | IndexedDB (浏览器) |
| 搜索 | SQLite FTS5 | 内存子串匹配 |
| API | HTTP REST | 直接函数调用 |
| 部署 | 需启动 workspace-service.exe | 仅加载扩展即可 |
| 端口 | 127.0.0.1:7878 | 无 |

## 快速开始

### 构建

```powershell
cd extension
npm install
npm run build
```

### 安装 Chrome Extension

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension/dist` 目录

无需启动任何服务。

## 架构

```
Browser
  ↓ Chrome API
Extension (React + TypeScript + Vite, Manifest V3)
  ↓
IndexedDB (idb library)
```

- **存储层**: `src/db/` — database.ts (schema), workspace-repo, tab-repo, tabgroup-repo, bookmark-repo, autogroup-repo, session-repo, search
- **API 层**: `src/lib/api.ts` — 替代 HTTP 调用，直接操作 IndexedDB
- **UI 层**: `src/components/` — React 组件（与后端版本共享）
- **后台**: `src/background/` — Service Worker，标签监控 + 重复检测

## License

MIT

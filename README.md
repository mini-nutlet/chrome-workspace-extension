# Workspace Browser Companion

A pure frontend Chrome extension for organizing browser tabs into **workspaces**, with automatic domain-based grouping, duplicate detection, and session management — all stored locally in IndexedDB. No backend required.

## Features

### Workspaces
- **Tree hierarchy** — top-level workspaces with nested sub-workspaces, drag-and-drop reordering in the sidebar.
- **"Open Tabs" workspace** — auto-mirrors your live browser tabs in real time. Always stays in sync via Chrome tab events.
- **Snapshot tabs** — pin any open page to a workspace. Reopen later from the workspace, even after you've closed the browser tab.
- **Batch operations** — open all workspace tabs at once, close all workspace tabs, or deduplicate by URL.

### Tab Groups
- **Auto-group rules** — define domain patterns (e.g. `github.com` → "GitHub") and tabs are sorted into groups automatically.
- **Default rules** shipped for GitHub, Stack Overflow, YouTube, Google, npm, MDN, and more.
- **Manual groups** — create, rename, delete, and drag tabs between groups.
- **Reapply** — rule changes instantly re-group all tabs in the workspace.

### Duplicate Detection ("Single-Instance")
- **Real-time notification** — when you open a URL that's already open in another tab, choose to switch or keep both.
- **Similarity rules** — per-domain control over what counts as a duplicate:
  - `ignore_query` — treat `?page=1` and `?page=2` as the same page
  - `ignore_hash` — ignore `#section` fragments
  - `ignore_path_query` — match by domain only
- **Pattern types** — domain, exact path, or path prefix matching.
- **Auto-switch** — for trusted domains, silently switch to the existing tab without a prompt.

### Search
- **Quick search** (`Ctrl+Shift+F`) across all tabs and bookmarks with live results.
- **Substring matching** on title and URL, ranked by relevance.
- **Double-Enter fallback** — if no results match, treat the query as a URL or Google search.

### Sessions
- **Save** the current workspace tab set as a named session.
- **Restore** opens all saved tabs, skipping those already open.
- **Delete** sessions when no longer needed.

### Bookmarks
- Per-workspace bookmarks with tag support.
- Searchable alongside tabs.

### UI
- **New Tab override** — replaces Chrome's new tab page with the workspace dashboard.
- **Side panel** — access workspaces from any page via the toolbar icon.
- **Dark / Light / System** theme.
- **Deterministic colors** — workspaces get stable avatar colors derived from their name.
- **Context menus** — rename, add sub-workspace, open all tabs, or delete from the `⋯` button.

## Architecture

```
Chrome Browser
  ├─ chrome.tabs / chrome.windows / chrome.notifications
  │
  ▼
Service Worker (background/index.ts)
  ├─ Tab lifecycle monitoring (onCreated, onUpdated, onRemoved)
  ├─ Duplicate detection + notification
  ├─ Auto-group triggering
  ├─ Periodic full sync (every 30s via chrome.alarms)
  └─ Single new-tab enforcement
  │
  ▼
React UI (newtab + sidepanel + settings)
  ├─ Sidebar          — workspace tree, search, drag-and-drop
  ├─ MainContent      — tab list, grouped tabs, sub-workspace cards
  ├─ GroupedTabList   — tabs organized by group
  ├─ TabPicker        — drag tabs from picker into groups
  ├─ ResultList       — search results
  └─ SettingsApp      — auto-group rules + similarity rules
  │
  ▼
API Layer (lib/api.ts)
  Thin wrappers around DB repos — no HTTP, direct function calls.
  │
  ▼
IndexedDB (idb library)
  ├─ workspaces       — id, parentId, sortOrder, name, description, icon
  ├─ tabs             — shared tab rows keyed by (windowId, chromeTabId)
  ├─ tabWorkspaces    — junction: tab ↔ workspace with active + groupId
  ├─ tabGroups        — per-workspace groups
  ├─ bookmarks        — per-workspace bookmarks
  ├─ autoGroupRules   — domain → group name mappings
  └─ sessions         — per-workspace serialized tab lists
```

Data is stored entirely in the browser. No network requests, no external service, no port to manage.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React 18, TypeScript |
| Bundler (UI) | Vite 6 |
| Bundler (BG) | esbuild (ESM output) |
| Database | IndexedDB via [idb](https://github.com/jakearchibald/idb) 8 |
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local (for similarity rules, theme, workspace selection) |

## Quick Start

### Prerequisites
- Node.js ≥ 18
- Chrome or Chromium-based browser

### Build

```powershell
cd extension
npm install
npm run build
```

The build outputs to `extension/dist/`:
- `newtab.html` + assets — the new tab page
- `sidepanel.html` + assets — the side panel
- `settings.html` + assets — the settings page
- `background.js` — the service worker
- `manifest.json`

### Install in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist` directory

The extension is ready — no server to start, no port to configure.

### Development

```powershell
cd extension
npm run dev          # watch mode — rebuilds on file changes
```

After each build, reload the extension from `chrome://extensions/` (click the refresh icon on the extension card).

## Project Structure

```
chrome-workspace-standalone/
├── extension/
│   ├── public/
│   │   ├── manifest.json          # Manifest V3 definition
│   │   └── icons/                 # Extension icons
│   ├── src/
│   │   ├── background/
│   │   │   └── index.ts           # Service worker entry point
│   │   ├── newtab/
│   │   │   ├── index.tsx          # New tab page entry
│   │   │   ├── App.tsx            # App layout (sidebar + content)
│   │   │   └── index.css          # Global styles
│   │   ├── sidepanel/
│   │   │   └── index.tsx          # Side panel entry (reuses App)
│   │   ├── settings/
│   │   │   ├── index.tsx          # Settings page entry
│   │   │   └── SettingsApp.tsx    # Auto-group + similarity rules UI
│   │   ├── components/
│   │   │   ├── Sidebar.tsx        # Workspace tree + search
│   │   │   ├── MainContent.tsx    # Tab list / sub-workspace cards
│   │   │   ├── GroupedTabList.tsx # Tabs organized by groups
│   │   │   ├── DraggableTab.tsx   # Draggable tab row
│   │   │   ├── DroppableGroup.tsx # Drop target for tab groups
│   │   │   ├── TabPicker.tsx      # Floating tab picker
│   │   │   ├── ResultList.tsx     # Search results
│   │   │   ├── SearchBar.tsx      # Search input
│   │   │   ├── ContextMenu.tsx    # Right-click / ⋯ menu
│   │   │   ├── Bookmarks.tsx      # Bookmark list
│   │   │   ├── OpenTabs.tsx       # Open tabs sidebar
│   │   │   ├── WorkspaceSwitcher.tsx
│   │   │   └── Icons.tsx          # SVG icon components
│   │   ├── db/
│   │   │   ├── database.ts        # IndexedDB schema + connection + URL hashing
│   │   │   ├── workspace-repo.ts  # CRUD for workspaces
│   │   │   ├── tab-repo.ts        # Upsert, remove, dedup, cross-ref
│   │   │   ├── tabgroup-repo.ts   # CRUD + tree builder
│   │   │   ├── bookmark-repo.ts   # CRUD for bookmarks
│   │   │   ├── autogroup-repo.ts  # Domain rule matching + reapply
│   │   │   ├── session-repo.ts    # Session save/restore
│   │   │   └── search.ts          # In-memory substring search
│   │   └── lib/
│   │       ├── api.ts             # Public API (replaces HTTP calls)
│   │       ├── types.ts           # TypeScript interfaces
│   │       ├── constants.ts       # Shared constants
│   │       └── context.tsx        # React context provider
│   ├── vite.config.ts
│   └── package.json
├── .gitignore
└── README.md
```

## Comparison: Standalone vs Backend Version

| Aspect | Backend Version | Standalone (this repo) |
|--------|----------------|------------------------|
| Storage | SQLite via Go service | IndexedDB in browser |
| Search | SQLite FTS5 | In-memory substring match |
| API | HTTP REST (port 7878) | Direct function calls |
| Deployment | Requires `workspace-service.exe` | Load extension, done |
| Offline | No (needs local server) | Yes (fully self-contained) |
| Data portability | SQLite file | Chrome profile (IndexedDB) |

## License

MIT

# Enhancement Roadmap — Workspace Browser Companion

> 设计文档 · 状态: **建议阶段** · 最后更新: 2026-06-17

本文档描述了针对 Workspace Browser Companion Chrome 扩展的潜在功能增强方案。每项功能均包含动机、设计思路、涉及文件以及实施注意事项。功能按优先级分组排列。

---

## 目录

- [高优先级](#高优先级)
  - [1. 模糊搜索](#1-模糊搜索)
  - [2. 标签页拖拽排序](#2-标签页拖拽排序)
  - [3. 全局键盘快捷键](#3-全局键盘快捷键)
  - [4. 删除撤销](#4-删除撤销)
  - [5. 工作区统计仪表盘](#5-工作区统计仪表盘)
- [中优先级](#中优先级)
  - [6. 跨设备同步](#6-跨设备同步)
  - [7. 书签导入](#7-书签导入)
  - [8. 多窗口感知](#8-多窗口感知)
  - [9. 标签页备注](#9-标签页备注)
  - [10. 工作区模板](#10-工作区模板)
- [低优先级 / 探索性](#低优先级--探索性)
  - [11. Chrome 原生标签组集成](#11-chrome-原生标签组集成)
  - [12. 定时操作](#12-定时操作)
  - [13. 工作区分享](#13-工作区分享)
  - [14. 页面内容搜索](#14-页面内容搜索)
- [附录](#附录)
  - [A. 数据模型变更汇总](#a-数据模型变更汇总)
  - [B. 权限变更汇总](#b-权限变更汇总)

---

## 高优先级

### 1. 模糊搜索

**动机：** 当前搜索使用的是朴素子串匹配（`query.toLowerCase().includes(...)`）。用户输入 `"ghub"` 找不到 `"GitHub"`，输入 `"stack ov"` 找不到 `"Stack Overflow"`。这严重降低了搜索的实用性。

**设计：**

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A: Fuse.js** | 使用 [Fuse.js](https://fusejs.io/) 库（~7KB gzip）进行模糊匹配 | 开箱即用，支持拼写容错、加权搜索、阈值调优 | 增加一个依赖项；6-12 个月的更新维护成本 |
| **B: 自定义评分器** (~150 行) | 在 `search.ts` 中实现自定义评分函数，将查询分词为 bigram/trigram，并使用简单的编辑距离算法 | 零依赖，完全控制 | 需要自行维护，Fuse.js 的某些边缘情况可能无法覆盖 |

**推荐方案：** **A (Fuse.js)** —— 理由：Fuse.js 久经考验、体积小、可处理边缘情况（Unicode、多词查询等），且只有一个依赖项。7KB 的增量对于新标签页加载来说微不足道。

**数据流：**

```
用户输入 "ghub react"
  │
  ▼
SearchBar / Sidebar 输入框
  │
  ▼
search.ts: searchTabsAndBookmarks(query, db)
  │
  ├─ 1. 从 IndexedDB 加载所有标签页和书签（< 50ms，即使有 5000+ 条记录）
  ├─ 2. 使用 Fuse 索引运行 Fuse.search(query)，配置如下：
  │      keys: [
  │        { name: 'title',  weight: 0.6 },
  │        { name: 'url',    weight: 0.4 },
  │        { name: 'tags',   weight: 0.3 },    ← 书签标签（新功能）
  │        { name: 'notes',  weight: 0.2 },    ← 标签页备注（功能 #9）
  │      ]
  │      threshold: 0.4,         ← 平衡精确度与宽容度
  │      distance: 100,
  │      minMatchCharLength: 2,
  │      includeScore: true,
  │      ignoreLocation: true,   ← 在任意位置匹配，不偏向开头
  │      useExtendedSearch: true ← 可选的精确匹配：="exact phrase"
  │
  ▼
搜索结果及评分，按相关性排序
  │
  ├─ Fuse 分数 * 100 → 归一化到 [0, 100]
  ├─ 活跃标签页加权: score += 10
  └─ 如果最高分数 > 阈值（例如 60），返回结果
      否则回退到精确子串匹配（当前行为）
```

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/package.json` | 添加 `fuse.js` 依赖 |
| `extension/src/db/search.ts` | 添加 `FuseSearchIndex` 类，在内存中维护 Fuse 实例，`searchTabsAndBookmarks()` 返回带评分的 `ScoredResult[]` |
| `extension/src/lib/types.ts` | 添加 `ScoredResult { item: Tab \| Bookmark; score: number; matchHighlights: string[] }` |
| `extension/src/components/ResultList.tsx` | 在搜索结果中渲染匹配片段高亮（例如，匹配字符加粗） |
| `extension/src/components/Sidebar.tsx` | 当 Fuse 无结果时，为 `Ctrl+Enter` → 直接 Google 搜索传递标志 |

**配置：** 可在设置中配置？（阈值滑块？）—— 第一版不配置，后续迭代再考虑。

**性能注意事项：**
- Fuse 索引在加载时构建一次，当标签页/书签发生变化时通过 `context.tsx` 中的回调重建
- `searchTabsAndBookmarks()` 变为同步操作（无 I/O），延迟 < 5ms，即使有 10,000 个项目
- 模糊匹配的基于分词的特性意味着 `Fuse.createIndex()` 不需要项目间引用，因此可以高效地批量更新

---

### 2. 标签页拖拽排序

**动机：** 组内的标签页始终按插入顺序（`id` 自增）排列。用户无法将重要标签页置顶，也无法对组内标签页进行有意义的排序。

**设计：**

**数据模型变更：**

```typescript
// tabWorkspaces 联结表现在包含一个 sortOrder 列：
interface TabWorkspaceEntry {
  tabId: number;        // 引用 tabs 表
  workspaceId: string;  // 引用 workspaces 表
  groupId: string | null;
  active: boolean;
  sortOrder: number;    // 新增 —— 工作区 & 组内的序号
}
```

**交互方式：**

```
用户将标签页 B 拖到标签页 A 和 C 之间
  │
  ▼
DraggableTab onDragEnd
  │
  ├─ 1. 计算新的 sortOrder: (A.sortOrder + C.sortOrder) / 2
  │      → 浮点数，实现 O(1) 插入无需重新编号
  │      → 当间隙 < 0.001 时触发重新编号（约 log₂(1/0.001) ≈ 10 次在同一位置插入后触发）
  │
  ├─ 2. 更新 IndexedDB: tabRepo.updateSortOrder(tabId, workspaceId, newSortOrder)
  │
  ├─ 3. 乐观更新 context.tsx 中的 tabGroupsTree
  │
  └─ 4. 如果拖到不同组：同时更新 groupId
```

**重新编号策略：**

```typescript
// 当浮点精度不足时，触发重新编号：
async function renumberGroup(workspaceId: string, groupId: string): Promise<void> {
  const tabs = await db.getAllFromIndex('tabWorkspaces', 'workspace-group', [workspaceId, groupId]);
  tabs.sort((a, b) => a.sortOrder - b.sortOrder);
  const tx = db.transaction('tabWorkspaces', 'readwrite');
  for (let i = 0; i < tabs.length; i++) {
    await tx.store.put({ ...tabs[i], sortOrder: i * 1000 });
  }
  await tx.done;
}
```

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/db/database.ts` | 迁移 #4：为现有标签页添加 `sortOrder` 并初始化为 `id * 1000` |
| `extension/src/db/tab-repo.ts` | 添加 `updateSortOrder()`，`renumberGroup()` |
| `extension/src/db/tabgroup-repo.ts` | 按 `sortOrder` 排序，而非 `id` |
| `extension/src/components/DraggableTab.tsx` | 添加 HTML5 拖拽处理（已有 `onDragStart`，需添加 `onDragOver`、`onDrop` 位置计算） |
| `extension/src/components/DroppableGroup.tsx` | 在组内标签页之间显示拖拽指示器（放置预览线） |
| `extension/src/components/GroupedTabList.tsx` | 当 `groupId === null`（未分组标签页）时支持拖拽 |
| `extension/src/lib/types.ts` | 添加 `sortOrder: number` 到 `Tab`（或联结条目） |
| `extension/src/lib/context.tsx` | `handleDragEnd` 回调更新，增加位置计算逻辑 |

**拖拽交互细节：**
- 组内上下拖动可对标签页重新排序（显示插入预览线）
- 拖动到不同组的标题上 → 移动并追加到该组末尾
- 拖动到"未分组"区域 → 从组中移除
- 触控设备支持？（暂缓，先确保桌面端功能完善）

---

### 3. 全局键盘快捷键

**动机：** 用户在浏览器中导航严重依赖键盘操作。`Ctrl+Shift+F` 是唯一可用的快捷键。为常用操作添加快捷键可显著提升操作效率。

**设计：**

**实现方式：** 使用 `chrome.commands` API（在 `manifest.json` 中声明，由 Chrome 处理冲突解决）。

```json
// manifest.json 中新增的 commands 条目
"commands": {
  "quick-search": {
    "suggested_key": { "default": "Ctrl+Shift+F" },
    "description": "Focus search in workspace sidebar"
  },
  "switch-workspace": {
    "suggested_key": { "default": "Ctrl+Shift+W" },
    "description": "Open workspace switcher"
  },
  "save-session": {
    "suggested_key": { "default": "Ctrl+Shift+S" },
    "description": "Save current workspace tabs as session"
  },
  "toggle-duplicate-detection": {
    "suggested_key": { "default": "Ctrl+Shift+D" },
    "description": "Toggle duplicate detection on/off"
  },
  "open-all-tabs": {
    "description": "Open all tabs in current workspace"
  },
  "close-all-tabs": {
    "description": "Close all tabs in current workspace"
  }
}
```

**数据流：**

```
用户按下 Ctrl+Shift+W
  │
  ▼
Chrome 浏览器触发 chrome.commands.onCommand
  │
  ▼
Service Worker (background/index.ts) 接收命令
  │
  ├─ "switch-workspace":
  │     1. 打开侧边面板 (chrome.sidePanel.open())
  │     2. 发送消息给侧边面板: { type: 'open-workspace-switcher' }
  │     3. 侧边面板中的 WorkspaceSwitcher 组件获得焦点
  │
  ├─ "save-session":
  │     1. 如果当前工作区有标签页，自动保存为 "Quick Save - 15:30" 格式的会话
  │     2. 显示 Chrome 通知: "会话已保存"
  │
  ├─ "toggle-duplicate-detection":
  │     1. 在 chrome.storage.local 中切换全局标志
  │     2. Service Worker 读取此标志并跳过重复检测
  │     3. 通知: "重复检测: 开" 或 "重复检测: 关"
  │
  └─ "open-all-tabs" / "close-all-tabs":
        发送消息给新标签页/侧边面板触发操作
```

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/public/manifest.json` | 添加 `commands` 对象 |
| `extension/src/background/index.ts` | 添加 `chrome.commands.onCommand.addListener()`，向新标签页/侧边面板转发消息 |
| `extension/src/components/Sidebar.tsx` | 监听来自 SW 的 `open-workspace-switcher` 消息 |
| `extension/src/lib/context.tsx` | 添加 `handleQuickSaveSession()` 操作 |

**注意事项：**
- `chrome.commands` 建议按键可能与其他扩展或 Chrome 内置快捷键冲突。Chrome 在安装时会自动警告用户。
- 如果用户偏好不同的按键组合，可以通过 `chrome://extensions/shortcuts` 进行自定义——无需我们编写任何配置界面。

---

### 4. 删除撤销

**动机：** 删除工作区、标签组或标签页时，唯一的安全网是删除确认弹窗。一旦确认，数据将不可恢复。对于可能拥有数百个标签页的用户来说，一次误操作可能就是一场灾难。

**设计：**

**模式：** 软删除 + 撤销提示框

```
用户点击"删除" → 确认 → 操作
  │
  ▼
api.deleteWorkspace(id)
  │
  ├─ 1. 实际上执行的是 markForDeletion(id)，而非立即删除
  │     - 将 deletedAt: Date.now() 设置到 workspace 记录上
  │     - 隐藏于 UI（从 workspaceTree 中过滤掉 deletedAt != null 的项）
  │
  ├─ 2. 在屏幕底部显示撤销提示框，显示 6 秒：
  │     ┌─────────────────────────────────────────────┐
  │     │ 🗑 "GitHub Repos" 已删除    [撤销] [×]      │
  │     └─────────────────────────────────────────────┘
  │
  ├─ 3a. 用户点击"撤销" →
  │       api.restoreWorkspace(id) → 设置 deletedAt = null
  │       提示框消失，工作区重新出现在侧边栏中
  │
  └─ 3b. 6 秒计时器到期，无交互 →
          api.purgeWorkspace(id) → 从 IndexedDB 中真正删除
          所有关联的 tabWorkspace 联结条目、分组和会话级联删除
```

**撤销提示框 UI：**

提示框是一个全局 React 组件（渲染在 `<App>` 中），管理一个待撤销操作队列：

```typescript
// 状态形态
interface UndoableAction {
  id: string;
  type: 'delete-workspace' | 'delete-group' | 'delete-tab' | 'delete-session';
  description: string;         // 用户可读信息，例如 "GitHub Repos"
  undo: () => Promise<void>;   // 反转操作的函数
  expiresAt: number;           // Date.now() + 6000
}
```

如果用户在一个提示框显示期间又执行了另一个可撤销操作，则**新操作会将旧操作挤掉**（先提交旧操作，再对新操作排队）。这比维护一个队列更简洁。

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/components/UndoToast.tsx` | **新建** —— 全局提示框组件，动画为从底部向上滑入 |
| `extension/src/newtab/App.tsx` | 在布局中渲染 `<UndoToast>` |
| `extension/src/db/workspace-repo.ts` | 添加 `markDeleted()` / `purgeWorkspace()` / `restoreWorkspace()` |
| `extension/src/db/tabgroup-repo.ts` | 添加 `markDeleted()` / `purgeGroup()` / `restoreGroup()` |
| `extension/src/db/tab-repo.ts` | 添加 `markDeleted()` / `purgeTab()` / `restoreTab()` |
| `extension/src/lib/api.ts` | 导出 `undoableDelete*()` 方法 |
| `extension/src/lib/context.tsx` | 在 Context 值中添加 `undoActions: UndoableAction[]`、`pushUndo()`、`dismissUndo()` |
| `extension/src/newtab/index.css` | `.undo-toast` 样式、`slide-up` / `slide-down` 动画 |

---

### 5. 工作区统计仪表盘

**动机：** 首页仪表盘目前只显示子工作区卡片网格。没有高级概览——用户无法一目了然地看到标签页数量、重复情况或使用模式。

**设计：**

**仪表盘组件** —— 在 `MainContent` 仪表盘视图中，位于现有子工作区卡片网格上方呈现：

```
┌──────────────────────────────────────────────────────────────────┐
│ 📊 概览                                                          │
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ 全部标签页 │  │ 重复标签页 │  │ 活跃标签页 │  │ 最近使用域名      │  │
│  │          │  │          │  │          │  │                  │  │
│  │   142    │  │    7     │  │   23     │  │ github.com  (34) │  │
│  │          │  │          │  │          │  │ youtube.com (12) │  │
│  └──────────┘  └──────────┘  └──────────┘  │ docs.google  (8) │  │
│                                             └──────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**统计数据来源：**

| 统计项 | 查询方式 |
|------|-----------|
| 全部标签页 | `tabRepo.getAllTabs()` 的 count —— 按工作区筛选 |
| 重复标签页 | `tabRepo.findDuplicates()` 的 count —— URL-哈希分组，保留 count ≥ 2 的组 |
| 活跃标签页 | 盘查 `chrome.tabs.query({})` 结果，获得实际打开的标签页数量 |
| 最近使用域名 | 按域名聚合，按总标签页数量排序（或者如果有 `lastAccessed` 时间戳则按最近访问排序），取前 5 名 |
| 已保存会话数 | `sessionRepo.count()` |
| 每个工作区的标签页数量 | 按 `workspaceId` 分组，用于侧边栏内嵌计数 |

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/components/DashboardStats.tsx` | **新建** —— 统计卡片网格 |
| `extension/src/components/MainContent.tsx` | 在仪表盘路由（`workspaceId === null`）中，于 `<GroupedTabList>` 上方渲染 `<DashboardStats>` |
| `extension/src/db/tab-repo.ts` | 添加 `countByWorkspace()`、`domainDistribution()` 聚合方法 |
| `extension/src/db/session-repo.ts` | 添加 `countByWorkspace()` |
| `extension/src/lib/api.ts` | 导出 `getDashboardStats()` |
| `extension/src/lib/context.tsx` | 在 Context 中添加 `dashboardStats` 状态，在标签页/会话变化时刷新 |

**性能注意事项：**
- 统计项来源于 IndexedDB 计数查询（< 5ms），而非完整表扫描
- 域名分布可以在加载时计算一次，然后在标签页变化时以去抖方式重新计算
- 仪表盘仅在 `workspaceId === null` 时渲染，不影响工作区视图性能

---

## 中优先级

### 6. 跨设备同步

**动机：** 所有数据都是纯本地的。切换设备（工作电脑 ↔ 家用电脑）意味着一切从零开始。用户希望工作区能够随身携带。

**设计选项：**

#### 方案 A: Chrome Storage Sync（免费，受限）

```
工作区、自动分组规则、相似性规则
  │
  ▼
chrome.storage.sync (最大 100KB / 512 项)
  │
  ▼
其他设备：chrome.storage.onChanged → 合并至 IndexedDB
```

**限制条件：**
- 100KB 总量 —— 对于 10-20 个工作区定义 + 规则是可行的，但**无法存储标签页和分组数据**
- 512 个独立项 —— 每条存储键算作一项
- 每项最大 8KB
- 适合：设置、规则、工作区元数据（名称、结构）。**无法用于**实际的标签页数据。

#### 方案 B: Google Drive 同步（高级，付费/可选）

```
用户选择 → Google OAuth → 选择一个 Drive 文件夹
  │
  ▼
导出的 JSON 文件（与当前导出格式相同）存储在 Drive 中
  │
  ▼
定期同步（每 5 分钟 / 按需）：
  - 从 Drive 下载 → 与本地 IndexedDB 合并（基于 ID 的增量合并，以最大修改时间为准）
  - 将本地更改上传至 Drive
```

**合并策略：**

```typescript
interface SyncMergeResult {
  added: number;      // 新增至本地的项目
  updated: number;    // 远程时间戳更新的项目
  conflicts: number;  // 两个副本均有更改的项目（需用户介入解决）
  deleted: number;    // 远程已删除但本地仍存在的项目
}
```

冲突解决规则：
1. 每个记录存储 `updatedAt` 时间戳
2. 同步时：如果 `remote.updatedAt > local.updatedAt`，采用远程版本
3. 如果两个版本都有更新（自上次同步以来均发生变化）→ 保留两个，向用户标记冲突
4. 工作区"打开所有标签页"操作始终使用本地标签页数据，不触发远程同步

**涉及文件（方案 A 和 B 通用）：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/lib/sync-engine.ts` | **新建** —— 合并逻辑、冲突检测、`lastSyncTimestamp` 跟踪 |
| `extension/src/settings/SettingsApp.tsx` | 添加同步配置部分（启用/禁用、同步频率、最后同步状态） |
| `extension/src/background/index.ts` | 从 `chrome.alarms` 添加定期同步触发 |
| `extension/src/db/database.ts` | 迁移添加 `updatedAt` 字段到所有表 |
| `extension/public/manifest.json` | 方案 B 需添加 `identity` 权限（用于 Google OAuth） |

**推荐方案：** 从**方案 A**开始（零摩擦，零配置，自动同步设置和规则）。之后，如果用户需求强烈，将方案 B 作为"高级同步"选项添加。

---

### 7. 书签导入

**动机：** 许多用户已经将 Chrome 书签整理成文件夹。将书签文件夹导入为工作区，可以让他们在无需手动逐个添加的情况下，顺利迁移到这款扩展。

**设计：**

```
用户在"设置"中点击"从书签导入"
  │
  ▼
chrome.bookmarks.getTree() → 获取完整书签树
  │
  ▼
显示导入对话框（模态框）：

  ┌──────────────────────────────────────────┐
  │ 从书签导入                                │
  │                                            │
  │ 选择要导入的文件夹：                       │
  │  ☑ 📁 工作    (42 个书签)                  │
  │  ☐ 📁 个人    (18 个书签)                  │
  │  ☐ 📁 项目    (23 个书签)                  │
  │    ☐ 📁 前端   (8 个书签)   ← 嵌套        │
  │    ☐ 📁 后端   (15 个书签)                 │
  │  ☐ 其他书签   (56 个书签)                  │
  │                                            │
  │  ☑ 为每个文件夹创建自动分组规则            │
  │  ☐ 同时导入为已打开标签页                  │
  │                                            │
  │         [取消]       [导入 3 个工作区]      │
  └──────────────────────────────────────────┘

  ▼
导入逻辑：
  ├─ 每个选中的书签文件夹 → 新的工作区
  ├─ 选中的子文件夹 → 子工作区
  ├─ 文件夹内的书签 → 已保存的标签页（active == false）
  ├─ 如果勾选"创建自动分组规则"，则按域名聚合书签并生成规则
  └─ 如果勾选"导入为已打开标签页"，则通过 chrome.tabs.create() 打开
```

**映射规则：**

| 书签属性 | 工作区模型 |
|-----------|---------------|
| `bookmark.title` | `workspace.name` |
| `bookmark.children` (文件夹) | 子工作区 |
| `bookmark.url` (叶子节点) | `tab.url`、`tab.title` |
| `bookmark.dateAdded` | `tab.createdAt` |
| 文件夹层级 | 工作区 `parentId` 链 |

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/components/BookmarkImportDialog.tsx` | **新建** —— 带复选框的文件夹树形模态框 |
| `extension/src/lib/import-bookmarks.ts` | **新建** —— 转换逻辑：`BookmarkTreeNode[] → { workspaces: CreateWorkspace[], tabs: CreateTab[] }` |
| `extension/src/settings/SettingsApp.tsx` | 添加"从书签导入"按钮，打开模态框 |
| `extension/public/manifest.json` | 无需新权限 —— `chrome.bookmarks` 无需 `"bookmarks"` 权限即可读取（仅 `getTree` 不需要；`bookmarks` 权限仅用于写入） |

**注意事项：**
- `chrome.bookmarks.getTree()` 即使没有 `"bookmarks"` 清单权限也可用（它是只读的，对扩展无害）
- 非常大的书签树（1000+ 项）可能需要在对话框中实现延迟加载渲染
- 重复检测：如果某个 URL 已存在于工作区中，则跳过该书签

---

### 8. 多窗口感知

**动机：** 该扩展目前跨所有窗口查询标签页（`chrome.tabs.query({})`），但并未向用户暴露窗口信息。在多个窗口中打开标签页的用户无法分辨哪个标签页属于哪个窗口，也无法管理窗口间的标签页分布。

**设计：**

**窗口指示器：**

```
标签页行位：

┌──────────────────────────────────────────────────────────────┐
│ [favicon]  GitHub — Pull Requests      🟢 窗口 1 · 活跃标签页  │
│ [favicon]  React 文档                    🔵 窗口 2             │
│ [favicon]  Stack Overflow — 已保存       ⚪ (未打开)           │
└──────────────────────────────────────────────────────────────┘
```

- 🟢 绿色圆点 = 已在此窗口中打开 + 是活跃标签页
- 🔵 蓝色圆点 = 在另一个窗口中打开
- ⚪ 灰色圆点 = 未在任何窗口中打开（已保存到工作区，但标签页已关闭）

**窗口操作（上下文菜单中）：**

- **"移动标签页至当前窗口"** — 将标签页从其他窗口移动到当前活动窗口
- **"在工作区中打开所有标签页（合并至单一窗口）"** — `openAllTabsInWorkspace` 的替代方案，将所有标签页合并到当前窗口中，而非跨窗口分散
- **"合并所有窗口"** — 将所有打开的标签页移动到当前窗口，其他窗口关闭

**实现：**

```typescript
// 从 chrome.windows.getAll() 获取窗口元数据
interface WindowInfo {
  id: number;
  focused: boolean;
  state: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
}

// 扩展 Tab 接口（在上下文中，而非 IndexedDB 中）：
interface LiveTabInfo {
  tabId: number;
  windowId: number;
  isActive: boolean;    // 窗口中活跃的标签页
  isFocusedWindow: boolean;
}
```

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/lib/api.ts` | 添加 `getOpenTabsByWindow()` —— 返回 `Map<windowId, LiveTab[]>` |
| `extension/src/components/DraggableTab.tsx` | 添加窗口指示器圆点，添加窗口标签（徽章） |
| `extension/src/components/ContextMenu.tsx` | 添加"移动至当前窗口"、"合并所有窗口"选项 |
| `extension/src/components/GroupedTabList.tsx` | 添加 `mergeToSingleWindow` 操作 |
| `extension/src/lib/context.tsx` | 添加 `windowState: Map<number, WindowInfo>`，添加窗口管理操作 |
| `extension/src/background/index.ts` | 监听 `chrome.windows.onFocusChanged`，更新焦点窗口 ID |
| `extension/public/manifest.json` | 无需新权限 —— `tabs` 权限已包含窗口查询 |

---

### 9. 标签页备注

**动机：** 用户保存标签页是因为以后想要参考它们，但仅仅一个标题/URL 往往缺乏上下文。*为什么*要保存这个标签页？其中哪一部分信息是相关的？允许添加简短注释，使已保存的标签页成为有价值的参考对象，而不只是被遗忘的书签。

**设计：**

**数据模型：**

```typescript
// tabs 表中新增列
interface Tab {
  // ... 现有字段 ...
  notes: string;          // 纯文本，最大 2000 字符
  notesUpdatedAt: number; // Date.now() 时间戳
}
```

**用户体验：**

```
标签页行位（正常状态）：
┌──────────────────────────────────────────────┐
│ [favicon]  React useEffect 完整指南            │
│            react.dev · 6月12日保存             │
│            📝 关注清理函数部分 + 严格模式行为   │ ← 备注预览（前80字符）
└──────────────────────────────────────────────┘

标签页行位（悬停 / 已展开 — 点击备注指示器 📝）：
┌──────────────────────────────────────────────┐
│ [favicon]  React useEffect 完整指南            │
│            react.dev · 6月12日保存             │
│            ┌────────────────────────────────┐ │
│            │ 关注重点：                      │ │
│            │ - 清理函数部分                  │ │
│            │ - 严格模式下的双重调用行为      │ │
│            │ - 依赖数组最佳实践              │ │
│            │                                │ │
│            │ [保存]  [取消]                  │ │
│            └────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

**搜索集成：**

Fuse.js 索引（功能 #1）包含备注为可搜索字段，权重 0.2。搜索备注中包含 `"cleanup"` 的结果将找到该标签页，即使标题/URL 中并不包含该词。

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/db/database.ts` | 迁移 #5：添加 `notes` + `notesUpdatedAt` 到 tabs 表 |
| `extension/src/db/tab-repo.ts` | 添加 `updateNotes(tabId, notes)` |
| `extension/src/components/DraggableTab.tsx` | 备注指示器图标、展开/折叠的内联编辑区域 |
| `extension/src/lib/types.ts` | 在 `Tab` 接口中添加 `notes: string` |
| `extension/src/db/search.ts` | 备注作为可搜索字段（含 Fuse 权重） |

**注意事项：**
- 备注存储在 IndexedDB 中（标签页数据的一部分），随 JSON 导出/导入一起附带
- 仅纯文本（无 Markdown 渲染）——保持简单，避免 XSS 风险
- `DraggableTab` 中的内联编辑区域使用 `<textarea>`，支持自动调整高度

---

### 10. 工作区模板

**动机：** 当用户创建新工作区时，它是空的——没有分组，没有规则，没有结构。像"Web 开发"这样的常用工作区类型总是需要相同的设置（GitHub、Stack Overflow、MDN 规则）。模板消除了重复性工作。

**设计：**

**数据模型：**

```typescript
// 新 IndexedDB 存储区：templates
interface WorkspaceTemplate {
  id: string;
  name: string;                    // "Web 开发"
  description: string;             // "包含 GitHub、Stack Overflow、MDN 的自动分组规则"
  icon: string;
  autoGroupRules: AutoGroupRule[]; // 预配置的规则
  isBuiltIn: boolean;              // true = 内置模板，false = 用户创建
}
```

**内置模板：**

| 模板 | 自动分组规则 |
|------|-------------------|
| **Web 开发** | `github.com` → GitHub, `stackoverflow.com` → Stack Overflow, `developer.mozilla.org` → MDN, `npmjs.com` → npm, `gitlab.com` → GitLab |
| **研究** | 无预配置规则 —— 通用起始模板 |
| **社交** | `twitter.com` / `x.com` → Twitter/X, `reddit.com` → Reddit, `discord.com` → Discord, `news.ycombinator.com` → Hacker News |
| **Google 生态** | `mail.google.com` → Gmail, `drive.google.com` → Drive, `docs.google.com` → Docs, `calendar.google.com` → Calendar, `meet.google.com` → Meet |
| **AI / 大模型** | `chatgpt.com` → ChatGPT, `claude.ai` → Claude, `bard.google.com` → Bard, `github.com/features/copilot` → Copilot |

**用户体验：**

```
用户点击"新增工作区"（侧边栏中）
  │
  ▼
显示模态框：

  ┌──────────────────────────────────────┐
  │ 新增工作区                            │
  │                                        │
  │ 名称: [________________]               │
  │                                        │
  │ 模板 (可选):                           │
  │  ○ 空白                               │
  │  ○ Web 开发      ← 推荐               │
  │  ○ 研究                               │
  │  ○ 社交                               │
  │  ○ Google 生态                        │
  │  ○ AI / 大模型                        │
  │  ○ 从现有工作区保存的模板...           │
  │                                        │
  │           [取消]      [创建工作区]      │
  └──────────────────────────────────────┘

  ▼
api.createWorkspace(name, templateId)
  ├─ 创建工作区记录
  ├─ 从模板复制 autoGroupRules（调整 workspaceId）
  └─ 返回新的 workspaceId
```

**将工作区保存为模板：**

在上下文菜单中："💾 保存为模板" → 将此工作区的自动分组规则保存为可复用的模板。

**涉及文件：**

| 文件 | 变更内容 |
|------|---------|
| `extension/src/db/database.ts` | 新存储区：`templates`（键路径：`id`） |
| `extension/src/db/template-repo.ts` | **新建** —— 模板的 CRUD 操作，内置模板的种子数据 |
| `extension/src/components/CreateWorkspaceModal.tsx` | **新建** —— 模板选择器模态框 |
| `extension/src/components/Sidebar.tsx` | 将内联"创建工作区"替换为打开模态框 |
| `extension/src/components/ContextMenu.tsx` | 添加"保存为模板"菜单项 |
| `extension/src/lib/api.ts` | 添加 `createWorkspaceFromTemplate()`、`saveWorkspaceAsTemplate()` |

---

## 低优先级 / 探索性

### 11. Chrome 原生标签组集成

**概念：** 使用 `chrome.tabGroups` API 将扩展的分组与 Chrome 的内置标签组视觉样式（彩色组标题、折叠/展开）进行同步。

**挑战：**
- Chrome 的原生标签组是**基于窗口的**（仅适用于已打开的标签页），而扩展的分组是**基于数据的**（适用于已保存和已打开的标签页）
- 映射策略：`TabGroup.name + color → chrome.tabGroups.update(groupId, { title, color })`
- 分组 ID 需要持久化映射：`extensionGroupId ↔ nativeChromeGroupId`
- 跨窗口移动标签页会破坏原生组的从属关系——需要 `onDetached` / `onAttached` 处理

**需要进一步研究才能给出可行的设计方案。**

---

### 12. 定时操作

**概念：** 允许用户安排操作在特定时间/日期运行。

**示例：**
- "每天早上 9:00 打开我的'工作'工作区"
- "每周五下午 5:00 将所有工作区标签页保存为会话"
- "午夜 12:00 关闭所有工作区标签页"

**依赖于：** `chrome.alarms`（已在清单中声明）、`chrome.notifications`。需要在设置界面中添加调度配置界面。

---

### 13. 工作区分享

**概念：** 将工作区配置（结构、规则、分组名称）分享给其他用户，但**不分享**个人标签页数据。

**设计草案：**

```
导出 → "分享工作区结构" → 生成：
  {
    "type": "workspace-template-share",
    "version": 1,
    "data": {
      "workspaceName": "Web 开发",
      "autoGroupRules": [...],
      "tabGroups": [
        { "name": "文档", "color": "blue" },
        { "name": "仓库", "color": "green" }
      ]
      // 不含标签页 URL —— 仅结构
    }
  }

→ 复制到剪贴板 / 保存为 .wst.json 文件
→ 接收者：设置 → 导入 → 选择文件 → 创建工作区
```

---

### 14. 页面内容搜索

**概念：** 在工作区中搜索已保存标签页的**完整页面文本内容**，使已保存的标签页即使标题/URL 无提示信息，也能被重新找到。

**挑战：**
- 需要 `scripting` 权限 + `<all_urls>` 主机权限（或 `activeTab` 权限，但那样只能搜索已打开的标签页）
- 需要为每个已索引的标签页获取并存储页面文本（存储影响：每个页面约 20-100KB 的纯文本）
- 需要后台内容脚本注入（Service Worker 无法访问 DOM）
- 隐私影响：需要提前想好明确的披露和用户控制方案

**替代方案：** 与其在本地构建页面内容索引，不如集成浏览历史 API（`chrome.history`）以进行"已访问过"匹配，作为更轻量级的近似方案。

---

## 附录

### A. 数据模型变更汇总

| 功能 | 表 | 变更 |
|----------|-------|--------|
| #2 拖拽排序 | `tabWorkspaces` | 新增字段：`sortOrder: number` |
| #4 删除撤销 | `workspaces`、`tabGroups`、`tabs` | 新增字段：`deletedAt: number \| null` |
| #6 跨设备同步 | 全部 | 新增字段：`updatedAt: number` |
| #9 标签页备注 | `tabs` | 新增字段：`notes: string`、`notesUpdatedAt: number` |
| #10 模板 | 新存储区 | `templates`，含：`id`、`name`、`description`、`autoGroupRules`、`isBuiltIn` |

**IndexedDB 迁移：**

现有数据库版本号（见 `database.ts` 中的 `DB_VERSION`）需要递增。每次迁移需要读取现有数据，添加带有默认值的新字段，然后将数据写回——全部在单个 `upgrade` 事务中完成。

### B. 权限变更汇总

| 功能 | 清单权限 | API |
|----------|-----------------|-----|
| #3 快捷键 | 无（清单中的 `commands` 字段） | `chrome.commands` |
| #6 方案 B (Drive) | `identity` | Chrome Identity API |
| #7 书签导入 | 无（只读 `getTree` 不需要权限） | `chrome.bookmarks` |
| #8 多窗口 | 无（`tabs` 权限已覆盖） | `chrome.windows` |
| #14 内容搜索 | `scripting` + 主机权限 | `chrome.scripting` |

### C. 建议实施顺序

1. **第一阶段（快速见效）：** #4 删除撤销 + #2 拖拽排序 —— 打磨核心用户体验，完善日常操作体验。
2. **第二阶段（搜索升级）：** #1 模糊搜索 —— 使搜索功能强大 10 倍以上。
3. **第三阶段（效率提升）：** #3 键盘快捷键 + #5 统计仪表盘 —— 通过更快的导航和概览功能赋能高级用户。
4. **第四阶段（生态系统集成）：** #7 书签导入 + #6 方案 A (Storage Sync) —— 让用户轻松迁移和同步。
5. **第五阶段（深度功能）：** #9 标签页备注 + #10 工作区模板 —— 满足需要围绕工作区进行更深入的组织和上下文的用户需求。
6. **第六阶段（探索性）：** #11-#14 —— 根据用户反馈进行研究和设计。

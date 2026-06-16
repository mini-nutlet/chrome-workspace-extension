// Export / Import — backup and restore all extension data.
// Reads raw rows from IndexedDB + settings from chrome.storage.local,
// serialises to JSON, and supports round-trip restore with ID preservation.

import { getDb, invalidateSimRulesCache } from "../db/database";
import type {
  WorkspaceRow,
  TabRow,
  TabWorkspaceRow,
  TabGroupRow,
  BookmarkRow,
  AutoGroupRuleRow,
  SessionRow,
} from "../db/database";
import type { SimilarityRule } from "./types";
import { CURRENT_WS_NAME } from "../db/workspace-repo";

// ── Export format ────────────────────────────────────────────────────

export interface ExportData {
  version: 1;
  exportedAt: string;
  exportSource: "workspace-companion";
  settings: {
    theme?: string;
    similarityRules?: SimilarityRule[];
    currentWorkspaceId?: number;
  };
  data: {
    workspaces: WorkspaceRow[];
    tabs: TabRow[];
    tabWorkspaces: TabWorkspaceRow[];
    tabGroups: TabGroupRow[];
    bookmarks: BookmarkRow[];
    autoGroupRules: AutoGroupRuleRow[];
    sessions: SessionRow[];
  };
}

// ── Validation ───────────────────────────────────────────────────────

/** Runtime type guard — returns true only if the payload looks like a
 *  valid export.  Prevents destructive import of unrelated JSON files. */
export function validateExportFormat(data: unknown): data is ExportData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.version !== "number") return false;
  if (typeof d.exportedAt !== "string") return false;
  if (!d.data || typeof d.data !== "object") return false;

  const stores = d.data as Record<string, unknown>;
  const requiredStores = [
    "workspaces", "tabs", "tabWorkspaces", "tabGroups",
    "bookmarks", "autoGroupRules", "sessions",
  ];
  for (const key of requiredStores) {
    if (!Array.isArray(stores[key])) return false;
  }
  return true;
}

// ── Export ────────────────────────────────────────────────────────────

/** Read all extension data and assemble the export payload.
 *  The auto-tracking "Open Tabs" workspace (which mirrors live browser
 *  tabs) is excluded — its data is transient browser state, not
 *  user-saved content. */
export async function exportAllData(): Promise<ExportData> {
  const db = await getDb();

  // Read all stores in parallel.
  const [
    workspaces,
    tabs,
    tabWorkspaces,
    tabGroups,
    bookmarks,
    autoGroupRules,
    sessions,
  ] = await Promise.all([
    db.getAll("workspaces") as Promise<WorkspaceRow[]>,
    db.getAll("tabs") as Promise<TabRow[]>,
    db.getAll("tabWorkspaces") as Promise<TabWorkspaceRow[]>,
    db.getAll("tabGroups") as Promise<TabGroupRow[]>,
    db.getAll("bookmarks") as Promise<BookmarkRow[]>,
    db.getAll("autoGroupRules") as Promise<AutoGroupRuleRow[]>,
    db.getAll("sessions") as Promise<SessionRow[]>,
  ]);

  // Identify the auto-tracking workspace — it mirrors live browser tabs
  // and must not be exported (its data is transient, not user-saved).
  const currentWs = workspaces.find(
    (w) => w.name === CURRENT_WS_NAME && w.parentId === 0,
  );
  const currentWsId = currentWs?.id;

  // Filter out all data tied to the auto-tracking workspace.
  let filteredWorkspaces = workspaces;
  let filteredTabs = tabs;
  let filteredTw = tabWorkspaces;
  let filteredGroups = tabGroups;
  let filteredBookmarks = bookmarks;
  let filteredSessions = sessions;

  if (currentWsId != null) {
    filteredWorkspaces = workspaces.filter((w) => w.id !== currentWsId);
    filteredTw = tabWorkspaces.filter((tw) => tw.workspaceId !== currentWsId);
    filteredGroups = tabGroups.filter((g) => g.workspaceId !== currentWsId);
    filteredBookmarks = bookmarks.filter((b) => b.workspaceId !== currentWsId);
    filteredSessions = sessions.filter((s) => s.workspaceId !== currentWsId);

    // Keep tabs that are still referenced by at least one remaining workspace.
    // Tabs only referenced by the Open Tabs workspace are excluded.
    const keptTabIds = new Set(filteredTw.map((tw) => tw.tabId));
    filteredTabs = tabs.filter((t) => t.id != null && keptTabIds.has(t.id));
  }

  // Read chrome.storage.local settings — exclude currentWorkspaceId
  // since it points to the auto-tracking workspace.
  const stored = await chrome.storage.local.get([
    "theme",
    "similarityRules",
  ]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportSource: "workspace-companion",
    settings: {
      theme: stored.theme as string | undefined,
      similarityRules: stored.similarityRules as SimilarityRule[] | undefined,
    },
    data: {
      workspaces: filteredWorkspaces,
      tabs: filteredTabs,
      tabWorkspaces: filteredTw,
      tabGroups: filteredGroups,
      bookmarks: filteredBookmarks,
      autoGroupRules,
      sessions: filteredSessions,
    },
  };
}

/** Serialise and trigger a file download in the browser. */
export function downloadExport(data: ExportData): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const a = document.createElement("a");
  a.href = url;
  a.download = `workspace-companion-backup-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Import ────────────────────────────────────────────────────────────

const STORE_NAMES = [
  "workspaces", "tabs", "tabWorkspaces", "tabGroups",
  "bookmarks", "autoGroupRules", "sessions",
] as const;

/**
 * Import data into IndexedDB and chrome.storage.local.
 *
 * All store clears + inserts run inside a single readwrite transaction.
 * If any step fails the entire transaction rolls back and
 * chrome.storage.local is never touched.
 */
export async function importAllData(data: ExportData): Promise<void> {
  if (!validateExportFormat(data)) {
    throw new Error("Invalid export format");
  }

  const db = await getDb();

  // Open a single transaction covering all stores.
  const tx = db.transaction(STORE_NAMES, "readwrite");

  // Phase 1 — clear.
  for (const name of STORE_NAMES) {
    await tx.objectStore(name).clear();
  }

  // Phase 2 — insert with put() to preserve original IDs.
  for (const name of STORE_NAMES) {
    const store = tx.objectStore(name);
    const rows = data.data[name];
    for (const row of rows) {
      await store.put(row);
    }
  }

  // Commit — throws if anything failed, rolling back all stores.
  await tx.done;

  // Only after DB commit succeeds, update chrome.storage.local.
  const { theme, similarityRules, currentWorkspaceId } = data.settings;
  const toSet: Record<string, unknown> = {};
  if (theme !== undefined) toSet.theme = theme;
  if (similarityRules !== undefined) toSet.similarityRules = similarityRules;

  // Restore the auto-tracking "Open Tabs" workspace — it is always
  // excluded from exports, so an import would otherwise leave the
  // extension without its live-tab mirror.  Recreate it here so the
  // UI immediately shows browser tabs after import.
  const allWs = await db.getAll("workspaces") as WorkspaceRow[];
  const hasCurrent = allWs.some(
    (w) => w.name === CURRENT_WS_NAME && w.parentId === 0,
  );
  if (!hasCurrent) {
    const newId = await db.add("workspaces", {
      parentId: 0,
      sortOrder: 0,
      name: CURRENT_WS_NAME,
      description: "Auto-tracked tabs",
      icon: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    toSet.currentWorkspaceId = newId as number;
  } else if (currentWorkspaceId !== undefined) {
    toSet.currentWorkspaceId = currentWorkspaceId;
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  // Invalidate similarity-rules cache so background picks up imported rules.
  invalidateSimRulesCache();
}

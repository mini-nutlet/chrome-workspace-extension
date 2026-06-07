// Local storage API — replaces HTTP calls to the Go backend with
// direct IndexedDB operations. Uses static imports so Vite bundles
// everything without dynamic import() in service worker context.

import type { Workspace, Tab, TabGroup, TabGroupTree, AutoGroupRule, SearchResult, DuplicateCheck, Session } from "./types";

import { listWorkspaces as dbListWs, createWorkspace as dbCreateWs, updateWorkspace, deleteWorkspace as dbDeleteWs, reorderWorkspaces as dbReorderWs } from "../db/workspace-repo";
import { upsertTab as dbUpsertTab, removeTab as dbRemoveTab, findDuplicate as dbFindDup, setTabGroup as dbSetGroup, syncActiveByUrl as dbSyncActiveByUrl, syncActiveToAllWorkspaces } from "../db/tab-repo";
import { listGroups, createTabGroup as dbCreateGroup, updateTabGroup as dbUpdateGroup, deleteTabGroup as dbDeleteGroup, reorderGroups as dbReorderGroups, getTabGroupTree as dbGetTree } from "../db/tabgroup-repo";
import { listBookmarks as dbListBm, createBookmark as dbCreateBm, deleteBookmark as dbDeleteBm } from "../db/bookmark-repo";
import { saveSession as dbSaveSession, restoreSession as dbRestoreSession, deleteSession as dbDeleteSession } from "../db/session-repo";
import { listRules, runAutoGroup as dbRunAutoGroup } from "../db/autogroup-repo";
import { search as dbSearch } from "../db/search";
import { getDb } from "../db/database";

// ── Workspace ──────────────────────────────────────────────────────

export async function listWorkspaces(): Promise<Workspace[]> { return dbListWs(); }
export async function createWorkspace(name: string, description = "", icon = "", parentId = 0, afterId = 0): Promise<Workspace> { return dbCreateWs(name, description, icon, parentId, afterId); }
export async function renameWorkspace(id: number, name: string, description?: string, icon?: string): Promise<Workspace> { return (await updateWorkspace(id, { name, description, icon }))!; }
export async function deleteWorkspace(id: number): Promise<void> { return dbDeleteWs(id); }
export async function reorderWorkspaces(items: { id: number; parent_id: number; sort_order: number }[]): Promise<void> { return dbReorderWs(items); }

// ── Tab ────────────────────────────────────────────────────────────

export async function listTabs(workspaceId: number): Promise<Tab[]> {
  const { listTabsByWorkspace } = await import("../db/tab-repo");
  return listTabsByWorkspace(workspaceId);
}

export async function upsertTab(tab: Partial<Tab> & { url: string }): Promise<Tab> {
  return dbUpsertTab({
    window_id: tab.window_id ?? 0, chrome_tab_id: tab.chrome_tab_id ?? 0,
    workspace_id: tab.workspace_id ?? 0, title: tab.title ?? "",
    url: tab.url, active: tab.active, group_id: tab.group_id,
    snapshot: tab.snapshot,
  });
}

export async function removeTab(windowId: number, chromeTabId: number, currentWorkspaceId?: number): Promise<void> {
  return dbRemoveTab(windowId, chromeTabId, currentWorkspaceId ?? 0);
}

export async function findDuplicate(url: string): Promise<DuplicateCheck> { return dbFindDup(url); }
export async function setTabGroup(tabId: number, groupId: number, workspaceId: number): Promise<void> { return dbSetGroup(tabId, workspaceId, groupId); }
export async function syncActiveByUrl(url: string): Promise<void> { return dbSyncActiveByUrl(url); }

// ── Tab Group ──────────────────────────────────────────────────────

export async function listTabGroups(workspaceId: number): Promise<TabGroup[]> { return listGroups(workspaceId); }
export async function createTabGroup(workspaceId: number, name: string, color = ""): Promise<TabGroup> { return dbCreateGroup(workspaceId, name, color); }
export async function updateTabGroup(id: number, updates: Partial<Pick<TabGroup, "name" | "color" | "collapsed" | "sort_order">>): Promise<TabGroup> {
  await dbUpdateGroup(id, updates);
  const gs = await listGroups(0);
  return gs.find(g => g.id === id)!;
}
export async function deleteTabGroup(id: number): Promise<void> { return dbDeleteGroup(id); }
export async function reorderTabGroups(workspaceId: number, orderedIds: number[]): Promise<void> { return dbReorderGroups(workspaceId, orderedIds); }
export async function getTabGroupTree(workspaceId: number): Promise<TabGroupTree> { return dbGetTree(workspaceId); }

// ── Bookmark ───────────────────────────────────────────────────────

export async function listBookmarks(workspaceId = 0): Promise<import("./types").Bookmark[]> { return dbListBm(workspaceId); }
export async function createBookmark(bm: Partial<import("./types").Bookmark> & { url: string }): Promise<import("./types").Bookmark> {
  return dbCreateBm({ workspace_id: bm.workspace_id ?? 0, title: bm.title ?? "", url: bm.url, tags: bm.tags });
}
export async function deleteBookmark(id: number): Promise<void> { return dbDeleteBm(id); }

// ── Search ─────────────────────────────────────────────────────────

export async function search(query: string, workspaceId = 0, limit = 30): Promise<SearchResult[]> { return dbSearch(query, workspaceId, limit); }

// ── Session ────────────────────────────────────────────────────────

export async function saveSession(workspaceId: number, tabs: Tab[]): Promise<Session> {
  await dbSaveSession(workspaceId, tabs);
  return { tabs, saved_at: new Date().toISOString() };
}
export async function restoreSession(workspaceId: number): Promise<Session> { return dbRestoreSession(workspaceId); }
export async function deleteSession(workspaceId: number): Promise<void> { return dbDeleteSession(workspaceId); }

// ── Auto Group Rules ───────────────────────────────────────────────

export async function listAutoGroupRules(): Promise<AutoGroupRule[]> { return listRules(); }

export async function createAutoGroupRule(domainPattern: string, groupName: string, enabled = true): Promise<AutoGroupRule> {
  const db = await getDb();
  const rules = await listRules();
  const sortOrder = rules.length > 0 ? Math.max(...rules.map(r => r.sort_order)) + 1 : 1;
  const id = await db.add("autoGroupRules", {
    domainPattern, groupName, enabled: enabled ? 1 : 0, sortOrder,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const row = await db.get("autoGroupRules", id);
  return { id: row.id!, domain_pattern: row.domainPattern, group_name: row.groupName, enabled: row.enabled !== 0, sort_order: row.sortOrder, created_at: row.createdAt, updated_at: row.updatedAt };
}

export async function updateAutoGroupRule(id: number, updates: Partial<Pick<AutoGroupRule, "domain_pattern" | "group_name">> & { enabled?: boolean }): Promise<AutoGroupRule> {
  const db = await getDb();
  const row = await db.get("autoGroupRules", id);
  if (!row) throw new Error("not found");
  if (updates.domain_pattern !== undefined) row.domainPattern = updates.domain_pattern;
  if (updates.group_name !== undefined) row.groupName = updates.group_name;
  if (updates.enabled !== undefined) row.enabled = updates.enabled ? 1 : 0;
  row.updatedAt = new Date().toISOString();
  await db.put("autoGroupRules", row);
  return { id: row.id!, domain_pattern: row.domainPattern, group_name: row.groupName, enabled: row.enabled !== 0, sort_order: row.sortOrder, created_at: row.createdAt, updated_at: row.updatedAt };
}

export async function deleteAutoGroupRule(id: number): Promise<void> { await (await getDb()).delete("autoGroupRules", id); }
export async function runAutoGroup(): Promise<{ grouped_count: number }> { return { grouped_count: await dbRunAutoGroup() }; }

// ── Browser helpers ────────────────────────────────────────────────

export function normalizeUrl(u: string): string {
  try {
    const p = new URL(u);
    p.hash = "";
    p.hostname = p.hostname.replace(/^www\./, "");
    if (p.pathname.endsWith("/") && p.pathname.length > 1) p.pathname = p.pathname.slice(0, -1);
    return p.toString();
  } catch { return u; }
}

export async function closeBrowserTabByUrl(url: string): Promise<boolean> {
  const allTabs = await chrome.tabs.query({});
  const target = normalizeUrl(url);
  const match = allTabs.find((t) => t.url && normalizeUrl(t.url) === target);
  if (match && match.id != null) { await chrome.tabs.remove(match.id); return true; }
  return false;
}

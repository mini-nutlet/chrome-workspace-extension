import { getDb, now, type TabGroupRow } from "./database";
import { listTabsByGroup, listTabsByWorkspace, setTabGroup, type Tab } from "./tab-repo";

export interface TabGroup {
  id: number;
  workspace_id: number;
  name: string;
  color: string;
  collapsed: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TabGroupWithTabs extends TabGroup {
  tabs: Tab[];
}

function toApi(row: TabGroupRow): TabGroup {
  return {
    id: row.id!,
    workspace_id: row.workspaceId,
    name: row.name,
    color: row.color,
    collapsed: row.collapsed !== 0,
    sort_order: row.sortOrder,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function listGroups(workspaceId: number): Promise<TabGroup[]> {
  const db = await getDb();
  const idx = db.transaction("tabGroups").store.index("workspaceId");
  const rows = await idx.getAll(workspaceId);
  return rows.map(toApi).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

export async function createTabGroup(workspaceId: number, name: string, color = ""): Promise<TabGroup> {
  const db = await getDb();
  const groups = await listGroups(workspaceId);
  // Prevent duplicate group names (case-insensitive).
  const existing = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const sortOrder = groups.length > 0 ? Math.max(...groups.map(g => g.sort_order)) + 1 : 0;
  const id = await db.add("tabGroups", {
    workspaceId, name, color, collapsed: 0, sortOrder,
    createdAt: now(), updatedAt: now(),
  });
  return toApi(await db.get("tabGroups", id) as TabGroupRow);
}

export async function updateTabGroup(id: number, updates: {
  name?: string; color?: string; collapsed?: boolean; sort_order?: number;
}): Promise<void> {
  const db = await getDb();
  const row = await db.get("tabGroups", id);
  if (!row) return;
  // Prevent renaming to a name that already exists (case-insensitive).
  if (updates.name !== undefined) {
    const groups = await listGroups(row.workspaceId);
    const conflict = groups.find(
      (g) => g.id !== id && g.name.toLowerCase() === updates.name!.toLowerCase(),
    );
    if (conflict) return; // silently skip — name is already taken
    row.name = updates.name;
  }
  if (updates.color !== undefined) row.color = updates.color;
  if (updates.collapsed !== undefined) row.collapsed = updates.collapsed ? 1 : 0;
  if (updates.sort_order !== undefined) row.sortOrder = updates.sort_order;
  row.updatedAt = now();
  await db.put("tabGroups", row);
}

export async function deleteTabGroup(id: number): Promise<void> {
  const db = await getDb();
  const row = await db.get("tabGroups", id);
  if (!row) return;
  // Delete all tabs in this group — don't move them to Ungrouped.
  const twList = (await db.getAll("tabWorkspaces")).filter((tw: any) => tw.groupId === id);
  for (const tw of twList) {
    const tab = await db.get("tabs", tw.tabId);
    // Delete the junction entry.
    await db.delete("tabWorkspaces", tw.id!);
    if (tab) {
      // If this tab is a snapshot (chrome_tab_id <= 0) and has no other
      // workspace refs, delete the tab row so it doesn't become an orphan.
      if (tab.chromeTabId <= 0) {
        const remaining = (await db.getAll("tabWorkspaces")).filter((r: any) => r.tabId === tab.id!);
        if (remaining.length === 0) {
          await db.delete("tabs", tab.id!);
        }
      } else {
        // Live tab — also check if any workspace still references it.
        // If not, clean up the orphan tab row.
        const remaining = (await db.getAll("tabWorkspaces")).filter((r: any) => r.tabId === tab.id!);
        if (remaining.length === 0) {
          await db.delete("tabs", tab.id!);
        }
      }
    }
  }
  await db.delete("tabGroups", id);
}

export async function reorderGroups(workspaceId: number, orderedIds: number[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("tabGroups", "readwrite");
  for (let i = 0; i < orderedIds.length; i++) {
    const row = await tx.store.get(orderedIds[i]);
    if (row && row.workspaceId === workspaceId) {
      row.sortOrder = i;
      await tx.store.put(row);
    }
  }
  await tx.done;
}

export async function getTabGroupTree(workspaceId: number): Promise<{
  groups: TabGroupWithTabs[];
  ungrouped_tabs: Tab[];
}> {
  const groups = await listGroups(workspaceId);
  const allTabs = await listTabsByWorkspace(workspaceId);
  const groupIds = new Set(groups.map(g => g.id));

  const groupsWithTabs: TabGroupWithTabs[] = [];
  for (const g of groups) {
    const tabs = await listTabsByGroup(g.id, workspaceId);
    groupsWithTabs.push({ ...g, tabs });
  }

  const ungroupedTabs = allTabs.filter(t => t.group_id === 0 || !groupIds.has(t.group_id));

  return { groups: groupsWithTabs, ungrouped_tabs: ungroupedTabs };
}

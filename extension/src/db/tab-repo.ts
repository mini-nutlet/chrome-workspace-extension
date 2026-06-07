import { getDb, now, hashUrl, type TabRow, type TabWorkspaceRow } from "./database";

export interface Tab {
  id: number;
  window_id: number;
  chrome_tab_id: number;
  workspace_id: number;
  group_id: number;
  title: string;
  url: string;
  url_hash: string;
  active: boolean;
  is_open?: boolean;
  created_at: string;
  updated_at: string;
}

function toApi(row: TabRow, tw?: Partial<TabWorkspaceRow>): Tab {
  return {
    id: row.id!,
    window_id: row.windowId,
    chrome_tab_id: row.chromeTabId,
    workspace_id: tw?.workspaceId ?? 0,
    group_id: tw?.groupId ?? 0,
    title: row.title,
    url: row.url,
    url_hash: row.urlHash,
    active: (tw?.active ?? 0) !== 0,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function ungroupedGroupId(workspaceId: number): Promise<number> {
  const db = await getDb();
  const idx = db.transaction("tabGroups").store.index("workspaceId");
  let cursor = await idx.openCursor(workspaceId);
  while (cursor) {
    if (cursor.value.name === "Ungrouped") return cursor.value.id!;
    cursor = await cursor.continue();
  }
  // Auto-create if missing
  const { createTabGroup } = await import("./tabgroup-repo");
  const g = await createTabGroup(workspaceId, "Ungrouped", "gray");
  return g.id;
}

// Ensure a tab↔workspace junction row exists (INSERT OR IGNORE).
async function linkWorkspace(tabId: number, workspaceId: number, active: boolean, groupId: number) {
  if (workspaceId <= 0) return;
  const db = await getDb();
  const idx = db.transaction("tabWorkspaces", "readwrite").store.index("tabWorkspace");
  const existing = await idx.get([tabId, workspaceId]);
  if (existing) return; // DO NOTHING on conflict
  await db.add("tabWorkspaces", {
    tabId, workspaceId, active: active ? 1 : 0, groupId, addedAt: now(),
  });
}

export async function upsertTab(tab: {
  window_id: number; chrome_tab_id: number; workspace_id: number;
  title: string; url: string; active?: boolean; group_id?: number; snapshot?: boolean;
}): Promise<Tab> {
  const db = await getDb();
  const urlHash = hashUrl(tab.url);
  const active = tab.active ?? false;
  // Don't eagerly create/assign Ungrouped — let auto-group rules run first.
  // Ungrouped is only created as a fallback when no domain rule matches.

  // Snapshot: create independent row with auto-group by domain rules.
  if (tab.snapshot) {
    // Check for existing URL in this workspace first.
    const twRows = (await db.getAll("tabWorkspaces")).filter((r: TabWorkspaceRow) => r.workspaceId === tab.workspace_id);
    for (const twRow of twRows) {
      if (!twRow.tabId) continue;
      const existingTab = await db.get("tabs", twRow.tabId);
      if (existingTab && existingTab.urlHash === urlHash) {
        // URL already pinned — return existing, don't duplicate.
        const tw = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [existingTab.id!, tab.workspace_id]);
        return toApi(existingTab, tw);
      }
    }

    const id = await db.add("tabs", {
      windowId: 0, chromeTabId: -(Date.now() + Math.random()),
      title: tab.title, url: tab.url, urlHash,
      createdAt: now(), updatedAt: now(),
    });
    const row = await db.get("tabs", id);
    row.chromeTabId = -(id as number);
    await db.put("tabs", row);

    // Link with group_id=0 so auto-group can match it.
    await linkWorkspace(id as number, tab.workspace_id, active, 0);

    // Auto-group by domain rules.
    const { autoGroupTab } = await import("./autogroup-repo");
    await autoGroupTab(id as number, tab.workspace_id, urlHash);

    // Fallback: if still ungrouped, assign to Ungrouped group.
    const tw = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [id as number, tab.workspace_id]);
    if (tw && tw.groupId === 0) {
      const ugId = await ungroupedGroupId(tab.workspace_id);
      if (ugId > 0) {
        tw.groupId = ugId;
        await db.put("tabWorkspaces", tw);
      }
    }

    const tw2 = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [id as number, tab.workspace_id]);
    return toApi(row, tw2);
  }

  // Look up by window_id + chrome_tab_id (single readwrite tx for atomicity)
  const tx = db.transaction("tabs", "readwrite");
  const idx = tx.store.index("windowChrome");
  const existing = await idx.get([tab.window_id, tab.chrome_tab_id]);

  if (existing) {
    existing.title = tab.title;
    existing.url = tab.url;
    existing.urlHash = urlHash;
    existing.updatedAt = now();
    await tx.store.put(existing);
    await tx.done;

    await linkWorkspace(existing.id!, tab.workspace_id, active, tab.group_id ?? 0);
    const tw = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [existing.id!, tab.workspace_id]);
    return toApi(existing, tw);
  }
  await tx.done;

  // Dedup by URL within workspace — collect candidates first, then check
  const twRows = (await db.getAll("tabWorkspaces")).filter((r: TabWorkspaceRow) => r.workspaceId === tab.workspace_id);
  for (const twRow of twRows) {
    if (!twRow.tabId) continue;
    const t = await db.get("tabs", twRow.tabId);
    if (t && t.urlHash === urlHash) {
      t.windowId = tab.window_id;
      t.chromeTabId = tab.chrome_tab_id;
      t.title = tab.title;
      t.updatedAt = now();
      await db.put("tabs", t);
      await linkWorkspace(t.id!, tab.workspace_id, active, tab.group_id ?? 0);
      const tw2 = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [t.id!, tab.workspace_id]);
      return toApi(t, tw2);
    }
  }

  // New tab — link with group_id=0 first so auto-group can match it.
  const id = await db.put("tabs", {
    windowId: tab.window_id, chromeTabId: tab.chrome_tab_id,
    title: tab.title, url: tab.url, urlHash,
    createdAt: now(), updatedAt: now(),
  });
  await linkWorkspace(id as number, tab.workspace_id, active, 0);

  // Auto-group: checks tabs with group_id=0 and applies domain rules.
  const { autoGroupTab } = await import("./autogroup-repo");
  await autoGroupTab(id as number, tab.workspace_id, urlHash);

  // Fallback: if still ungrouped after auto-group, assign to the Ungrouped group.
  const tw = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [id as number, tab.workspace_id]);
  if (tw && tw.groupId === 0) {
    const ugId = await ungroupedGroupId(tab.workspace_id);
    if (ugId > 0) {
      tw.groupId = ugId;
      await db.put("tabWorkspaces", tw);
    }
  }

  const row = await db.get("tabs", id);
  const tw2 = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [id as number, tab.workspace_id]);
  return toApi(row, tw2);
}

export async function removeTab(windowId: number, chromeTabId: number, currentWsId: number): Promise<void> {
  const db = await getDb();

  // Primary lookup: windowChrome index (matches live browser tabs).
  let existing = await db.transaction("tabs").store.index("windowChrome").get([windowId, chromeTabId]);

  // Fallback: snapshot tabs store chrome_tab_id = -(tab_id).
  // If the windowChrome index was changed by a prior multi-workspace
  // removal, we can still find the row by its primary key.
  if (!existing && windowId === 0 && chromeTabId < 0) {
    existing = await db.transaction("tabs").store.get(-chromeTabId);
  }

  if (!existing) return;

  const tabId = existing.id!;
  const tx = db.transaction("tabWorkspaces", "readwrite");

  // Remove junction for the requested workspace.
  const twIdx = tx.store.index("tabWorkspace");
  const tw = await twIdx.get([tabId, currentWsId]);
  if (tw) await tx.store.delete(tw.id!);

  // Mark inactive in any other workspace that still references this tab.
  const allTw = await tx.store.getAll();
  for (const row of allTw) {
    if (row.tabId === tabId && row.workspaceId !== currentWsId) {
      row.active = 0;
      await tx.store.put(row);
    }
  }
  await tx.done;

  // Clean up the shared tab row if no workspace references it any more.
  const remaining = (await db.getAll("tabWorkspaces")).filter((r: TabWorkspaceRow) => r.tabId === tabId);
  if (remaining.length === 0) {
    await db.delete("tabs", tabId);
  }
  // When other workspaces still reference this tab, leave the tab row
  // untouched so its windowChrome index stays consistent for future
  // delete / navigate calls.  is_open is already handled by the
  // cross-reference in refreshTree (context.tsx).
}

export async function findDuplicate(url: string): Promise<{
  duplicate: boolean; tab: { chrome_tab_id: number; window_id: number; title: string; } | null;
}> {
  const db = await getDb();
  const urlHash = hashUrl(url);
  const all = await db.getAll("tabs");
  // Find by urlHash, not matching self by full URL
  for (const t of all) {
    if (t.urlHash === urlHash && t.chromeTabId > 0) {
      return {
        duplicate: true,
        tab: { chrome_tab_id: t.chromeTabId, window_id: t.windowId, title: t.title },
      };
    }
  }
  return { duplicate: false, tab: null };
}

export async function syncActiveToAllWorkspaces(windowId: number, chromeTabId: number, active: boolean): Promise<void> {
  const db = await getDb();
  const idx = db.transaction("tabs").store.index("windowChrome");
  const tab = await idx.get([windowId, chromeTabId]);
  if (!tab) return;

  const tx = db.transaction("tabWorkspaces", "readwrite");
  const all = await tx.store.getAll();
  for (const tw of all) {
    if (tw.tabId === tab.id!) {
      tw.active = active ? 1 : 0;
      await tx.store.put(tw);
    }
  }
  await tx.done;
}

export async function syncActiveByUrl(url: string): Promise<void> {
  const db = await getDb();
  const urlHash = hashUrl(url);
  // Only activate the matching URL — don't deactivate other tabs.
  // In a multi-window setup each window has its own active tab;
  // deactivating all would lose the other windows' active state.
  const allTabs = await db.getAll("tabs");
  const matchingIds = new Set(allTabs.filter((t: TabRow) => t.urlHash === urlHash).map((t: TabRow) => t.id!));
  if (matchingIds.size === 0) return;

  const tx = db.transaction("tabWorkspaces", "readwrite");
  const allTw = await tx.store.getAll();
  for (const tw of allTw) {
    if (matchingIds.has(tw.tabId)) {
      tw.active = 1;
      await tx.store.put(tw);
    }
  }
  await tx.done;
}

export async function setTabGroup(tabId: number, workspaceId: number, groupId: number): Promise<void> {
  const db = await getDb();
  const idx = db.transaction("tabWorkspaces", "readwrite").store.index("tabWorkspace");
  const tw = await idx.get([tabId, workspaceId]);
  if (tw) {
    tw.groupId = groupId;
    await db.put("tabWorkspaces", tw);
  }
}

export async function listTabsByWorkspace(workspaceId: number): Promise<Tab[]> {
  const db = await getDb();
  const twIdx = db.transaction("tabWorkspaces").store.index("workspaceId");
  const tws = await twIdx.getAll(workspaceId);
  const result: Tab[] = [];
  for (const tw of tws) {
    const tab = await db.get("tabs", tw.tabId);
    if (tab) result.push(toApi(tab, tw));
  }
  return result.sort((a, b) => a.id - b.id);
}

export async function listTabsByGroup(groupId: number, workspaceId: number): Promise<Tab[]> {
  const db = await getDb();
  const idx = db.transaction("tabWorkspaces").store.index("workspaceGroup");
  const tws = await idx.getAll([workspaceId, groupId]);
  const result: Tab[] = [];
  for (const tw of tws) {
    const tab = await db.get("tabs", tw.tabId);
    if (tab) result.push(toApi(tab, tw));
  }
  return result.sort((a, b) => a.id - b.id);
}

export async function getTab(id: number): Promise<Tab | null> {
  const db = await getDb();
  const row = await db.get("tabs", id);
  if (!row) return null;
  return toApi(row);
}

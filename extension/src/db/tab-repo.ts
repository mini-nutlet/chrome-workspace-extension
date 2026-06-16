import { getDb, now, hashUrl, hashUrlWithRules, loadSimilarityRules, type SimilarityRule, type TabRow, type TabWorkspaceRow } from "./database";
import { CURRENT_WS_NAME } from "./workspace-repo";

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
// When the junction already exists, update active + groupId so that
// explicit group assignments through upsertTab are honoured.
async function linkWorkspace(tabId: number, workspaceId: number, active: boolean, groupId: number) {
  if (workspaceId <= 0) return;
  const db = await getDb();
  const tx = db.transaction("tabWorkspaces", "readwrite");
  const idx = tx.store.index("tabWorkspace");
  const existing = await idx.get([tabId, workspaceId]);
  if (existing) {
    // Update active + group on existing junction (was previously a no-op).
    if (existing.active !== (active ? 1 : 0) || existing.groupId !== groupId) {
      existing.active = active ? 1 : 0;
      existing.groupId = groupId;
      await tx.store.put(existing);
    }
    await tx.done;
    return;
  }
  await tx.done;
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

  // Snapshot: create independent row.  When an explicit group_id is
  // provided (drag-to-group from TabPicker) use it directly; otherwise
  // run auto-group rules then fall back to Ungrouped.
  if (tab.snapshot) {
    const explicitGroup = (tab.group_id ?? 0) > 0 ? tab.group_id! : 0;

    // Check for existing URL in this workspace first.
    const twRows = (await db.getAll("tabWorkspaces")).filter((r: TabWorkspaceRow) => r.workspaceId === tab.workspace_id);
    for (const twRow of twRows) {
      if (!twRow.tabId) continue;
      const existingTab = await db.get("tabs", twRow.tabId);
      if (existingTab && existingTab.urlHash === urlHash) {
        // URL already pinned — update group if an explicit group was requested.
        if (explicitGroup > 0) {
          const tw = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [existingTab.id!, tab.workspace_id]);
          if (tw && tw.groupId !== explicitGroup) {
            tw.groupId = explicitGroup;
            await db.put("tabWorkspaces", tw);
          }
        }
        const tw2 = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [existingTab.id!, tab.workspace_id]);
        return toApi(existingTab, tw2);
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

    if (explicitGroup > 0) {
      // User explicitly targeted a group — link directly, skip auto-group.
      await linkWorkspace(id as number, tab.workspace_id, active, explicitGroup);
    } else {
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
    }

    const tw2 = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [id as number, tab.workspace_id]);
    return toApi(row, tw2);
  }

  // Look up by window_id + chrome_tab_id (single readwrite tx for atomicity).
  // Pre-load all workspace junctions so we can detect shared tab rows that
  // belong to saved workspaces — those hold immutable URL snapshots and
  // must not be overwritten by background sync servicing the Current workspace.
  const allTw = await db.getAll("tabWorkspaces");
  const tx = db.transaction("tabs", "readwrite");
  const idx = tx.store.index("windowChrome");
  const existing = await idx.get([tab.window_id, tab.chrome_tab_id]);

  if (existing) {
    // If this tab row is referenced by any workspace OTHER than the one
    // being upserted into, treat it as a shared row — saved workspaces
    // hold immutable URL snapshots and must not be overwritten.
    const isShared = allTw.some(
      (r: TabWorkspaceRow) => r.tabId === existing.id! && r.workspaceId !== tab.workspace_id,
    );
    if (!isShared) {
      existing.title = tab.title;
      existing.url = tab.url;
      existing.urlHash = urlHash;
    }
    existing.updatedAt = now();
    await tx.store.put(existing);
    await tx.done;

    // When an explicit group_id was provided (drag-and-drop, restore
    // session), honour it.  Otherwise reset to 0 and let auto-group
    // re-evaluate based on the new URL — groups track URLs, not tabIds.
    const explicitGroup = (tab.group_id ?? 0) > 0 ? tab.group_id! : 0;
    await linkWorkspace(existing.id!, tab.workspace_id, active, explicitGroup > 0 ? explicitGroup : 0);

    if (explicitGroup <= 0) {
      // Auto-group: checks tabs with group_id=0 and applies domain rules.
      const { autoGroupTab } = await import("./autogroup-repo");
      await autoGroupTab(existing.id!, tab.workspace_id, urlHash);

      // Fallback: if still ungrouped after auto-group, assign to Ungrouped.
      const twCheck = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [existing.id!, tab.workspace_id]);
      if (twCheck && twCheck.groupId === 0) {
        const ugId = await ungroupedGroupId(tab.workspace_id);
        if (ugId > 0) {
          twCheck.groupId = ugId;
          await db.put("tabWorkspaces", twCheck);
        }
      }
    }

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
      // Update windowId / chromeTabId only when safe — the windowChrome
      // index is unique and a different row may already hold this pair.
      const conflict = await db.getFromIndex("tabs", "windowChrome", [tab.window_id, tab.chrome_tab_id]);
      if (!conflict || conflict.id === t.id) {
        t.windowId = tab.window_id;
        t.chromeTabId = tab.chrome_tab_id;
      }
      t.title = tab.title;
      t.updatedAt = now();
      await db.put("tabs", t);
      // Honour explicit group_id; otherwise re-evaluate auto-group for
      // the (potentially new) URL — groups track URLs, not tabIds.
      const urlExplicitGroup = (tab.group_id ?? 0) > 0 ? tab.group_id! : 0;
      await linkWorkspace(t.id!, tab.workspace_id, active, urlExplicitGroup > 0 ? urlExplicitGroup : 0);

      if (urlExplicitGroup <= 0) {
        const { autoGroupTab } = await import("./autogroup-repo");
        await autoGroupTab(t.id!, tab.workspace_id, urlHash);

        const twCheck = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [t.id!, tab.workspace_id]);
        if (twCheck && twCheck.groupId === 0) {
          const ugId = await ungroupedGroupId(tab.workspace_id);
          if (ugId > 0) {
            twCheck.groupId = ugId;
            await db.put("tabWorkspaces", twCheck);
          }
        }
      }

      const tw2 = await db.getFromIndex("tabWorkspaces", "tabWorkspace", [t.id!, tab.workspace_id]);
      return toApi(t, tw2);
    }
  }

  // New tab — link with explicit group if provided, else auto-group.
  const explicitGroup = (tab.group_id ?? 0) > 0 ? tab.group_id! : 0;
  const id = await db.put("tabs", {
    windowId: tab.window_id, chromeTabId: tab.chrome_tab_id,
    title: tab.title, url: tab.url, urlHash,
    createdAt: now(), updatedAt: now(),
  });
  await linkWorkspace(id as number, tab.workspace_id, active, explicitGroup > 0 ? explicitGroup : 0);

  if (explicitGroup <= 0) {
    // Auto-group: checks tabs with group_id=0 and applies domain rules.
    const { autoGroupTab } = await import("./autogroup-repo");
    await autoGroupTab(id as number, tab.workspace_id, urlHash);
  }

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

/** Remove a tab from the specified workspace.  Returns true when a
 *  row or junction was actually deleted, false when the tab could not
 *  be found or no junction existed for the workspace. */
export async function removeTab(windowId: number, chromeTabId: number, currentWsId: number, tabDbId?: number): Promise<boolean> {
  const db = await getDb();
  let existing: TabRow | undefined;

  // Preferred: direct primary-key lookup (most reliable when the caller
  // knows the exact DB row to delete, e.g. group close-duplicates and
  // trash-button flows that pass tab.id as tabDbId).
  if (tabDbId != null && tabDbId > 0) {
    existing = await db.transaction("tabs").store.get(tabDbId);
    // Log coordinate drift for diagnostics — the caller passed a
    // window_id / chrome_tab_id that doesn't match the stored row.
    if (existing) {
      if (existing.windowId !== windowId || existing.chromeTabId !== chromeTabId) {
        console.debug(
          "[removeTab] PK lookup succeeded but coordinates differ:",
          { caller: [windowId, chromeTabId], stored: [existing.windowId, existing.chromeTabId], tabId: tabDbId },
        );
      }
      // Safety: if the stored row is a live browser tab (chromeTabId>0)
      // but the caller passed snapshot-style coordinates (0, 0), the
      // caller may have stale data.  Still honor the request since the
      // PK identifies the exact row, but warn prominently.
      if (existing.chromeTabId > 0 && windowId === 0 && chromeTabId === 0) {
        console.warn(
          "[removeTab] Deleting live browser tab via PK fallback — caller had snapshot coordinates (0,0).",
          { tabId: tabDbId, storedWindowId: existing.windowId, storedChromeTabId: existing.chromeTabId },
        );
      }
    }
  }

  // Fallback 1: windowChrome index lookup (matches live browser tabs by
  // their browser window/tab IDs).  Only relevant for callers that don't
  // pass tabDbId (e.g. legacy or background sync without the PK).
  if (!existing && (windowId > 0 || chromeTabId > 0)) {
    const row = await db.transaction("tabs").store.index("windowChrome").get([windowId, chromeTabId]);
    if (row) existing = row;
  }

  // Fallback 2: snapshot tabs store chrome_tab_id = -(tab_id).
  // Convert the negative chromeTabId back to the positive PK.
  if (!existing && windowId === 0 && chromeTabId < 0) {
    existing = await db.transaction("tabs").store.get(-chromeTabId);
  }

  if (!existing) {
    console.warn(
      "[removeTab] Unable to find tab row — all lookups failed.",
      { windowId, chromeTabId, currentWsId, tabDbId },
    );
    return false;
  }

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
  return true;
}

export async function findDuplicate(url: string): Promise<{
  duplicate: boolean; tab: { chrome_tab_id: number; window_id: number; title: string; } | null;
}> {
  const db = await getDb();
  const urlHash = hashUrl(url);
  const all = await db.getAll("tabs");

  // Load similarity rules for a more precise per-domain match.
  let simRules: SimilarityRule[] = [];
  try { simRules = await loadSimilarityRules(); } catch { /* use default */ }
  const ruleHash = simRules.length > 0 ? hashUrlWithRules(url, simRules) : urlHash;

  // Find by urlHash (aggressive) or rule-aware hash.
  // Live tabs (chromeTabId > 0) take priority; snapshots are never
  // returned as duplicates so we don't switch away from a real tab.
  for (const t of all) {
    if (t.chromeTabId > 0) {
      const matchesDefault = t.urlHash === urlHash;
      const matchesRule = simRules.length > 0 && t.urlHash === ruleHash;
      if (matchesDefault || matchesRule) {
        // Also check with rule-aware comparison of the stored tab's own URL
        if (simRules.length > 0) {
          const tRuleHash = hashUrlWithRules(t.url, simRules);
          if (tRuleHash !== ruleHash) continue;
        }
        return {
          duplicate: true,
          tab: { chrome_tab_id: t.chromeTabId, window_id: t.windowId, title: t.title },
        };
      }
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

/** Update an existing tab row's windowId / chromeTabId (e.g. after the
 *  user reopens a closed snapshot tab).  Only updates the live-tab
 *  coordinates and timestamp — title, url, and urlHash are preserved
 *  from the saved snapshot so that re-opening a closed tab never
 *  overwrites the original saved content. */
export async function updateTabWindow(id: number, windowId: number, chromeTabId: number, _title?: string, _url?: string): Promise<void> {
  const db = await getDb();
  const row = await db.get("tabs", id);
  if (!row) return;
  row.windowId = windowId;
  row.chromeTabId = chromeTabId;
  row.updatedAt = now();
  await db.put("tabs", row);
}

// ── Dashboard statistics (live browser state) ─────────────────────
// All stats are based on chrome.tabs.query() — the live Open Tabs — not
// IndexedDB, so counts only reflect what is currently open in the browser.

function isNavigableUrl(url: string | undefined): url is string {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function normalizeForDedup(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.replace(/^www\./i, "");
    if (u.pathname.endsWith("/") && u.pathname.length > 1) u.pathname = u.pathname.slice(0, -1);
    return u.toString().toLowerCase();
  } catch { return url; }
}

async function getNavigableTabs(): Promise<chrome.tabs.Tab[]> {
  const all = await chrome.tabs.query({});
  return all.filter((t) => isNavigableUrl(t.url));
}

/** Count currently-open browser tabs with navigable URLs. */
export async function countAllTabs(): Promise<number> {
  const tabs = await getNavigableTabs();
  return tabs.length;
}

/** Count duplicate tabs among live browser tabs (by normalized URL). */
export async function countDuplicateTabs(): Promise<number> {
  const tabs = await getNavigableTabs();
  const urlCount = new Map<string, number>();
  for (const t of tabs) {
    const key = normalizeForDedup(t.url!);
    urlCount.set(key, (urlCount.get(key) ?? 0) + 1);
  }
  let dupes = 0;
  for (const count of urlCount.values()) {
    if (count > 1) dupes += count - 1;
  }
  return dupes;
}

/** Count browser windows. */
export async function countActiveBrowserTabs(): Promise<number> {
  const wins = await chrome.windows.getAll();
  return wins.length;
}

/** Return the top N domains by tab count among open browser tabs. */
export async function topDomains(limit = 5): Promise<{ domain: string; count: number }[]> {
  const tabs = await getNavigableTabs();
  const domainCount = new Map<string, number>();
  for (const t of tabs) {
    try {
      const host = new URL(t.url!).hostname.replace(/^www\./i, "").toLowerCase();
      domainCount.set(host, (domainCount.get(host) ?? 0) + 1);
    } catch { /* skip invalid URLs */ }
  }
  return [...domainCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain, count]) => ({ domain, count }));
}

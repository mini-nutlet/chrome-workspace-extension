import { getDb, now, type AutoGroupRuleRow } from "./database";

export interface AutoGroupRule {
  id: number;
  domain_pattern: string;
  group_name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function toApi(row: AutoGroupRuleRow): AutoGroupRule {
  return {
    id: row.id!, domain_pattern: row.domainPattern,
    group_name: row.groupName, enabled: row.enabled !== 0,
    sort_order: row.sortOrder, created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

const DEFAULT_RULES = [
  ["github.com", "GitHub"],
  ["stackoverflow.com", "Stack Overflow"],
  ["google.com", "Google"],
  ["youtube.com", "YouTube"],
  ["docs.microsoft.com", "Microsoft Docs"],
  ["medium.com", "Medium"],
  ["npmjs.com", "npm"],
  ["docs.rs", "Rust Docs"],
];

export async function listRules(): Promise<AutoGroupRule[]> {
  const db = await getDb();
  const rows = await db.getAll("autoGroupRules");
  if (rows.length === 0) {
    // Seed defaults
    for (let i = 0; i < DEFAULT_RULES.length; i++) {
      const [pattern, name] = DEFAULT_RULES[i];
      await db.add("autoGroupRules", {
        domainPattern: pattern, groupName: name, enabled: 1, sortOrder: i + 1,
        createdAt: now(), updatedAt: now(),
      });
    }
    return listRules();
  }
  return rows.map(toApi).sort((a, b) => a.sort_order - b.sort_order);
}

export async function autoGroupTab(tabId: number, workspaceId: number, urlHash: string): Promise<void> {
  const rules = await listRules();
  const { setTabGroup } = await import("./tab-repo");
  const { listGroups, createTabGroup } = await import("./tabgroup-repo");

  // Fetch just the tab we need instead of all workspace tabs (perf).
  const db = await getDb();
  const allTw = await db.getAll("tabWorkspaces");
  const tw = allTw.find((r: any) => r.tabId === tabId && r.workspaceId === workspaceId);
  if (!tw || tw.groupId !== 0) return;
  const tab = await db.get("tabs", tabId);
  if (!tab) return;

  const urlLower = tab.url.toLowerCase();
  const hostname = (() => { try { return new URL(tab.url).hostname.toLowerCase(); } catch { return tab.url.toLowerCase(); } })();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    // Match the domain pattern lowercased against both the full URL and hostname.
    const pattern = rule.domain_pattern.toLowerCase();
    if (urlLower.includes(pattern) || hostname.includes(pattern)) {
      const groups = await listGroups(workspaceId);
      let group = groups.find(g => g.name.toLowerCase() === rule.group_name.toLowerCase());
      if (!group) {
        group = await createTabGroup(workspaceId, rule.group_name);
      }
      if (group && group.id > 0) {
        await setTabGroup(tabId, workspaceId, group.id);
      }
      break;
    }
  }
}

export async function runAutoGroup(): Promise<number> {
  const db = await getDb();
  const allTw = await db.getAll("tabWorkspaces");
  let count = 0;
  for (const tw of allTw) {
    if (tw.groupId !== 0) continue;
    const tab = await db.get("tabs", tw.tabId);
    if (!tab) continue;
    await autoGroupTab(tw.tabId, tw.workspaceId, tab.urlHash);
    count++;
  }
  return count;
}

/**
 * Re-apply auto-group rules to ALL tabs in a workspace.
 * Resets every tab to groupId=0, then runs domain matching
 * from scratch.  Empty groups are deleted afterwards.
 * Called when rules change, so the UI immediately reflects
 * the new grouping without waiting for a browser event.
 */
export async function reapplyAutoGroup(workspaceId: number): Promise<number> {
  const db = await getDb();
  // Reset all tabs in this workspace to ungrouped.
  const allTw = await db.getAll("tabWorkspaces");
  const tx = db.transaction("tabWorkspaces", "readwrite");
  for (const tw of allTw) {
    if (tw.workspaceId === workspaceId && tw.groupId !== 0) {
      tw.groupId = 0;
      await tx.store.put(tw);
    }
  }
  await tx.done;

  // Re-run auto-group on every tab in the workspace.
  let count = 0;
  const { listTabsByWorkspace } = await import("./tab-repo");
  const { listGroups, deleteTabGroup } = await import("./tabgroup-repo");
  const tabs = await listTabsByWorkspace(workspaceId);
  for (const tab of tabs) {
    await autoGroupTab(tab.id, workspaceId, tab.url_hash || "");
    count++;
  }

  // Clean up empty groups (except Ungrouped — it's recreated on-demand).
  const groups = await listGroups(workspaceId);
  for (const g of groups) {
    const tws = (await db.getAll("tabWorkspaces")).filter((r: any) => r.groupId === g.id && r.workspaceId === workspaceId);
    if (tws.length === 0 && g.name !== "Ungrouped") {
      try { await deleteTabGroup(g.id); } catch { /* ok */ }
    }
  }

  return count;
}

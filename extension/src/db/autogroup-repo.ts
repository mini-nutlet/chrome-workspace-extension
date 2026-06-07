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
  const { listTabsByWorkspace, setTabGroup } = await import("./tab-repo");
  const { listGroups, createTabGroup } = await import("./tabgroup-repo");
  const tabs = await listTabsByWorkspace(workspaceId);
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || tab.group_id !== 0) return;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (tab.url.toLowerCase().includes(rule.domain_pattern)) {
      const groups = await listGroups(workspaceId);
      let group = groups.find(g => g.name === rule.group_name);
      if (!group) {
        group = await createTabGroup(workspaceId, rule.group_name);
      }
      await setTabGroup(tabId, workspaceId, group.id);
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

import { getDb, type TabRow, type BookmarkRow } from "./database";
import { type TabWorkspaceRow } from "./database";

export interface SearchResult {
  kind: "tab" | "bookmark";
  id: number;
  title: string;
  url: string;
  workspace_id: number;
  group_id: number;
  active: boolean;
  rank: number;
}

export async function search(query: string, workspaceId = 0, limit = 30): Promise<SearchResult[]> {
  const db = await getDb();
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  // Search tabs
  const allTabs: TabRow[] = await db.getAll("tabs");
  const allTw: TabWorkspaceRow[] = await db.getAll("tabWorkspaces");

  const twMap = new Map<number, TabWorkspaceRow[]>();
  for (const tw of allTw) {
    if (!twMap.has(tw.tabId)) twMap.set(tw.tabId, []);
    twMap.get(tw.tabId)!.push(tw);
  }

  for (const tab of allTabs) {
    if (workspaceId > 0) {
      const tws = twMap.get(tab.id!) || [];
      if (!tws.some(tw => tw.workspaceId === workspaceId)) continue;
    }
    const titleMatch = tab.title.toLowerCase().includes(q);
    const urlMatch = tab.url.toLowerCase().includes(q);
    if (!titleMatch && !urlMatch) continue;

    const tws = twMap.get(tab.id!) || [];
    const tw = tws[0];
    const rank = (titleMatch ? 10 : 0) + (urlMatch ? 5 : 0) + (tw?.active ? 3 : 0);
    results.push({
      kind: "tab", id: tab.id!,
      title: tab.title, url: tab.url,
      workspace_id: tw?.workspaceId ?? 0,
      group_id: tw?.groupId ?? 0,
      active: (tw?.active ?? 0) !== 0,
      rank,
    });
  }

  // Search bookmarks
  const allBm: BookmarkRow[] = await db.getAll("bookmarks");
  for (const bm of allBm) {
    if (workspaceId > 0 && bm.workspaceId !== workspaceId) continue;
    const titleMatch = bm.title.toLowerCase().includes(q);
    const urlMatch = bm.url.toLowerCase().includes(q);
    if (!titleMatch && !urlMatch) continue;

    results.push({
      kind: "bookmark", id: bm.id!,
      title: bm.title, url: bm.url,
      workspace_id: bm.workspaceId,
      group_id: 0, active: false,
      rank: (titleMatch ? 8 : 0) + (urlMatch ? 4 : 0),
    });
  }

  return results.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

import Fuse from "fuse.js";
import type { FuseResultMatch } from "fuse.js";
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
  match_indices?: Array<{ start: number; end: number }>;
}

interface FuseCandidate {
  id: number;
  title: string;
  url: string;
}

function buildFuse(candidates: FuseCandidate[]): Fuse<FuseCandidate> {
  return new Fuse(candidates, {
    keys: [
      { name: "title", weight: 0.6 },
      { name: "url", weight: 0.4 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
    includeMatches: true,
    minMatchCharLength: 2,
  });
}

/**
 * Extract character-level match indices from Fuse matches for the title field.
 * Fuse returns indices relative to the matched key's value; we collect them
 * so the UI can highlight matching characters in the title.
 */
function extractMatchIndices(matches: readonly FuseResultMatch[] | undefined): Array<{ start: number; end: number }> | undefined {
  if (!matches || matches.length === 0) return undefined;
  const titleMatch = matches.find((m) => m.key === "title");
  if (!titleMatch || titleMatch.indices.length === 0) return undefined;
  return titleMatch.indices.map((tuple: readonly [number, number]) => ({ start: tuple[0], end: tuple[1] + 1 }));
}

export async function search(query: string, workspaceId = 0, limit = 30): Promise<SearchResult[]> {
  const db = await getDb();
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results: SearchResult[] = [];
  const seen = new Set<string>(); // dedup key: "kind:id"

  const addResult = (r: SearchResult): boolean => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    results.push(r);
    return true;
  };

  // ── Load data ────────────────────────────────────────────────────

  const allTabs: TabRow[] = await db.getAll("tabs");
  const allTw: TabWorkspaceRow[] = await db.getAll("tabWorkspaces");
  const allBm: BookmarkRow[] = await db.getAll("bookmarks");

  // Build workspace-junction lookup
  const twMap = new Map<number, TabWorkspaceRow[]>();
  for (const tw of allTw) {
    if (!twMap.has(tw.tabId)) twMap.set(tw.tabId, []);
    twMap.get(tw.tabId)!.push(tw);
  }

  // ── Fuse on tabs ─────────────────────────────────────────────────

  const tabCandidates: FuseCandidate[] = [];
  const tabMeta = new Map<number, { tws: TabWorkspaceRow[] }>();

  for (const tab of allTabs) {
    const tws = twMap.get(tab.id!) || [];
    if (workspaceId > 0 && !tws.some((tw) => tw.workspaceId === workspaceId)) continue;
    tabCandidates.push({ id: tab.id!, title: tab.title, url: tab.url });
    tabMeta.set(tab.id!, { tws });
  }

  if (tabCandidates.length > 0) {
    const fuse = buildFuse(tabCandidates);
    const fuseResults = fuse.search(query, { limit });

    for (const fr of fuseResults) {
      const meta = tabMeta.get(fr.item.id)!;
      const tw = meta.tws[0];
      // Fuse score 0 = perfect match, 1 = worst. Invert to our rank scale.
      const fuseScore = 1 - (fr.score ?? 0.5);
      const rank = Math.round(fuseScore * 10) + (tw?.active ? 3 : 0);
      addResult({
        kind: "tab",
        id: fr.item.id,
        title: fr.item.title,
        url: fr.item.url,
        workspace_id: tw?.workspaceId ?? 0,
        group_id: tw?.groupId ?? 0,
        active: (tw?.active ?? 0) !== 0,
        rank,
        match_indices: extractMatchIndices(fr.matches),
      });
    }
  }

  // ── Fallback: substring match on tabs (supplement if Fuse missed) ─

  if (results.length < limit) {
    for (const tab of allTabs) {
      if (results.length >= limit) break;
      const tws = twMap.get(tab.id!) || [];
      if (workspaceId > 0 && !tws.some((tw) => tw.workspaceId === workspaceId)) continue;

      const titleMatch = tab.title.toLowerCase().includes(q);
      const urlMatch = tab.url.toLowerCase().includes(q);
      if (!titleMatch && !urlMatch) continue;

      const tw = tws[0];
      const rank = (titleMatch ? 8 : 0) + (urlMatch ? 4 : 0) + (tw?.active ? 2 : 0);
      // Build simple match_indices for substring matches
      let indices: Array<{ start: number; end: number }> | undefined;
      if (titleMatch) {
        const idx = tab.title.toLowerCase().indexOf(q);
        if (idx >= 0) indices = [{ start: idx, end: idx + query.length }];
      }
      addResult({
        kind: "tab",
        id: tab.id!,
        title: tab.title,
        url: tab.url,
        workspace_id: tw?.workspaceId ?? 0,
        group_id: tw?.groupId ?? 0,
        active: (tw?.active ?? 0) !== 0,
        rank,
        match_indices: indices,
      });
    }
  }

  // ── Fuse on bookmarks ────────────────────────────────────────────

  const bmCandidates: FuseCandidate[] = [];
  const bmMeta = new Map<number, BookmarkRow>();

  for (const bm of allBm) {
    if (workspaceId > 0 && bm.workspaceId !== workspaceId) continue;
    bmCandidates.push({ id: bm.id!, title: bm.title, url: bm.url });
    bmMeta.set(bm.id!, bm);
  }

  if (bmCandidates.length > 0) {
    const fuse = buildFuse(bmCandidates);
    const fuseResults = fuse.search(query, { limit });

    for (const fr of fuseResults) {
      const fuseScore = 1 - (fr.score ?? 0.5);
      const rank = Math.round(fuseScore * 8);
      addResult({
        kind: "bookmark",
        id: fr.item.id,
        title: fr.item.title,
        url: fr.item.url,
        workspace_id: bmMeta.get(fr.item.id)!.workspaceId,
        group_id: 0,
        active: false,
        rank,
        match_indices: extractMatchIndices(fr.matches),
      });
    }
  }

  // ── Fallback: substring match on bookmarks ───────────────────────

  if (results.filter((r) => r.kind === "bookmark").length < 3) {
    for (const bm of allBm) {
      if (workspaceId > 0 && bm.workspaceId !== workspaceId) continue;
      const titleMatch = bm.title.toLowerCase().includes(q);
      const urlMatch = bm.url.toLowerCase().includes(q);
      if (!titleMatch && !urlMatch) continue;

      let indices: Array<{ start: number; end: number }> | undefined;
      if (titleMatch) {
        const idx = bm.title.toLowerCase().indexOf(q);
        if (idx >= 0) indices = [{ start: idx, end: idx + query.length }];
      }
      addResult({
        kind: "bookmark",
        id: bm.id!,
        title: bm.title,
        url: bm.url,
        workspace_id: bm.workspaceId,
        group_id: 0,
        active: false,
        rank: (titleMatch ? 6 : 0) + (urlMatch ? 3 : 0),
        match_indices: indices,
      });
    }
  }

  return results.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

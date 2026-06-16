import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import type { Workspace, Tab, TabGroupWithTabs, TabGroupTree, AutoGroupRule, SearchResult } from "./types";
import * as api from "./api";
import { CURRENT_WS_NAME } from "../db/workspace-repo";
import { domainToGroupName } from "../db/autogroup-repo";

export type Theme = "system" | "light" | "dark";

const EMPTY_TREE: TabGroupTree = { groups: [], ungrouped_tabs: [] };

interface AppState {
  workspaces: Workspace[];
  currentWsId: number;
  query: string;
  results: SearchResult[];
  searching: boolean;
  theme: Theme;
  tree: TabGroupTree;
  autoGroupRules: AutoGroupRule[];
  tabPickerOpen: boolean;
  hasSession: boolean;
}

interface AppActions {
  switchWorkspace: (id: number) => void;
  setQuery: (q: string) => void;
  changeTheme: (t: Theme) => void;
  refreshWorkspaces: () => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshRules: () => Promise<void>;
  navigate: (url: string, kind: string, existingTabId?: number) => void;
  createWorkspace: (name: string, icon?: string, parentId?: number, afterId?: number) => Promise<void>;
  deleteWorkspace: (id: number) => Promise<void>;
  createTabGroup: (name: string, color?: string) => Promise<void>;
  deleteTabGroup: (id: number) => Promise<void>;
  updateTabGroup: (id: number, updates: Record<string, unknown>) => Promise<void>;
  moveTabToGroup: (tabId: number, groupId: number) => Promise<void>;
  deleteTab: (windowId: number, chromeTabId: number) => Promise<void>;
  reorderGroups: (orderedIds: number[]) => Promise<void>;
  openAllTabs: () => Promise<void>;
  closeAllWorkspaceTabs: () => Promise<void>;
  closeAllDuplicateTabs: () => Promise<void>;
  saveSession: () => Promise<void>;
  restoreSession: () => Promise<void>;
  deleteSession: () => Promise<void>;
  reorderWorkspaces: (items: { id: number; parent_id: number; sort_order: number }[]) => Promise<void>;
  setTabPickerOpen: (open: boolean) => void;
  hasSession: boolean;
}

type AppContextType = AppState & AppActions;

const AppContext = createContext<AppContextType | null>(null);

export function useApp(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

function applyTheme(theme: Theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

// Normalise API responses so we never hand null to React components.
function ensureArray<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

function ensureTree(v: TabGroupTree | null | undefined): TabGroupTree {
  if (!v) return EMPTY_TREE;
  return {
    groups: ensureArray(v.groups).map((g) => ({ ...g, tabs: ensureArray(g.tabs) })),
    ungrouped_tabs: ensureArray(v.ungrouped_tabs),
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWsId, setCurrentWsId] = useState<number>(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [tree, setTree] = useState<TabGroupTree>(EMPTY_TREE);
  const [autoGroupRules, setAutoGroupRules] = useState<AutoGroupRule[]>([]);
  const [tabPickerOpen, setTabPickerOpen] = useState(false);
  const [hasSession, setHasSession] = useState(false);

  // Stable ref for workspaces so callbacks can check isCurrent without
  // adding the full workspaces array as a dependency.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  // Generation counter for live-tree builds — lets us discard stale
  // results when multiple builds are in flight (StrictMode double-fire,
  // tabs-changed racing with initial load, etc.).
  const liveTreeGen = useRef(0);

  // ── theme ──────────────────────────────────────────────────────────
  useEffect(() => {
    chrome.storage.local.get("theme", (r) => {
      const saved = (r.theme as Theme) || "system";
      setTheme(saved);
      applyTheme(saved);
    });
  }, []);

  const changeTheme = useCallback((t: Theme) => {
    setTheme(t);
    applyTheme(t);
    chrome.storage.local.set({ theme: t });
  }, []);

  // ── data loading ───────────────────────────────────────────────────
  const refreshWorkspaces = useCallback(async () => {
    try {
      const ws = await api.listWorkspaces();
      setWorkspaces(ensureArray(ws));
    } catch {
      setWorkspaces([]);
    }
  }, []);

  // ── live tree builder (Current workspace) ───────────────────────────
  // Builds a TabGroupTree directly from live browser tabs, bypassing
  // IndexedDB entirely.  This gives instant display on first load and
  // real-time updates on every tab event without a DB round-trip.
  //
  // Group IDs are hashed from the group name so they are deterministic
  // across rebuilds — prevents React key churn that causes visual flicker
  // when StrictMode double-invokes effects or tabs-changed fires rapidly.

  /** Simple string hash → negative ID for deterministic React keys. */
  function hashGroupId(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    }
    return -(Math.abs(h % 999_999) + 1);
  }

  const buildLiveTree = useCallback(async (): Promise<TabGroupTree> => {
    const allTabs = await chrome.tabs.query({});

    // Filter to navigable URLs only.
    const navigable = allTabs.filter(
      (t) => t.url && (t.url.startsWith("http://") || t.url.startsWith("https://")),
    );

    // Count URLs by aggressive-normalised key for open_count badge.
    const urlCount = new Map<string, number>();
    for (const t of navigable) {
      if (t.url) {
        const key = api.normalizeUrlAggressive(t.url);
        urlCount.set(key, (urlCount.get(key) ?? 0) + 1);
      }
    }

    // Deduplicate browser tabs by aggressive-normalised URL.
    // Keep one entry per unique URL, preferring the active tab.
    // open_count shows how many actual browser tabs share that URL.
    const deduped = new Map<string, chrome.tabs.Tab>();
    for (const t of navigable) {
      if (!t.url) continue;
      const key = api.normalizeUrlAggressive(t.url);
      const existing = deduped.get(key);
      if (!existing || (!existing.active && t.active)) {
        deduped.set(key, t);
      }
    }

    // Domain extraction helper.
    const domainFromUrl = (url: string): string => {
      try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return url.toLowerCase();
      }
    };

    // Load auto-group rules directly to avoid state dependency cascade.
    let rules: AutoGroupRule[] = [];
    try {
      rules = ensureArray(await api.listAutoGroupRules());
    } catch { /* use empty rules — all tabs go to Ungrouped */ }

    // Match a URL to a group name: user-defined rules first,
    // then domain-based grouping as fallback.
    const getGroupName = (url: string): string => {
      const domain = domainFromUrl(url);
      for (const rule of rules) {
        if (!rule.enabled) continue;
        if (domain.includes(rule.domain_pattern.toLowerCase())) {
          return rule.group_name;
        }
      }
      // Fallback: group by full hostname with abbreviated display name.
      return domainToGroupName(domain);
    };

    // Build tabs and group them.
    const groupMap = new Map<string, { name: string; tabs: Tab[] }>();
    const ungroupedTabs: Tab[] = [];

    for (const [normKey, t] of deduped) {
      const tab: Tab = {
        id: -(t.id ?? Date.now() + Math.random()),
        window_id: t.windowId,
        chrome_tab_id: t.id ?? 0,
        workspace_id: currentWsId,
        group_id: 0,
        title: t.title ?? t.url ?? "",
        url: t.url ?? "",
        url_hash: normKey,
        active: t.active,
        is_open: true,
        open_count: urlCount.get(normKey) ?? 1,
        snapshot: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const groupName = getGroupName(t.url ?? "");
      if (groupName) {
        if (!groupMap.has(groupName)) {
          groupMap.set(groupName, { name: groupName, tabs: [] });
        }
        groupMap.get(groupName)!.tabs.push(tab);
      } else {
        ungroupedTabs.push(tab);
      }
    }

    // Build TabGroupWithTabs from groupMap — sort by name for stable
    // ordering across rebuilds so React keys never change spuriously.
    const groups: TabGroupWithTabs[] = [];
    const sortedNames = [...groupMap.keys()].sort((a, b) => a.localeCompare(b));
    let sortOrder = 0;
    for (const name of sortedNames) {
      const entry = groupMap.get(name)!;
      groups.push({
        id: hashGroupId(name),
        workspace_id: currentWsId,
        name,
        color: "",
        collapsed: false,
        sort_order: sortOrder++,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tabs: entry.tabs,
      });
    }

    return { groups, ungrouped_tabs: ungroupedTabs };
  }, [currentWsId]);

  const refreshTree = useCallback(async () => {
    if (currentWsId <= 0) {
      setTree(EMPTY_TREE);
      return;
    }

    // Fast path for the auto-tracked workspace: build the tree directly from
    // live browser tabs instead of reading from IndexedDB.  This gives instant
    // display on first load and real-time updates without a DB round-trip.
    const ws = workspacesRef.current.find((w) => w.id === currentWsId);
    if (ws?.name === CURRENT_WS_NAME && ws.parent_id === 0) {
      const gen = ++liveTreeGen.current;
      try {
        const live = await buildLiveTree();
        // Only apply if no newer build has started (handles StrictMode
        // double-fire and rapid tabs-changed / initial-load races).
        if (liveTreeGen.current === gen) {
          setTree(live);
        }
      } catch {
        if (liveTreeGen.current === gen) {
          setTree(EMPTY_TREE);
        }
      }
      return;
    }

    // Existing DB path for non-Current workspaces.
    try {
      const t = await api.getTabGroupTree(currentWsId);
      const tree = ensureTree(t);

      // Cross-reference with browser's open and active tabs.
      // The backend status may be stale; the browser is the source of truth.
      //
      // Match ONLY by normalized URL — NOT by chrome_tab_id.
      // When a browser tab navigates to a different URL, the saved
      // workspace tab is no longer "open" and should appear greyed out.
      // chrome_tab_id matching would incorrectly keep it alive just
      // because the same browser tab instance still exists.
      //
      // is_open and active are cross-referenced against ALL open tabs across
      // ALL windows. Chrome reports one active tab per window; we show each
      // window's active tab with the ACTIVE badge.
      const allOpenTabs = await chrome.tabs.query({});

      const openChromeIds = new Set(
        allOpenTabs.map((tab) => tab.id).filter((id): id is number => id != null)
      );
      const activeChromeIds = new Set(
        allOpenTabs.filter((tab) => tab.active).map((tab) => tab.id).filter((id): id is number => id != null)
      );

      // Normalize URLs for cross-tab matching: strip www., hash, trailing slash.
      const normUrl = (u: string) => {
        try {
          const p = new URL(u);
          p.hash = "";
          p.hostname = p.hostname.replace(/^www\./, "");
          if (p.pathname.endsWith("/") && p.pathname.length > 1) {
            p.pathname = p.pathname.slice(0, -1);
          }
          return p.toString();
        } catch { return u; }
      };

      const openUrls = new Set(
        allOpenTabs.filter((tab) => tab.url).map((tab) => normUrl(tab.url!))
      );
      const activeUrls = new Set(
        allOpenTabs.filter((tab) => tab.active && tab.url).map((tab) => normUrl(tab.url!))
      );
      // Count normalised URLs across all open tabs (for dupe badge).
      // Use the same normUrl as openUrls/activeUrls so that stored-tab
      // URLs differing only in trailing slash / www / hash still match.
      const urlCount = new Map<string, number>();
      for (const t of allOpenTabs) {
        if (t.url) {
          const key = normUrl(t.url);
          urlCount.set(key, (urlCount.get(key) ?? 0) + 1);
        }
      }

      for (const group of tree.groups) {
        for (const tab of group.tabs) {
          const tabNorm = normUrl(tab.url);
          tab.is_open = openUrls.has(tabNorm);
          tab.active = activeUrls.has(tabNorm);
          tab.open_count = urlCount.get(tabNorm) ?? 0;
        }
      }
      for (const tab of tree.ungrouped_tabs) {
        const tabNorm = normUrl(tab.url);
        tab.is_open = openUrls.has(tabNorm);
        tab.active = activeUrls.has(tabNorm);
        tab.open_count = urlCount.get(tabNorm) ?? 0;
      }

      setTree(tree);
    } catch {
      setTree(EMPTY_TREE);
    }
  }, [currentWsId, buildLiveTree]);

  const refreshRules = useCallback(async () => {
    try {
      const rules = await api.listAutoGroupRules();
      setAutoGroupRules(ensureArray(rules));
    } catch {
      setAutoGroupRules([]);
    }
  }, []);

  // ── initial load ──────────────────────────────────────────────────
  useEffect(() => {
    refreshWorkspaces();
    refreshRules();
  }, []);

  // Once workspaces are loaded, restore the last selection or auto-select
  // the auto-tracked workspace so the UI immediately shows live browser tabs.
  useEffect(() => {
    if (workspaces.length === 0) return;
    if (currentWsId > 0) return; // already selected

    chrome.storage.local.get("currentWorkspaceId", (r) => {
      const stored = (r.currentWorkspaceId as number) || 0;
      if (stored > 0 && workspaces.some((w) => w.id === stored)) {
        setCurrentWsId(stored);
      } else {
        const cur = workspaces.find((w) => w.name === CURRENT_WS_NAME && w.parent_id === 0);
        if (cur) {
          setCurrentWsId(cur.id);
          chrome.storage.local.set({ currentWorkspaceId: cur.id });
        }
      }
    });
  }, [workspaces, currentWsId]);

  // ── data refresh (driven by currentWsId) ─────────────────────────
  // For the Current workspace the tree is built directly from live
  // browser tabs (inside refreshTree), so no retry logic is needed.
  useEffect(() => {
    if (currentWsId <= 0) return;
    refreshTree();
  }, [currentWsId, refreshTree]);

  // ── visibility refresh ────────────────────────────────────────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshTree();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshTree]);

  // ── periodic refresh ──────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshTree();
    }, 10000);
    return () => clearInterval(timer);
  }, [refreshTree]);

  // ── search helpers ──────────────────────────────────────────────────

  // Cross-reference search results with live browser state.
  const crossRefResults = async (items: SearchResult[]) => {
    const allOpenTabs = await chrome.tabs.query({});
    const openChromeIds = new Set(allOpenTabs.map(t => t.id).filter((id): id is number => id != null));
    const activeChromeIds = new Set(
      allOpenTabs.filter(t => t.active).map(t => t.id).filter((id): id is number => id != null)
    );
    const normUrl = (u: string) => {
      try {
        const p = new URL(u); p.hash = ""; p.hostname = p.hostname.replace(/^www\./, "");
        if (p.pathname.endsWith("/") && p.pathname.length > 1) p.pathname = p.pathname.slice(0, -1);
        return p.toString();
      } catch { return u; }
    };
    const openUrls = new Set(allOpenTabs.filter(t => t.url).map(t => normUrl(t.url!)));
    const activeUrls = new Set(allOpenTabs.filter(t => t.active && t.url).map(t => normUrl(t.url!)));
    const urlCount = new Map<string, number>();
    for (const t of allOpenTabs) {
      if (t.url) {
        urlCount.set(t.url, (urlCount.get(t.url) ?? 0) + 1);
      }
    }
    for (const item of items) {
      if (item.kind === "tab") {
        const n = normUrl(item.url);
        (item as any).is_open = openUrls.has(n);
        item.active = activeUrls.has(n);
        (item as any).open_count = urlCount.get(item.url) ?? 0;
      }
    }
    return items;
  };

  const refreshSearchResults = useCallback(async () => {
    if (!query.trim()) return;
    try {
      const r = ensureArray(await api.search(query, currentWsId));
      setResults(await crossRefResults(r));
    } catch { /* keep existing results */ }
  }, [query, currentWsId]);

  // ── search ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = ensureArray(await api.search(query, currentWsId));
        setResults(await crossRefResults(r));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query, currentWsId]);

  // ── live search update on tab events ───────────────────────────────
  useEffect(() => {
    const handler = (message: { type: string }) => {
      if (message.type === "tabs-changed") {
        refreshTree();
        // Refresh search results while user is viewing them.
        refreshSearchResults();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [refreshTree, refreshSearchResults]);

  // ── workspace actions ──────────────────────────────────────────────
  const switchWorkspace = useCallback((id: number) => {
    setCurrentWsId(id);
    chrome.storage.local.set({ currentWorkspaceId: id });
    setQuery("");
  }, []);

  const createWorkspace = useCallback(async (name: string, icon = "", parentId = 0, afterId = 0) => {
    // If no explicit afterId, insert after the currently selected workspace at the same level.
    const insertAfter = afterId > 0 ? afterId : (parentId === 0 && currentWsId > 0 ? currentWsId : 0);
    await api.createWorkspace(name, "", icon, parentId, insertAfter);
    await refreshWorkspaces();
  }, [currentWsId, refreshWorkspaces]);

  const deleteWorkspace = useCallback(async (id: number) => {
    await api.deleteWorkspace(id);
    if (currentWsId === id) switchWorkspace(0);
    await refreshWorkspaces();
  }, [currentWsId, switchWorkspace, refreshWorkspaces]);

  const reorderWorkspaces = useCallback(async (
    items: { id: number; parent_id: number; sort_order: number }[],
  ) => {
    await api.reorderWorkspaces(items);
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  // ── tab group actions ──────────────────────────────────────────────
  const createTabGroup = useCallback(async (name: string, color = "") => {
    if (currentWsId <= 0) return;
    await api.createTabGroup(currentWsId, name, color);
    await refreshTree();
  }, [currentWsId, refreshTree]);

  const deleteTabGroup = useCallback(async (id: number) => {
    await api.deleteTabGroup(id);
    await refreshTree();
  }, [refreshTree]);

  const updateTabGroup = useCallback(async (id: number, updates: Record<string, unknown>) => {
    await api.updateTabGroup(id, updates as Parameters<typeof api.updateTabGroup>[1]);
    await refreshTree();
  }, [refreshTree]);

  const moveTabToGroup = useCallback(async (tabId: number, groupId: number) => {
    await api.setTabGroup(tabId, groupId, currentWsId);
    await refreshTree();
  }, [currentWsId, refreshTree]);

  const deleteTab = useCallback(async (windowId: number, chromeTabId: number, tabDbId?: number) => {
    await api.removeTab(windowId, chromeTabId, currentWsId, tabDbId);
    await refreshTree();
  }, [currentWsId, refreshTree]);

  const reorderGroups = useCallback(async (orderedIds: number[]) => {
    if (currentWsId <= 0) return;
    await api.reorderTabGroups(currentWsId, orderedIds);
    await refreshTree();
  }, [currentWsId, refreshTree]);

  // ── session helpers ─────────────────────────────────────────────────
  const checkSession = useCallback(async (wsId: number) => {
    try {
      const session = await api.restoreSession(wsId);
      setHasSession(!!(session.tabs && session.tabs.length > 0));
    } catch {
      setHasSession(false);
    }
  }, []);

  // Re-check session existence when workspace changes.
  useEffect(() => {
    if (currentWsId > 0) {
      checkSession(currentWsId);
    } else {
      setHasSession(false);
    }
  }, [currentWsId, checkSession]);

  // ── workspace actions ───────────────────────────────────────────────

  const openAllTabs = useCallback(async () => {
    if (currentWsId <= 0) return;
    // Collect all unique URLs for the current workspace.
    const allUrls: string[] = [];
    for (const group of tree.groups) {
      for (const tab of group.tabs) {
        if (tab.url) allUrls.push(tab.url);
      }
    }
    for (const tab of tree.ungrouped_tabs) {
      if (tab.url) allUrls.push(tab.url);
    }
    if (allUrls.length === 0) return;

    const uniqueUrls = [...new Set(allUrls)];

    // Find which tabs are already open in the browser (outside the target window).
    const openTabs = await chrome.tabs.query({});

    // Helper to match a URL against a browser tab.
    // Use aggressive normalisation so query-param differences don't
    // prevent matching (consistent with DB dedup behaviour).
    const matchTab = (url: string, excludeWindowId?: number) =>
      openTabs.find(
        (t) =>
          t.url &&
          t.id != null &&
          api.normalizeUrlAggressive(t.url) === api.normalizeUrlAggressive(url) &&
          (excludeWindowId == null || t.windowId !== excludeWindowId),
      );

    // Always start with the first URL to ensure the new window is non-empty.
    const firstUrl = uniqueUrls[0]!;
    const win = await chrome.windows.create({ url: firstUrl, focused: true });
    if (!win?.id) return;
    const winId = win.id;

    // If the first URL was already open elsewhere, the new window now has a
    // duplicate tab. Note its ID so we can close it after moving the original.
    const newTabs = await chrome.tabs.query({ windowId: winId });
    const duplicateTabId = newTabs[0]?.id;

    // Move already-open tabs into the new window (one by one for reliability).
    for (let i = 0; i < uniqueUrls.length; i++) {
      const url = uniqueUrls[i]!;
      const existing = matchTab(url, winId);
      if (existing && existing.id != null) {
        try {
          await chrome.tabs.move(existing.id, { windowId: winId, index: -1 });
        } catch {
          // Tab may have closed between query and move — ignore.
        }
      } else if (i > 0) {
        // Not open yet and not the first URL (already opened) — create it.
        await chrome.tabs.create({ url, windowId: winId, active: false });
      }
    }

    // Close the duplicate tab created for the first URL (if the original was moved).
    if (duplicateTabId != null) {
      try { await chrome.tabs.remove(duplicateTabId); } catch { /* ok */ }
    }
  }, [currentWsId, tree]);

  const closeAllDuplicateTabs = useCallback(async () => {
    if (currentWsId <= 0) return;
    const currentWs = workspaces.find((w) => w.id === currentWsId);
    const isCurrent = currentWs?.name === CURRENT_WS_NAME && currentWs?.parent_id === 0;

    // Collect all tabs from the tree (both grouped and ungrouped).
    const allTabs: Tab[] = [];
    for (const group of tree.groups) {
      for (const tab of group.tabs) allTabs.push(tab);
    }
    for (const tab of tree.ungrouped_tabs) allTabs.push(tab);
    if (allTabs.length === 0) return;

    let didClose = false;

    if (isCurrent) {
      // Current workspace: close duplicate browser tabs per URL.
      // Use aggressive normalisation (strips query string) so that URLs
      // differing only in query params are treated as duplicates —
      // matching the DB's hashUrl behaviour.
      const allOpenTabs = await chrome.tabs.query({});
      const browserByUrl = new Map<string, chrome.tabs.Tab[]>();
      for (const t of allOpenTabs) {
        if (!t.url || t.id == null) continue;
        const norm = api.normalizeUrlAggressive(t.url);
        if (!browserByUrl.has(norm)) browserByUrl.set(norm, []);
        browserByUrl.get(norm)!.push(t);
      }
      const wsUrls = new Set(allTabs.map((t) => api.normalizeUrlAggressive(t.url)));
      for (const [normUrl, browserTabs] of browserByUrl) {
        if (!wsUrls.has(normUrl)) continue;
        if (browserTabs.length > 1) {
          const keep = browserTabs.find((t) => t.active) ?? browserTabs[0]!;
          for (const t of browserTabs) {
            if (t.id !== keep.id) {
              try { await chrome.tabs.remove(t.id!); didClose = true; } catch {}
            }
          }
        }
      }
    } else {
      // Other workspaces: deduplicate DB entries by aggressive URL.
      // Use aggressive normalisation (strips protocol + query) so that
      // http→https variants and minor query differences are caught.
      const sorted = [...allTabs].sort((a, b) => {
        const aLive = a.chrome_tab_id > 0 ? 1 : 0;
        const bLive = b.chrome_tab_id > 0 ? 1 : 0;
        return bLive - aLive;
      });
      const seen = new Set<string>();
      for (const tab of sorted) {
        const n = api.normalizeUrlAggressive(tab.url);
        if (seen.has(n)) {
          if (tab.chrome_tab_id > 0) {
            try { await chrome.tabs.remove(tab.chrome_tab_id); } catch {}
          }
          try { const removed = await api.removeTab(tab.window_id, tab.chrome_tab_id, currentWsId, tab.id); if (removed) didClose = true; } catch {}
        } else {
          seen.add(n);
        }
      }
    }

    if (didClose) {
      await new Promise((r) => setTimeout(r, 300));
      await refreshTree();
    }
  }, [currentWsId, workspaces, tree, refreshTree]);

  const closeAllWorkspaceTabs = useCallback(async () => {
    if (currentWsId <= 0) return;
    // Collect all tabs from the tree (both grouped and ungrouped).
    const allTabs: Tab[] = [];
    for (const group of tree.groups) {
      for (const tab of group.tabs) {
        allTabs.push(tab);
      }
    }
    for (const tab of tree.ungrouped_tabs) {
      allTabs.push(tab);
    }
    if (allTabs.length === 0) return;

    // Close each tab in the browser (by URL). The background worker's
    // onRemoved handler will mark tabs as inactive in the backend —
    // they stay in the workspace groups, just shown as closed.
    for (const tab of allTabs) {
      await api.closeBrowserTabByUrl(tab.url);
    }
    // Give the background worker a moment to process onRemoved events.
    await new Promise((r) => setTimeout(r, 300));
    await refreshTree();
  }, [currentWsId, tree, refreshTree]);

  const saveSession = useCallback(async () => {
    if (currentWsId <= 0) return;
    const allTabs: Tab[] = [];
    for (const group of tree.groups) {
      for (const tab of group.tabs) {
        allTabs.push(tab);
      }
    }
    for (const tab of tree.ungrouped_tabs) {
      allTabs.push(tab);
    }
    await api.saveSession(currentWsId, allTabs);
    setHasSession(true);
  }, [currentWsId, tree]);

  const restoreSession = useCallback(async () => {
    if (currentWsId <= 0) return;
    const session = await api.restoreSession(currentWsId);
    if (session.tabs && session.tabs.length > 0) {
      // Check for existing open tabs to avoid duplicates.
      // Use aggressive normalisation so that http→https and query-param
      // differences don't cause duplicate tabs to be opened.
      const openTabs = await chrome.tabs.query({});
      const normalizedOpen = new Set(
        openTabs.filter((t) => t.url).map((t) => api.normalizeUrlAggressive(t.url!)),
      );

      const tabsToOpen = session.tabs.filter(
        (t) => !normalizedOpen.has(api.normalizeUrlAggressive(t.url)),
      );
      if (tabsToOpen.length > 0) {
        for (let i = 0; i < tabsToOpen.length; i++) {
          const t = tabsToOpen[i]!;
          const created = await chrome.tabs.create({ url: t.url, active: i === 0 });
          // Re-associate the opened tab with the target workspace so the
          // restored tabs appear in the correct workspace, not just Current.
          if (created.id && currentWsId > 0) {
            try {
              await api.upsertTab({
                window_id: created.windowId,
                chrome_tab_id: created.id,
                workspace_id: currentWsId,
                title: created.title ?? t.title,
                url: created.url ?? t.url,
                active: i === 0,
                group_id: t.group_id,
                snapshot: true,
              });
            } catch { /* non-critical */ }
          }
        }
      } else {
        // All already open — switch to the first one.
        const first = session.tabs[0];
        if (first) {
          const match = openTabs.find(
            (t) => t.url && api.normalizeUrlAggressive(t.url) === api.normalizeUrlAggressive(first.url),
          );
          if (match && match.id != null && match.windowId != null) {
            await chrome.windows.update(match.windowId, { focused: true });
            await chrome.tabs.update(match.id, { active: true });
          }
        }
      }
    }
  }, [currentWsId]);

  const deleteSession = useCallback(async () => {
    if (currentWsId <= 0) return;
    await api.deleteSession(currentWsId);
    setHasSession(false);
  }, [currentWsId]);
  const navigate = useCallback(async (url: string, kind: string, existingTabId?: number) => {
    // Helper: optimistically mark the given URL as active and open in the tree.
    // Uses aggressive normalisation for consistency with DB dedup and dupe detection.
    const markActive = (targetUrl: string) => {
      const targetNorm = api.normalizeUrlAggressive(targetUrl);
      setTree((prev) => ({
        groups: prev.groups.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) => ({
            ...t,
            is_open: t.is_open || api.normalizeUrlAggressive(t.url) === targetNorm,
            active: api.normalizeUrlAggressive(t.url) === targetNorm,
          })),
        })),
        ungrouped_tabs: prev.ungrouped_tabs.map((t) => ({
          ...t,
          is_open: t.is_open || api.normalizeUrlAggressive(t.url) === targetNorm,
          active: api.normalizeUrlAggressive(t.url) === targetNorm,
        })),
      }));
    };

    if (kind === "tab") {
      try {
        const tabs = await chrome.tabs.query({});
        const normalized = api.normalizeUrlAggressive(url);
        let match = tabs.find((t) => t.url === url);
        if (!match) match = tabs.find((t) => t.url && api.normalizeUrlAggressive(t.url) === normalized);
        if (match && match.id != null && match.windowId != null) {
          await chrome.windows.update(match.windowId, { focused: true });
          await chrome.tabs.update(match.id, { active: true });
          markActive(url);
          // Sync active status to backend immediately so refreshTree
          // doesn't fetch stale data before the background worker fires.
          try { await api.syncActiveByUrl(url); } catch { /* non-critical */ }
          // For Current, skip DB refresh — markActive already updated
          // the live tree; tabs-changed will fire from syncActiveByUrl.
          const cw = workspacesRef.current.find((w) => w.id === currentWsId);
          if (!cw || cw.name !== CURRENT_WS_NAME || cw.parent_id !== 0) {
            await refreshTree();
          }
          return;
        }
      } catch {
        // Fall through
      }
    }
    // Create new tab and sync to current workspace.
    const tab = await chrome.tabs.create({ url });
    markActive(url);
    if (tab.id && currentWsId > 0) {
      try {
        if (existingTabId) {
          // Update the existing DB row directly — avoids URL-dedup issues
          // (e.g. http→https redirect producing a different hash).
          await api.updateTabWindow(existingTabId, tab.windowId, tab.id, tab.title ?? "", tab.url ?? url);
        } else {
          await api.upsertTab({
            window_id: tab.windowId,
            chrome_tab_id: tab.id,
            workspace_id: currentWsId,
            title: tab.title ?? "",
            url: tab.url ?? url,
            active: true,
          });
        }
      } catch { /* non-critical */ }
    }
    // Delay to let Chrome settle, then refresh to confirm state.
    // For Current, skip DB refresh — the live tree rebuilds when
    // tabs-changed fires from the background worker.
    await new Promise((r) => setTimeout(r, 200));
    const cw2 = workspacesRef.current.find((w) => w.id === currentWsId);
    if (!cw2 || cw2.name !== CURRENT_WS_NAME || cw2.parent_id !== 0) {
      await refreshTree();
    }
  }, [currentWsId, refreshTree]);

  const value: AppContextType = {
    workspaces, currentWsId, query, results, searching, theme, tree, autoGroupRules, tabPickerOpen, hasSession,
    switchWorkspace, setQuery, changeTheme,
    refreshWorkspaces, refreshTree, refreshRules,
    navigate, createWorkspace, deleteWorkspace,
    createTabGroup, deleteTabGroup, updateTabGroup,
    moveTabToGroup, deleteTab, reorderGroups,
    openAllTabs, saveSession, restoreSession, deleteSession,
    closeAllWorkspaceTabs, closeAllDuplicateTabs,
    reorderWorkspaces, setTabPickerOpen,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

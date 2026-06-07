import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Workspace, Tab, TabGroupTree, AutoGroupRule, SearchResult } from "./types";
import * as api from "./api";

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
  navigate: (url: string, kind: string) => void;
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

  const refreshTree = useCallback(async () => {
    if (currentWsId <= 0) {
      setTree(EMPTY_TREE);
      return;
    }
    try {
      const t = await api.getTabGroupTree(currentWsId);
      const tree = ensureTree(t);

      // Cross-reference with browser's open and active tabs.
      // The backend status may be stale; the browser is the source of truth.
      // Match by chrome_tab_id (same tab instance) AND by normalized URL
      // (same page opened in a different tab — manual, redirect, auto-open).
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
      // Count exactly matching URLs across all open tabs (for dupe badge).
      const urlCount = new Map<string, number>();
      for (const t of allOpenTabs) {
        if (t.url) {
          urlCount.set(t.url, (urlCount.get(t.url) ?? 0) + 1);
        }
      }

      for (const group of tree.groups) {
        for (const tab of group.tabs) {
          const tabNorm = normUrl(tab.url);
          tab.is_open = openChromeIds.has(tab.chrome_tab_id) || openUrls.has(tabNorm);
          tab.active = activeChromeIds.has(tab.chrome_tab_id) || activeUrls.has(tabNorm);
          tab.open_count = urlCount.get(tab.url) ?? 0;
        }
      }
      for (const tab of tree.ungrouped_tabs) {
        const tabNorm = normUrl(tab.url);
        tab.is_open = openChromeIds.has(tab.chrome_tab_id) || openUrls.has(tabNorm);
        tab.active = activeChromeIds.has(tab.chrome_tab_id) || activeUrls.has(tabNorm);
        tab.open_count = urlCount.get(tab.url) ?? 0;
      }

      setTree(tree);
    } catch {
      setTree(EMPTY_TREE);
    }
  }, [currentWsId]);

  const refreshRules = useCallback(async () => {
    try {
      const rules = await api.listAutoGroupRules();
      setAutoGroupRules(ensureArray(rules));
    } catch {
      setAutoGroupRules([]);
    }
  }, []);

  useEffect(() => {
    refreshWorkspaces();
    refreshRules();
    chrome.storage.local.get("currentWorkspaceId", (r) => {
      setCurrentWsId((r.currentWorkspaceId as number) || 0);
    });
  }, []);

  useEffect(() => {
    refreshTree();
  }, [currentWsId, refreshTree]);

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
        (item as any).is_open = openChromeIds.has((item as any).chrome_tab_id) || openUrls.has(n);
        item.active = activeChromeIds.has((item as any).chrome_tab_id) || activeUrls.has(n);
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

  const deleteTab = useCallback(async (windowId: number, chromeTabId: number) => {
    await api.removeTab(windowId, chromeTabId, currentWsId);
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
    const matchTab = (url: string, excludeWindowId?: number) =>
      openTabs.find(
        (t) =>
          t.url &&
          t.id != null &&
          api.normalizeUrl(t.url) === api.normalizeUrl(url) &&
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
    const allTabs: Tab[] = [];
    for (const group of tree.groups) {
      for (const tab of group.tabs) allTabs.push(tab);
    }
    for (const tab of tree.ungrouped_tabs) allTabs.push(tab);
    if (allTabs.length === 0) return;

    // Keep first tab per normalized URL, close the rest.
    const seen = new Set<string>();
    const dupes: Tab[] = [];
    for (const tab of allTabs) {
      const n = api.normalizeUrl(tab.url);
      if (seen.has(n)) dupes.push(tab);
      else seen.add(n);
    }
    for (const tab of dupes) {
      if (tab.chrome_tab_id > 0) {
        try { await chrome.tabs.remove(tab.chrome_tab_id); } catch {}
      }
      try { await api.removeTab(tab.window_id, tab.chrome_tab_id, currentWsId); } catch {}
    }
    await new Promise((r) => setTimeout(r, 300));
    await refreshTree();
  }, [currentWsId, tree, refreshTree]);

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
      const openTabs = await chrome.tabs.query({});
      const openUrls = new Set(openTabs.filter((t) => t.url).map((t) => t.url!));

      const tabsToOpen = session.tabs.filter((t) => !openUrls.has(t.url));
      if (tabsToOpen.length > 0) {
        for (let i = 0; i < tabsToOpen.length; i++) {
          await chrome.tabs.create({ url: tabsToOpen[i]!.url, active: i === 0 });
        }
      } else {
        // All already open — switch to the first one.
        const first = session.tabs[0];
        if (first) {
          const match = openTabs.find((t) => t.url === first.url);
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
  const navigate = useCallback(async (url: string, kind: string) => {
    // Helper: optimistically mark the given URL as active and open in the tree.
    const markActive = (targetUrl: string) => {
      const targetNorm = api.normalizeUrl(targetUrl);
      setTree((prev) => ({
        groups: prev.groups.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) => ({
            ...t,
            is_open: t.is_open || api.normalizeUrl(t.url) === targetNorm,
            active: api.normalizeUrl(t.url) === targetNorm,
          })),
        })),
        ungrouped_tabs: prev.ungrouped_tabs.map((t) => ({
          ...t,
          is_open: t.is_open || api.normalizeUrl(t.url) === targetNorm,
          active: api.normalizeUrl(t.url) === targetNorm,
        })),
      }));
    };

    if (kind === "tab") {
      try {
        const tabs = await chrome.tabs.query({});
        const normalized = api.normalizeUrl(url);
        let match = tabs.find((t) => t.url === url);
        if (!match) match = tabs.find((t) => t.url && api.normalizeUrl(t.url) === normalized);
        if (match && match.id != null && match.windowId != null) {
          await chrome.windows.update(match.windowId, { focused: true });
          await chrome.tabs.update(match.id, { active: true });
          markActive(url);
          // Sync active status to backend immediately so refreshTree
          // doesn't fetch stale data before the background worker fires.
          try { await api.syncActiveByUrl(url); } catch { /* non-critical */ }
          await refreshTree();
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
        await api.upsertTab({
          window_id: tab.windowId,
          chrome_tab_id: tab.id,
          workspace_id: currentWsId,
          title: tab.title ?? "",
          url: tab.url ?? url,
          active: true,
        });
      } catch { /* non-critical */ }
    }
    // Delay to let Chrome settle, then refresh to confirm state.
    await new Promise((r) => setTimeout(r, 200));
    await refreshTree();
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

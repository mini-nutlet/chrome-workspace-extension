// Background service worker — Tab Monitor + Duplicate Detection + Auto-group
// Pure frontend version: uses IndexedDB instead of a Go backend.

import * as api from "../lib/api";
import { syncActiveToAllWorkspaces } from "../db/tab-repo";
import { CURRENT_WS_NAME, migrateCurrentWsName } from "../db/workspace-repo";
import { loadSimilarityRules, findRule, hashUrl, type SimilarityRule } from "../db/database";
import { saveSession } from "../db/session-repo";

const NEWTAB_URL = "chrome://newtab/";

// ── Helpers ────────────────────────────────────────────────────────

function notifyTabsChanged(): void {
  chrome.runtime.sendMessage({ type: "tabs-changed" }).catch(() => {});
}

function isNavigable(url: string | undefined): url is string {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function isNewTab(url: string | undefined): boolean {
  if (!url) return true;
  return url === NEWTAB_URL || url === "";
}

// ── Workspace ──────────────────────────────────────────────────────

let currentWsPromise: Promise<number> | null = null;

async function ensureCurrentWorkspace(): Promise<number> {
  if (currentWsPromise) return currentWsPromise;
  currentWsPromise = (async () => {
    const list = await api.listWorkspaces();
    const cur = list.find((w) => w.name === CURRENT_WS_NAME);
    if (cur) return cur.id;
    const created = await api.createWorkspace(CURRENT_WS_NAME, "Auto-tracked tabs", "");
    // Deduplicate: keep only one auto-tracked workspace.
    const all = await api.listWorkspaces();
    const dupes = all.filter((w) => w.name === CURRENT_WS_NAME);
    for (let i = 1; i < dupes.length; i++) {
      try { await api.deleteWorkspace(dupes[i].id); } catch {}
    }
    return dupes[0]?.id ?? created.id;
  })().catch((e) => {
    // Reset on failure so the next call retries instead of returning
    // a permanently-rejected promise.
    console.warn("[workspace-bg] ensureCurrentWorkspace failed, will retry:", e);
    currentWsPromise = null;
    throw e;
  });
  return currentWsPromise;
}

// ── Sync ───────────────────────────────────────────────────────────

async function syncTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!isNavigable(tab.url)) return;
  const curId = await ensureCurrentWorkspace();
  await api.upsertTab({
    window_id: tab.windowId,
    chrome_tab_id: tab.id,
    workspace_id: curId,
    title: tab.title ?? "",
    url: tab.url!,
    active: tab.active || false,
  });
  // Sync active status to all workspaces
  await syncActiveToAllWorkspaces(tab.windowId, tab.id!, tab.active || false);
}

async function removeTab(windowId: number, tabId: number): Promise<void> {
  const curId = await ensureCurrentWorkspace();
  await api.removeTab(windowId, tabId, curId);
}

// ── Duplicate Detection ────────────────────────────────────────────

async function handleDuplicateAndSwitch(tab: chrome.tabs.Tab): Promise<boolean> {
  // Respect the duplicate-detection toggle set via keyboard shortcut.
  const stored = await chrome.storage.local.get("duplicateDetectionEnabled");
  if (stored.duplicateDetectionEnabled === false) return false;

  if (!isNavigable(tab.url) || tab.id == null) return false;

  const data = await api.findDuplicate(tab.url!);
  if (!data || !data.duplicate || !data.tab) return false;
  if (data.tab.chrome_tab_id === tab.id && data.tab.window_id === tab.windowId) return false;

  try { await chrome.tabs.get(data.tab.chrome_tab_id); } catch { return false; }

  // ── Unified Single-Instance rules ────────────────────────────────
  // Load similarity rules and check if any enabled rule matches this URL.
  // If the matching rule has auto_switch enabled, silently switch to the
  // existing tab.  Otherwise the duplicate tab is allowed to exist.
  let simRules: SimilarityRule[] = [];
  try { simRules = await loadSimilarityRules(); } catch { /* use default */ }
  const matchedRule = findRule(tab.url!, simRules);
  if (matchedRule && matchedRule.auto_switch) {
    // Try to close the new tab.  If the page requires a confirmation
    // (e.g. beforeunload handler, form data) or the tab is otherwise
    // unclosable, allow the duplicate tab to exist.
    let closed = false;
    try {
      await chrome.tabs.remove(tab.id);
      closed = true;
    } catch {
      // Tab may have a beforeunload handler, already be closed, or
      // the extension lacks permission — don't pretend we succeeded.
    }
    if (closed) {
      chrome.windows.update(data.tab.window_id, { focused: true }).catch(() => {});
      chrome.tabs.update(data.tab.chrome_tab_id, { active: true }).catch(() => {});
      return true; // switched — caller skips syncTab
    }
    // Close failed — allow the duplicate tab to exist.
  }

  return false;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "reapply-auto-group") {
    (async () => {
      const curId = await ensureCurrentWorkspace();
      if (curId > 0) {
        await api.reapplyAutoGroup(curId);
        notifyTabsChanged();
      }
    })().catch(() => {});
  }
});

// ── Single new-tab enforcement (Opt 5) ─────────────────────────────

async function enforceSingleNewTab(newTabId: number | undefined): Promise<void> {
  if (newTabId == null) return;
  try {
    const allNewTabs = await chrome.tabs.query({ url: NEWTAB_URL });
    if (allNewTabs.length <= 1) return;
    const sorted = allNewTabs.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    const [keep, ...rest] = sorted;
    if (!keep) return;
    for (const t of rest) {
      try { if (t.id != null) await chrome.tabs.remove(t.id); } catch {}
    }
    if (keep.windowId != null && keep.id != null) {
      await chrome.windows.update(keep.windowId, { focused: true });
      await chrome.tabs.update(keep.id, { active: true });
    }
  } catch {}
}

// ── Event Listeners ────────────────────────────────────────────────

/** Wrapper: sync a tab + notify the UI.  Silently catches individual
 *  tab errors so one broken tab doesn't block the rest of the pipeline. */
async function safeSyncAndNotify(tab: chrome.tabs.Tab): Promise<void> {
  try { await syncTab(tab); } catch (e) { console.warn("[workspace-bg] syncTab failed:", e); }
  try { notifyTabsChanged(); } catch {}
}

chrome.tabs.onCreated.addListener((tab) => {
  if (isNewTab(tab.pendingUrl) || isNewTab(tab.url)) {
    enforceSingleNewTab(tab.id);
    return;
  }
  if (isNavigable(tab.url)) {
    handleDuplicateAndSwitch(tab).then((switched) => {
      if (!switched) safeSyncAndNotify(tab);
    }).catch(() => {}); // prevent unhandled-rejection
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.url && isNewTab(changeInfo.url)) {
      enforceSingleNewTab(tabId);
      return;
    }
    if (changeInfo.url && isNavigable(changeInfo.url)) {
      const tabWithUrl = { ...tab, url: changeInfo.url };
      const switched = await handleDuplicateAndSwitch(tabWithUrl);
      if (switched) return;
      await safeSyncAndNotify(tabWithUrl);
    }
    if ((changeInfo.title || tab?.status === "complete") && isNavigable(tab?.url)) {
      await safeSyncAndNotify(tab!);
    }
  } catch (e) { console.warn("[workspace-bg] onUpdated error:", e); }
});

chrome.tabs.onRemoved.addListener(async (tabId, { windowId }) => {
  try {
    await removeTab(windowId, tabId);
    notifyTabsChanged();
  } catch (e) { console.warn("[workspace-bg] onRemoved error:", e); }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await syncTab(tab);
    if (isNavigable(tab.url)) await api.syncActiveByUrl(tab.url!);
    notifyTabsChanged();
  } catch {}
});

chrome.tabs.onAttached.addListener(async (tabId) => {
  try { const tab = await chrome.tabs.get(tabId); await safeSyncAndNotify(tab); } catch {}
});

chrome.tabs.onDetached.addListener(() => { notifyTabsChanged(); });
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  notifyTabsChanged();
});

// ── Side Panel ─────────────────────────────────────────────────────
// Explicitly disable side-panel-on-action-click.  Chrome persists the
// previous setPanelBehavior(true) setting across extension updates, so
// without this explicit false the toolbar icon keeps opening the side
// panel instead of the popup declared in manifest.json.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// ── Keyboard Commands ───────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === "quick-search") {
    // Focus the search bar in the side panel or newtab page.
    chrome.runtime.sendMessage({ type: "focus-search" }).catch(() => {});
  }
  if (command === "save-session") {
    (async () => {
      try {
        // Read the active workspace ID from storage (set by the UI).
        const stored = await chrome.storage.local.get("currentWorkspaceId");
        let wsId: number = (stored.currentWorkspaceId as number) ?? 0;
        if (wsId <= 0) wsId = await ensureCurrentWorkspace();
        if (wsId <= 0) return;

        // Build the tab list: for the Open Tabs workspace we snapshot
        // live browser tabs; for other workspaces we read from IndexedDB.
        let tabs: Array<{
          id: number; window_id: number; chrome_tab_id: number;
          workspace_id: number; group_id: number; title: string;
          url: string; url_hash: string; active: boolean;
          created_at: string; updated_at: string;
        }> = [];

        const allWs = await api.listWorkspaces();
        const currentWs = allWs.find((w) => w.id === wsId);
        const isCurrent = currentWs?.name === CURRENT_WS_NAME;

        if (isCurrent) {
          const browserTabs = await chrome.tabs.query({});
          for (const t of browserTabs) {
            if (!t.url || (!t.url.startsWith("http://") && !t.url.startsWith("https://"))) continue;
            tabs.push({
              id: -(t.id ?? Date.now()),
              window_id: t.windowId,
              chrome_tab_id: t.id ?? 0,
              workspace_id: wsId,
              group_id: 0,
              title: t.title ?? "",
              url: t.url,
              url_hash: hashUrl(t.url),
              active: t.active || false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
        } else {
          const dbTabs = await api.listTabs(wsId);
          tabs = dbTabs.map((t) => ({
            id: t.id,
            window_id: t.window_id,
            chrome_tab_id: t.chrome_tab_id,
            workspace_id: wsId,
            group_id: t.group_id,
            title: t.title,
            url: t.url,
            url_hash: t.url_hash,
            active: t.active,
            created_at: t.created_at,
            updated_at: t.updated_at,
          }));
        }

        await saveSession(wsId, tabs);
        await chrome.notifications.create(`session-saved-${Date.now()}`, {
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "Session Saved",
          message: `${tabs.length} tabs saved to workspace session.`,
        });
      } catch (err) {
        console.warn("[workspace-bg] save-session failed:", err);
      }
    })().catch(() => {});
  }
  if (command === "open-popup") {
    // chrome.action.openPopup() requires a user gesture — a keyboard
    // shortcut satisfies this requirement.
    chrome.action.openPopup().catch(() => {});
  }
});

// ── Periodic full sync + stale cleanup ─────────────────────────────
// The event-based sync (onCreated/onUpdated/onRemoved) covers normal
// operation, but a periodic sweep catches tabs that changed while the
// service worker was asleep and cleans up DB entries whose browser
// tabs have been closed by external means.

let periodicSyncRunning = false;

async function periodicFullSync(): Promise<void> {
  if (periodicSyncRunning) return;
  periodicSyncRunning = true;
  try {
    const curId = await ensureCurrentWorkspace();
    const browserTabs = await chrome.tabs.query({});
    let synced = 0;

    // ── Sync all open browser tabs into Current workspace ────────────
    for (const tab of browserTabs) {
      if (!isNavigable(tab.url)) continue;
      try {
        await api.upsertTab({
          window_id: tab.windowId, chrome_tab_id: tab.id,
          workspace_id: curId, title: tab.title ?? "",
          url: tab.url!, active: tab.active,
        });
        synced++;
      } catch { /* skip individual errors */ }
    }

    // ── Clean up stale DB entries ───────────────────────────────────
    // Tabs whose chrome_tab_id no longer exists in any browser window
    // are marked inactive.  We keep the row (other workspaces may
    // still reference it), but the Current workspace shows them closed.
    const liveIds = new Set(
      browserTabs.map((t) => t.id).filter((id): id is number => id != null)
    );
    const allDbTabs = await api.listTabs(curId);
    let cleaned = 0;
    for (const dbTab of allDbTabs) {
      if (dbTab.chrome_tab_id > 0 && !liveIds.has(dbTab.chrome_tab_id)) {
        try {
          await api.removeTab(dbTab.window_id, dbTab.chrome_tab_id, curId, dbTab.id);
          cleaned++;
        } catch { /* skip */ }
      }
    }

    // Re-apply auto-group rules so that rule changes are reflected
    // within one sync cycle even if the settings page didn't notify us.
    try { await api.reapplyAutoGroup(curId); } catch { /* best-effort */ }

    if (synced > 0 || cleaned > 0) {
      console.log(`[workspace-bg] Periodic sync: ${synced} synced, ${cleaned} cleaned`);
      notifyTabsChanged();
    }
  } catch { /* non-critical — event sync is the primary path */ }
  finally { periodicSyncRunning = false; }
}

chrome.alarms.create("full-sync", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "full-sync") periodicFullSync();
});

// ── Storage listener ───────────────────────────────────────────────

// Invalidate the similarity-rules cache when the settings page updates it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.similarityRules) {
    import("../db/database").then(({ invalidateSimRulesCache }) => invalidateSimRulesCache());
  }
});

// ── Startup ────────────────────────────────────────────────────────

async function onStartupOrInstall() {
  try {
    const curId = await ensureCurrentWorkspace();
    if (curId > 0) {
      const stored = await new Promise<number>((resolve) => {
        chrome.storage.local.get("currentWorkspaceId", (r) => resolve((r.currentWorkspaceId as number) || 0));
      });
      if (stored <= 0) chrome.storage.local.set({ currentWorkspaceId: curId });
      // Full sync captures all open tabs AND cleans up stale entries
      // left over from a previous session.
      await periodicFullSync();
    }
  } catch (e) { console.warn("[workspace-bg] startup error:", e); }
}

// Rename legacy "Current" workspace to "Open Tabs" before any other logic runs.
migrateCurrentWsName().catch(() => {});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  onStartupOrInstall();
});
chrome.runtime.onStartup.addListener(() => onStartupOrInstall());
onStartupOrInstall();

console.log("[workspace-bg] standalone service worker started");

// Background service worker — Tab Monitor + Duplicate Detection + Auto-group
// Pure frontend version: uses IndexedDB instead of a Go backend.

import * as api from "../lib/api";
import { syncActiveToAllWorkspaces } from "../db/tab-repo";

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
    const cur = list.find((w) => w.name === "Current");
    if (cur) return cur.id;
    const created = await api.createWorkspace("Current", "Auto-tracked tabs", "");
    // If somehow multiple "Current" workspaces were already created, keep only the first.
    const all = await api.listWorkspaces();
    const dupes = all.filter((w) => w.name === "Current");
    for (let i = 1; i < dupes.length; i++) {
      try { await api.deleteWorkspace(dupes[i].id); } catch {}
    }
    return dupes[0]?.id ?? created.id;
  })();
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

interface PendingDupe {
  newTabId: number;
  newWindowId: number;
  existingTabId: number;
  existingWindowId: number;
}
const pendingDupes = new Map<string, PendingDupe>();

async function handleDuplicateAndSwitch(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!isNavigable(tab.url) || tab.id == null) return false;

  const data = await api.findDuplicate(tab.url!);
  if (!data || !data.duplicate || !data.tab) return false;
  if (data.tab.chrome_tab_id === tab.id && data.tab.window_id === tab.windowId) return false;

  try { await chrome.tabs.get(data.tab.chrome_tab_id); } catch { return false; }

  const notifId = `dup-${tab.id}-${Date.now()}`;
  pendingDupes.set(notifId, {
    newTabId: tab.id, newWindowId: tab.windowId ?? 0,
    existingTabId: data.tab.chrome_tab_id, existingWindowId: data.tab.window_id,
  });

  try {
    await chrome.notifications.create(notifId, {
      type: "basic", iconUrl: "icons/icon128.png",
      title: "Duplicate Page",
      message: `"${data.tab.title || tab.url}" is already open.\nSwitch to the existing tab?`,
      buttons: [{ title: "Switch to existing" }, { title: "Keep both" }],
      priority: 2,
    });
  } catch { pendingDupes.delete(notifId); }
  return false;
}

function resolveDupe(notifId: string, switchToExisting: boolean) {
  const info = pendingDupes.get(notifId);
  if (!info) return;
  pendingDupes.delete(notifId);
  if (switchToExisting) {
    chrome.tabs.remove(info.newTabId).catch(() => {});
    chrome.windows.update(info.existingWindowId, { focused: true }).catch(() => {});
    chrome.tabs.update(info.existingTabId, { active: true }).catch(() => {});
  }
}

// ── Notification handlers ──────────────────────────────────────────

chrome.notifications?.onButtonClicked?.addListener?.((notifId, btnIdx) => {
  if (!notifId.startsWith("dup-")) return;
  resolveDupe(notifId, btnIdx === 0);
});

chrome.notifications?.onClicked?.addListener?.((notifId) => {
  if (!notifId.startsWith("dup-")) return;
  resolveDupe(notifId, true);
});

chrome.notifications?.onClosed?.addListener?.((notifId) => {
  if (!notifId.startsWith("dup-")) return;
  pendingDupes.delete(notifId);
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

chrome.tabs.onCreated.addListener((tab) => {
  if (isNewTab(tab.pendingUrl) || isNewTab(tab.url)) {
    enforceSingleNewTab(tab.id);
    return;
  }
  if (isNavigable(tab.url)) {
    handleDuplicateAndSwitch(tab).then((switched) => {
      if (!switched) { syncTab(tab); notifyTabsChanged(); }
    });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && isNewTab(changeInfo.url)) {
    enforceSingleNewTab(tabId);
    return;
  }
  if (changeInfo.url && isNavigable(changeInfo.url)) {
    const switched = await handleDuplicateAndSwitch(tab);
    if (switched) return;
    if (isNewTab(tab.url) || tab.url === "" || tab.url === NEWTAB_URL) {
      try { await chrome.tabs.remove(tabId!); } catch {}
      await chrome.tabs.create({ url: changeInfo.url });
      return;
    }
    if (tab) { await syncTab({ ...tab, url: changeInfo.url }); notifyTabsChanged(); }
  }
  if ((changeInfo.title || tab?.status === "complete") && isNavigable(tab?.url)) {
    await syncTab(tab!); notifyTabsChanged();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, { windowId }) => {
  await removeTab(windowId, tabId);
  notifyTabsChanged();
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
  try { const tab = await chrome.tabs.get(tabId); await syncTab(tab); notifyTabsChanged(); } catch {}
});

chrome.tabs.onDetached.addListener(() => { notifyTabsChanged(); });
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  notifyTabsChanged();
});

// ── Side Panel ─────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Keep-alive ─────────────────────────────────────────────────────

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });

// ── Startup ────────────────────────────────────────────────────────

let startupSyncRunning = false;

async function syncAllOpenTabs(workspaceId: number): Promise<void> {
  if (startupSyncRunning) return;
  startupSyncRunning = true;
  try {
    const tabs = await chrome.tabs.query({});
    let count = 0;
    for (const tab of tabs) {
      if (!isNavigable(tab.url)) continue;
      try {
        await api.upsertTab({
          window_id: tab.windowId, chrome_tab_id: tab.id,
          workspace_id: workspaceId, title: tab.title ?? "",
          url: tab.url!, active: tab.active,
        });
        count++;
      } catch { /* skip individual tab errors */ }
    }
    console.log(`[workspace-bg] Synced ${count} tabs to Current workspace`);
    notifyTabsChanged();
  } finally {
    startupSyncRunning = false;
  }
}

async function onStartupOrInstall() {
  try {
    const curId = await ensureCurrentWorkspace();
    if (curId > 0) {
      const stored = await new Promise<number>((resolve) => {
        chrome.storage.local.get("currentWorkspaceId", (r) => resolve((r.currentWorkspaceId as number) || 0));
      });
      if (stored <= 0) chrome.storage.local.set({ currentWorkspaceId: curId });
      await syncAllOpenTabs(curId);
    }
  } catch (e) { console.warn("[workspace-bg] startup error:", e); }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  onStartupOrInstall();
});
chrome.runtime.onStartup.addListener(() => onStartupOrInstall());
onStartupOrInstall();

console.log("[workspace-bg] standalone service worker started");

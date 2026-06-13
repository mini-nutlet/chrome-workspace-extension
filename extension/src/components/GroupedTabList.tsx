import { useState, useCallback } from "react";
import { useApp } from "../lib/context";
import * as api from "../lib/api";
import { DraggableTab } from "./DraggableTab";
import { DroppableGroup } from "./DroppableGroup";
import { IconPlus, IconGroup } from "./Icons";
import { closeBrowserTabByUrl, removeTab } from "../lib/api";

/** Extract domain from URL for group-naming purposes. */
function domainFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function GroupedTabList({ isCurrent }: { isCurrent?: boolean }) {
  const {
    tree, navigate, deleteTab,
    deleteTabGroup, updateTabGroup, moveTabToGroup, createTabGroup,
    setTabPickerOpen, refreshTree, autoGroupRules, currentWsId,
  } = useApp();
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);

  const allGroups = tree?.groups ?? [];
  const rawUngrouped = tree?.ungrouped_tabs ?? [];
  const wsId = currentWsId;

  // In the Current workspace the "Ungrouped" group is a proper group
  // (groupId > 0).  Pull it out of the grid so it renders as the
  // subtle divider + compact list below.
  const ungroupedGroup = isCurrent
    ? allGroups.find((g) => g.name === "Ungrouped")
    : null;
  const groups = isCurrent
    ? allGroups.filter((g) => g.name !== "Ungrouped")
    : allGroups;
  const ungroupedTabs = ungroupedGroup
    ? ungroupedGroup.tabs
    : rawUngrouped;

  // ── Auto-create group from domain rules ──────────────────────────────
  const getGroupNameForUrl = useCallback((url: string): string => {
    const domain = domainFromUrl(url);
    // Check auto-group rules first.
    for (const rule of autoGroupRules) {
      if (!rule.enabled) continue;
      if (domain.includes(rule.domain_pattern)) {
        return rule.group_name;
      }
    }
    // Fallback: use domain as group name.
    return domain;
  }, [autoGroupRules]);

  // Add a tab to a specific group via local API.
  const addTabToGroup = useCallback(async (
    data: { url: string; title: string; windowId: number; chromeTabId: number; active?: boolean },
    gid: number,
  ) => {
    await api.upsertTab({
      window_id: data.windowId,
      chrome_tab_id: data.chromeTabId,
      workspace_id: wsId,
      title: data.title,
      url: data.url,
      active: !!data.active,
      group_id: gid,
      snapshot: true,
    });
  }, [wsId]);

  // Handle external tab drop from TabPicker — with auto-group creation.
  const handleDropExternal = useCallback(async (
    data: { url: string; title: string; windowId: number; chromeTabId: number; active?: boolean },
    groupId: number,
  ) => {
    try {
      await addTabToGroup(data, groupId);
      await refreshTree();
    } catch { /* ignore */ }
  }, [addTabToGroup, refreshTree]);

  // Handle drop on empty area — auto-create group based on domain rules.
  // Reuses an existing group when a case-insensitive name match exists.
  const handleDropAutoGroup = useCallback(async (
    data: { url: string; title: string; windowId: number; chromeTabId: number; active?: boolean },
  ) => {
    const groupName = getGroupNameForUrl(data.url);
    // Look for an existing group with a case-insensitive name match.
    const allGroups = await api.listTabGroups(wsId);
    const match = allGroups.find((g) => g.name.toLowerCase() === groupName.toLowerCase());
    const group = match ?? await api.createTabGroup(wsId, groupName);
    await addTabToGroup(data, group.id);
    await refreshTree();
  }, [getGroupNameForUrl, wsId, addTabToGroup, refreshTree]);

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    await createTabGroup(newGroupName.trim());
    setNewGroupName("");
    setShowNewGroup(false);
  };

  // Close all tabs in a group (Opt 33).
  // Uses URL matching to find and close browser tabs (handles stale chrome_tab_id).
  // For the Current workspace, also removes tabs from the DB so the empty group
  // auto-deletes after the tree refreshes.
  const handleCloseAll = async (
    tabs: { id: number; window_id: number; chrome_tab_id: number; url: string }[],
  ) => {
    for (const tab of tabs) {
      await closeBrowserTabByUrl(tab.url);
      if (isCurrent) {
        try { await removeTab(tab.window_id, tab.chrome_tab_id, currentWsId, tab.id); } catch { /* ignore return — caller already refreshes */ }
      }
    }
    await refreshTree();
  };

  // Close all duplicate tabs in a group, keeping only one per URL.
  // Works for both Current and non-Current workspaces:
  //   1. Close duplicate browser tabs (keep one per URL).
  //   2. Non-Current also deduplicates DB snapshot entries.
  const handleCloseDuplicates = async (
    tabs: { id: number; window_id: number; chrome_tab_id: number; url: string }[],
  ) => {
    let closedCount = 0;
    const tag = "[handleCloseDuplicates]";

    try {
      // ── Step 1: close duplicate browser tabs (all workspaces) ──────
      const allOpenTabs = await chrome.tabs.query({});
      console.log(`${tag} queried ${allOpenTabs.length} open browser tabs (isCurrent=${isCurrent})`);

      const browserByUrl = new Map<string, chrome.tabs.Tab[]>();
      for (const t of allOpenTabs) {
        if (!t.url || t.id == null) continue;
        const norm = api.normalizeUrlAggressive(t.url);
        if (!browserByUrl.has(norm)) browserByUrl.set(norm, []);
        browserByUrl.get(norm)!.push(t);
      }
      const groupUrls = new Set(tabs.map((t) => api.normalizeUrlAggressive(t.url)));
      console.log(`${tag} group has ${groupUrls.size} unique URLs, browser has ${browserByUrl.size} buckets`);

      for (const [normUrl, browserTabs] of browserByUrl) {
        if (!groupUrls.has(normUrl)) continue;
        if (browserTabs.length > 1) {
          const keep = browserTabs.find((t) => t.active) ?? browserTabs[0]!;
          console.log(`${tag} URL "${normUrl}" has ${browserTabs.length} browser tabs, keeping tab#${keep.id}${keep.active ? " (active)" : ""}`);
          for (const t of browserTabs) {
            if (t.id !== keep.id) {
              try { await chrome.tabs.remove(t.id!); closedCount++; console.log(`${tag} closed browser tab#${t.id}`); } catch (e) { console.warn(`${tag} failed to close tab#${t.id}`, e); }
            }
          }
        }
      }

      // ── Step 2: non-Current — also deduplicate DB entries ─────────
      if (!isCurrent) {
        const sorted = [...tabs].sort((a, b) => {
          const aLive = a.chrome_tab_id > 0 ? 1 : 0;
          const bLive = b.chrome_tab_id > 0 ? 1 : 0;
          return bLive - aLive;
        });
        console.log(`${tag} Non-Current: sorted ${sorted.length} tabs (live first)`, sorted.map((t) => ({ id: t.id, ctid: t.chrome_tab_id, live: t.chrome_tab_id > 0 })));

        const seen = new Set<string>();
        for (const tab of sorted) {
          const normalized = api.normalizeUrlAggressive(tab.url);
          if (seen.has(normalized)) {
            console.log(`${tag} Non-Current: DUPLICATE tab id=${tab.id} url="${normalized}"`, { window_id: tab.window_id, chrome_tab_id: tab.chrome_tab_id });
            if (tab.chrome_tab_id > 0) {
              try { await chrome.tabs.remove(tab.chrome_tab_id); console.log(`${tag} Non-Current: closed browser tab#${tab.chrome_tab_id}`); } catch (e) { console.warn(`${tag} Non-Current: failed to close browser tab#${tab.chrome_tab_id}`, e); }
            }
            try {
              const removed = await removeTab(tab.window_id, tab.chrome_tab_id, currentWsId, tab.id);
              if (removed) {
                closedCount++;
                console.log(`${tag} Non-Current: removeTab succeeded for id=${tab.id}`);
              } else {
                console.warn(`${tag} Non-Current: removeTab returned false for id=${tab.id} — tab or junction not found`);
              }
            } catch (e) {
              console.error(`${tag} Non-Current: removeTab threw for id=${tab.id}`, e);
            }
          } else {
            seen.add(normalized);
          }
        }
      }

      if (closedCount > 0) {
        await refreshTree();
        try {
          chrome.notifications.create(`dedup-group-${Date.now()}`, {
            type: "basic",
            iconUrl: "icons/icon48.png",
            title: "Duplicates closed",
            message: `Closed ${closedCount} duplicate tab${closedCount > 1 ? "s" : ""} in this group.`,
          });
        } catch { /* notifications may not be available */ }
      } else {
        try {
          chrome.notifications.create(`dedup-group-${Date.now()}`, {
            type: "basic",
            iconUrl: "icons/icon48.png",
            title: "No duplicates",
            message: "No duplicate tabs found in this group.",
          });
        } catch { /* notifications may not be available */ }
      }
    } catch (err) {
      console.error("[handleCloseDuplicates] Error:", err);
      try {
        chrome.notifications.create(`dedup-err-${Date.now()}`, {
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "Error closing duplicates",
          message: String(err).slice(0, 180),
        });
      } catch { /* notifications may not be available */ }
    }
  };

  // Shared drop handler for external tabs (no-group zone + ungrouped zone).
  const onExternalDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("text/tab-picker");
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      handleDropAutoGroup(data);
    } catch { /* ignore */ }
  };

  return (
    <div>
      {/* Section header */}
      <div className="section-header">
        <h2 className="section-title">Tabs</h2>
        <span className="section-count">{groups.length} groups</span>
        <div style={{ flex: 1 }} />
        {!isCurrent && (
          <>
            <button className="icon-btn" title="Add tabs to workspace" onClick={() => setTabPickerOpen(true)}>
              <IconPlus size={15} />
            </button>
            <button className="icon-btn" title="New group" onClick={() => setShowNewGroup(!showNewGroup)}>
              <IconGroup size={15} />
            </button>
          </>
        )}
      </div>

      {/* Inline new group input — hidden for Current */}
      {!isCurrent && showNewGroup && (
        <div className="new-group-inline">
          <input
            placeholder="Group name"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateGroup();
              if (e.key === "Escape") setShowNewGroup(false);
            }}
            autoFocus
          />
          <button className="btn btn-accent btn-sm" onClick={handleCreateGroup}>Create</button>
          <button className="btn btn-sm" onClick={() => setShowNewGroup(false)}>Cancel</button>
        </div>
      )}

      {/* Group grid — only when there are regular groups */}
      {groups.length > 0 && (
        <div className="group-grid">
          {groups.map((group) => (
            <DroppableGroup
              key={group.id}
              group={group}
              onNavigate={navigate}
              onCloseTab={deleteTab}
              onDeleteGroup={deleteTabGroup}
              onUpdateGroup={updateTabGroup}
              onDropTab={moveTabToGroup}
              onDropExternal={handleDropExternal}
              onCloseAll={handleCloseAll}
              onCloseDuplicates={handleCloseDuplicates}
              isCurrent={isCurrent}
            />
          ))}
        </div>
      )}

      {/* No groups and no ungrouped tabs → empty state */}
      {groups.length === 0 && ungroupedTabs.length === 0 && (
        isCurrent ? (
          <div className="empty-state" style={{ padding: "32px 16px" }}>
            <div className="empty-state-text">No tabs yet</div>
            <div className="empty-state-hint">Tabs will auto-appear here as you browse</div>
          </div>
        ) : (
          <div
            className="group-drop-zone"
            style={{ minHeight: 80 }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onExternalDrop}
          >
            <IconGroup size={18} />
            <span>No groups — drag tabs here to auto-create</span>
          </div>
        )
      )}

      {/* Ungrouped tabs — always shown when present, even without groups. */}
      {ungroupedTabs.length > 0 && (
        <>
          <div className="ungrouped-divider">
            <span className="ungrouped-divider-label">Ungrouped · {ungroupedTabs.length}</span>
          </div>
          <div className="ungrouped-tabs">
            {ungroupedTabs.map((tab) => (
              <DraggableTab
                key={tab.id}
                tab={tab}
                onNavigate={navigate}
                onClose={deleteTab}
                isCurrent={isCurrent}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

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

  const groups = tree?.groups ?? [];
  const ungroupedTabs = tree?.ungrouped_tabs ?? [];
  const wsId = currentWsId;

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
  const handleDropAutoGroup = useCallback(async (
    data: { url: string; title: string; windowId: number; chromeTabId: number; active?: boolean },
  ) => {
    const groupName = getGroupNameForUrl(data.url);
    // Create the group.
    await createTabGroup(groupName);
    // Wait a tick for tree to refresh, then find the new group.
    setTimeout(async () => {
      try {
        const allGroups = await api.listTabGroups(wsId);
        const match = allGroups.find((g) => g.name === groupName);
        if (match) {
          await addTabToGroup(data, match.id);
          await refreshTree();
        }
      } catch { /* ignore */ }
    }, 200);
  }, [getGroupNameForUrl, createTabGroup, wsId, addTabToGroup, refreshTree]);

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
    tabs: { window_id: number; chrome_tab_id: number; url: string }[],
  ) => {
    for (const tab of tabs) {
      await closeBrowserTabByUrl(tab.url);
      if (isCurrent) {
        try { await removeTab(tab.window_id, tab.chrome_tab_id, currentWsId); } catch { /* ignore */ }
      }
    }
    await refreshTree();
  };

  // Close all duplicate tabs in a group, keeping only one per URL.
  const handleCloseDuplicates = async (
    tabs: { window_id: number; chrome_tab_id: number; url: string }[],
  ) => {
    const seen = new Set<string>();
    const dupes: typeof tabs = [];
    for (const tab of tabs) {
      const normalized = api.normalizeUrl(tab.url);
      if (seen.has(normalized)) {
        dupes.push(tab);
      } else {
        seen.add(normalized);
      }
    }
    for (const tab of dupes) {
      // Close the specific duplicate browser tab by chrome_tab_id.
      if (tab.chrome_tab_id > 0) {
        try { await chrome.tabs.remove(tab.chrome_tab_id); } catch {}
      }
      if (isCurrent) {
        try { await removeTab(tab.window_id, tab.chrome_tab_id, currentWsId); } catch {}
      }
    }
    await refreshTree();
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

      {/* No groups empty state */}
      {groups.length === 0 ? (
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
      ) : (
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

      {/* Ungrouped tabs — tabs with no group assignment (group_id=0).
          These appear when the Ungrouped group is missing; they are a safety net. */}
      {ungroupedTabs.length > 0 && (
        <div className="ungrouped-section" style={{ marginTop: 12 }}>
          <div className="section-header" style={{ marginBottom: 8 }}>
            <h3 className="section-title" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Ungrouped</h3>
            <span className="section-count">{ungroupedTabs.length}</span>
          </div>
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
      )}
    </div>
  );
}

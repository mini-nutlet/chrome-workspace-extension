import { useState, useEffect, useMemo } from "react";
import { useApp } from "../lib/context";
import * as api from "../lib/api";
import { IconX, IconPlus, IconGrip } from "./Icons";

interface BrowserTab {
  id?: number;
  windowId?: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active?: boolean;
}

interface TabPickerProps {
  open: boolean;
  onClose: () => void;
}

export function TabPicker({ open, onClose }: TabPickerProps) {
  const { currentWsId, tree, refreshTree } = useApp();
  const [allTabs, setAllTabs] = useState<BrowserTab[]>([]);
  const [adding, setAdding] = useState<Set<string>>(new Set());

  const refreshTabList = () => {
    chrome.tabs.query({}).then((tabs) => {
      setAllTabs(
        tabs
          .filter((t) => t.url && (t.url.startsWith("http://") || t.url.startsWith("https://")))
          .map((t) => ({
            id: t.id,
            windowId: t.windowId,
            title: t.title || t.url || "",
            url: t.url!,
            favIconUrl: t.favIconUrl,
            active: t.active,
          }))
      );
    });
  };

  useEffect(() => {
    if (!open) return;
    refreshTabList();
    // Auto-refresh the tab list every 2 seconds while open, plus on
    // background-worker notifications.
    const interval = setInterval(refreshTabList, 2000);
    const onMessage = (msg: { type: string }) => {
      if (msg.type === "tabs-changed") refreshTabList();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      clearInterval(interval);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [open]);

  // Compute which URLs are already in the current workspace tree.
  const workspaceUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const g of tree.groups) {
      for (const t of g.tabs) urls.add(t.url);
    }
    for (const t of tree.ungrouped_tabs) urls.add(t.url);
    return urls;
  }, [tree]);

  // Jump to an already-open browser tab: focus its window and activate it.
  // Does NOT close the panel so the user can preview multiple tabs.
  const jumpToTab = async (tab: BrowserTab) => {
    if (tab.id == null || tab.windowId == null) return;
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } catch { /* tab may no longer exist */ }
  };

  const addTabToWorkspace = async (tab: BrowserTab) => {
    if (!tab.url || !tab.id) return;
    // Skip if already in workspace — avoids stuck "…" from duplicate detection.
    if (workspaceUrls.has(tab.url)) {
      await refreshTree();
      return;
    }
    setAdding((prev) => new Set(prev).add(tab.url));
    try {
      await api.upsertTab({
        window_id: tab.windowId ?? 0,
        chrome_tab_id: tab.id,
        workspace_id: currentWsId,
        title: tab.title,
        url: tab.url,
        active: !!tab.active,
        group_id: 0,
        snapshot: true,
      });
      await refreshTree();
    } catch { /* ignore */ }
    finally {
      setAdding((prev) => {
        const next = new Set(prev);
        next.delete(tab.url);
        return next;
      });
    }
  };

  // Drag start: pack tab info into dataTransfer for drop targets.
  const handleDragStart = (e: React.DragEvent, tab: BrowserTab) => {
    e.dataTransfer.setData(
      "text/tab-picker",
      JSON.stringify({
        url: tab.url,
        title: tab.title,
        windowId: tab.windowId ?? 0,
        chromeTabId: tab.id ?? 0,
        active: !!tab.active,
      })
    );
    e.dataTransfer.effectAllowed = "copy";
  };

  if (!open) return null;

  const newTabs = allTabs.filter((t) => !workspaceUrls.has(t.url));
  const alreadyIn = allTabs.filter((t) => workspaceUrls.has(t.url));

  return (
    <div className="tab-picker-panel">
      <div className="tab-picker-header">
        <span className="tab-picker-title">Add Tabs</span>
        <button className="icon-btn" onClick={onClose}>
          <IconX size={16} />
        </button>
      </div>

      <div className="tab-picker-body">
        {newTabs.length === 0 && alreadyIn.length === 0 && (
          <div className="empty-state" style={{ padding: "24px 16px" }}>
            <div className="empty-state-text">No open tabs found</div>
          </div>
        )}

        {newTabs.length > 0 && (
          <div className="tab-picker-section">
            <div className="tab-picker-section-title">
              Available ({newTabs.length})
            </div>
            {newTabs.map((tab) => (
              <div
                key={tab.url}
                className="tab-picker-row"
                style={{ cursor: "pointer" }}
                title="Click to preview this tab in the browser"
                draggable
                onDragStart={(e) => handleDragStart(e, tab)}
                onClick={() => jumpToTab(tab)}
              >
                <span className="tab-picker-grip"><IconGrip size={12} /></span>
                <img
                  className="tab-favicon"
                  src={tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=16`}
                  alt=""
                  width={16}
                  height={16}
                />
                <div className="tab-info">
                  <div className="tab-title">{tab.title}</div>
                  <div className="tab-url">{tab.url}</div>
                </div>
                <button
                  className="btn btn-accent btn-sm"
                  disabled={adding.has(tab.url)}
                  onClick={(e) => { e.stopPropagation(); addTabToWorkspace(tab); }}
                >
                  <IconPlus size={12} />
                  {adding.has(tab.url) ? "…" : ""}
                </button>
              </div>
            ))}
          </div>
        )}

        {alreadyIn.length > 0 && (
          <div className="tab-picker-section">
            <div className="tab-picker-section-title" style={{ color: "var(--text-tertiary)" }}>
              Added ({alreadyIn.length})
            </div>
            {alreadyIn.slice(0, 5).map((tab) => (
              <div
                key={tab.url}
                className="tab-picker-row dimmed"
                style={{ cursor: "pointer" }}
                title="Click to jump to this tab"
                onClick={() => jumpToTab(tab)}
              >
                <img
                  className="tab-favicon"
                  src={tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=16`}
                  alt=""
                  width={16}
                  height={16}
                />
                <div className="tab-info">
                  <div className="tab-title">{tab.title}</div>
                </div>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>✓</span>
              </div>
            ))}
            {alreadyIn.length > 5 && (
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "center", padding: "4px" }}>
                …{alreadyIn.length - 5} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

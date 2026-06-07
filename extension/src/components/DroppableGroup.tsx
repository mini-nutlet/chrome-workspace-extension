import { useState, useEffect } from "react";
import type { TabGroupWithTabs } from "../lib/types";
import { DraggableTab, getGroupColor } from "./DraggableTab";
import { IconChevronRight, IconX, IconTrash, IconEdit } from "./Icons";

interface DroppableGroupProps {
  group: TabGroupWithTabs;
  onNavigate: (url: string, kind: string) => void;
  onCloseTab: (windowId: number, chromeTabId: number) => void;
  onDeleteGroup: (id: number) => void;
  onUpdateGroup: (id: number, updates: Record<string, unknown>) => void;
  onDropTab: (tabId: number, groupId: number) => void;
  onDropExternal?: (data: { url: string; title: string; windowId: number; chromeTabId: number }, groupId: number) => void;
  onCloseAll?: (tabs: { window_id: number; chrome_tab_id: number; url: string }[]) => void;
  onCloseDuplicates?: (tabs: { window_id: number; chrome_tab_id: number; url: string }[]) => void;
  isCurrent?: boolean;
}

export function DroppableGroup({
  group,
  onNavigate,
  onCloseTab,
  onDeleteGroup,
  onUpdateGroup,
  onDropTab,
  onDropExternal,
  onCloseAll,
  onCloseDuplicates,
  isCurrent,
}: DroppableGroupProps) {
  // Current workspace groups always start expanded.
  const [collapsed, setCollapsed] = useState(isCurrent ? false : group.collapsed);
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState(group.name);

  const handleToggle = () => {
    setCollapsed(!collapsed);
    onUpdateGroup(group.id, { collapsed: !collapsed });
  };

  const handleRenameStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameName(group.name);
    setRenaming(true);
  };

  const handleRenameSubmit = () => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== group.name) {
      onUpdateGroup(group.id, { name: trimmed });
    }
    setRenaming(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDeleteGroup(group.id);
  };

  // Auto-delete empty groups in the Current workspace.
  // When the last tab is removed from a group (either individually or via
  // close-all), the group card re-renders with 0 tabs and we clean it up.
  // The "Ungrouped" group is protected — it's the default bucket for new tabs.
  useEffect(() => {
    if (isCurrent && group.tabs.length === 0 && group.id > 0 && group.name !== 'Ungrouped') {
      onDeleteGroup(group.id);
    }
  }, [isCurrent, group.tabs.length, group.id, group.name, onDeleteGroup]);

  const hasBody = !collapsed && group.tabs.length > 0;

  return (
    <div
      className={`group-card${dragOver ? " drag-over" : ""}`}
      data-group-color={group.color || "gray"}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const tabId = e.dataTransfer.getData("text/tab-id");
        if (tabId) {
          onDropTab(Number(tabId), group.id);
          return;
        }
        const raw = e.dataTransfer.getData("text/tab-picker");
        if (raw && onDropExternal) {
          try {
            const data = JSON.parse(raw);
            onDropExternal(data, group.id);
          } catch { /* ignore */ }
        }
      }}
    >
      <div
        className={`group-header${hasBody ? " has-body" : ""}`}
        onClick={handleToggle}
      >
        <div className="group-color-dot" style={{ background: getGroupColor(group.color) }} />
        {renaming ? (
          <input
            className="group-rename-input"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={handleRenameSubmit}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className="group-name" onDoubleClick={handleRenameStart}>
            {group.name}
          </span>
        )}
        <span className="group-count">{group.tabs.length}</span>

        {/* Group actions — hidden for Current (auto-generated groups). */}
        {!isCurrent && (
        <span className="group-actions">
          <button
            className="group-action-btn"
            title="Rename group"
            onClick={handleRenameStart}
          >
            <IconEdit size={12} />
          </button>
          <button
            className="group-action-btn group-action-danger"
            title="Delete group"
            onClick={handleDelete}
          >
            <IconTrash size={12} />
          </button>
        </span>
        )}

        {group.tabs.length > 0 && onCloseAll && (
          <>
            <button
              className="group-close-all"
              title="Close duplicate tabs in group"
              onClick={(e) => {
                e.stopPropagation();
                onCloseDuplicates?.(group.tabs.map((t) => ({ window_id: t.window_id, chrome_tab_id: t.chrome_tab_id, url: t.url })));
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
            </button>
            <button
              className="group-close-all"
              title="Close all tabs in group"
              onClick={(e) => {
                e.stopPropagation();
                onCloseAll(group.tabs.map((t) => ({ window_id: t.window_id, chrome_tab_id: t.chrome_tab_id, url: t.url })));
              }}
            >
              <IconX size={12} />
            </button>
          </>
        )}
        <span className={`group-toggle${collapsed ? "" : " open"}`}>
          <IconChevronRight size={12} />
        </span>
      </div>
      {!collapsed && (
        <div className="group-body">
          {group.tabs.length > 0 ? (
            group.tabs.map((tab) => (
              <DraggableTab
                key={tab.id}
                tab={tab}
                onNavigate={onNavigate}
                onClose={onCloseTab}
                isCurrent={isCurrent}
              />
            ))
          ) : (
            <div className="tab-empty">Drop tabs here</div>
          )}
        </div>
      )}
    </div>
  );
}

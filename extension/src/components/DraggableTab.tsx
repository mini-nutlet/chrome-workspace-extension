import type { Tab } from "../lib/types";
import { IconGrip, IconX, IconTrash } from "./Icons";
import { normalizeUrlAggressive } from "../lib/api";

interface DraggableTabProps {
  tab: Tab;
  onNavigate: (url: string, kind: string, existingTabId?: number) => void;
  onClose: (windowId: number, chromeTabId: number, tabDbId?: number) => void;
  isCurrent?: boolean;
}

const GROUP_COLORS: Record<string, string> = {
  blue: "var(--group-blue)",
  green: "var(--group-green)",
  orange: "var(--group-orange)",
  purple: "var(--group-purple)",
  red: "var(--group-red)",
  cyan: "var(--group-cyan)",
  pink: "var(--group-pink)",
  gray: "var(--group-gray)",
};

export function getGroupColor(color: string): string {
  return GROUP_COLORS[color] || color || "var(--group-gray)";
}

function faviconUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=16`;
  } catch {
    return "";
  }
}

// Green dot indicating the tab is currently open in the browser.
function OpenDot() {
  return (
    <span className="tab-open-dot" title="Open in browser">
      <svg width="8" height="8" viewBox="0 0 8 8">
        <circle cx="4" cy="4" r="4" fill="currentColor" />
      </svg>
    </span>
  );
}

export function DraggableTab({ tab, onNavigate, onClose, isCurrent }: DraggableTabProps) {
  // In Current workspace, all tabs are open by definition.
  // In other workspaces, the backend sets tab.is_open based on browser state.
  const isOpen = isCurrent || tab.is_open !== false;
  const closed = !isOpen;

  return (
    <div
      className={`tab-row${closed ? " tab-closed" : ""}`}
      draggable={isOpen && !isCurrent}
      onDragStart={(e) => {
        if (closed) { e.preventDefault(); return; }
        e.dataTransfer.setData("text/tab-id", String(tab.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onNavigate(tab.url, "tab", tab.id)}
      title={closed ? "Click to reopen this tab" : undefined}
    >
      <span className="tab-grip"><IconGrip size={14} /></span>
      {faviconUrl(tab.url) && (
        <img className="tab-favicon" src={faviconUrl(tab.url)} alt="" width={16} height={16} />
      )}
      <div className="tab-info">
        <div className="tab-title">
          {tab.title || tab.url}
          {(tab.open_count ?? 0) > 1 && (
            <span className="badge" style={{ background: "var(--text-tertiary)", color: "#fff", fontSize: 10, marginLeft: 4 }}>×{tab.open_count}</span>
          )}
          {isOpen && <OpenDot />}
          {tab.active && !closed && (
            <span className="badge badge-active">ACTIVE</span>
          )}
        </div>
        <div className="tab-url">{tab.url}</div>
      </div>
      <div className="tab-actions">
        {/* Close duplicate tabs — closes all other browser tabs with
            the same URL (aggressive normalisation), keeping this one. */}
        {isOpen && (tab.open_count ?? 0) > 1 && (
          <button
            className="tab-close"
            title="Close duplicate tabs"
            onClick={async (e) => {
              e.stopPropagation();
              const target = normalizeUrlAggressive(tab.url);
              const allTabs = await chrome.tabs.query({});
              for (const t of allTabs) {
                if (t.id == null || !t.url) continue;
                if (t.id === tab.chrome_tab_id) continue; // keep this one
                if (normalizeUrlAggressive(t.url) === target) {
                  try { await chrome.tabs.remove(t.id); } catch {}
                  // Also remove from DB for Current workspace.
                  if (isCurrent) {
                    try { await onClose(t.windowId, t.id); } catch {}
                  }
                }
              }
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 12h8"/>
            </svg>
          </button>
        )}
        {/* Close Tab (X) — closes ALL browser tabs with this URL (including
            duplicates) and removes them from the DB. Does not keep snapshots. */}
        {isOpen && (
          <button
            className="tab-close"
            title="Close all tabs with this URL"
            onClick={async (e) => {
              e.stopPropagation();
              const target = normalizeUrlAggressive(tab.url);
              const allTabs = await chrome.tabs.query({});
              for (const t of allTabs) {
                if (t.id == null || !t.url) continue;
                if (normalizeUrlAggressive(t.url) === target) {
                  try { await chrome.tabs.remove(t.id); } catch {}
                  try { await onClose(t.windowId, t.id); } catch {}
                }
              }
            }}
          >
            <IconX size={12} />
          </button>
        )}
        {/* Delete button (Trash) — only for non-Current workspaces.
            Permanently removes the tab record from this workspace. */}
        {!isCurrent && (
          <button
            className="tab-delete"
            title="Delete"
            onClick={async (e) => {
              e.stopPropagation();
              await onClose(tab.window_id, tab.chrome_tab_id, tab.id);
            }}
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

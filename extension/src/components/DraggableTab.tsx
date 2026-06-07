import type { Tab } from "../lib/types";
import { IconGrip, IconX, IconTrash } from "./Icons";
import { closeBrowserTabByUrl } from "../lib/api";

interface DraggableTabProps {
  tab: Tab;
  onNavigate: (url: string, kind: string) => void;
  onClose: (windowId: number, chromeTabId: number) => void;
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

function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
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
      draggable={isOpen}
      onDragStart={(e) => {
        if (closed) { e.preventDefault(); return; }
        e.dataTransfer.setData("text/tab-id", String(tab.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onNavigate(tab.url, "tab")}
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
        <div className="tab-url">{cleanUrl(tab.url)}</div>
      </div>
      <div className="tab-actions">
        {/* Close Tab button (X) — only shown when the tab is currently open in
            the browser (green dot). Clicking it closes the browser tab;
            the background worker then marks the record as inactive. */}
        {isOpen && (
          <button
            className="tab-close"
            title="Close Tab"
            onClick={async (e) => {
              e.stopPropagation();
              // Close the matching browser tab by URL.
              await closeBrowserTabByUrl(tab.url);
              // For Current workspace, immediately remove from DB and refresh UI.
              if (isCurrent) {
                await onClose(tab.window_id, tab.chrome_tab_id);
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
              await onClose(tab.window_id, tab.chrome_tab_id);
            }}
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

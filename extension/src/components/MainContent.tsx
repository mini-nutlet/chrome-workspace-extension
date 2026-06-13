import { useApp } from "../lib/context";
import type { Workspace } from "../lib/types";
import { CURRENT_WS_NAME } from "../db/workspace-repo";
import { IconMonitor, IconSun, IconMoon, IconSettings, IconSearch, IconLayers, IconWindow, IconSave, IconRefresh, IconTrash, IconX } from "./Icons";
import { ResultList } from "./ResultList";
import { GroupedTabList } from "./GroupedTabList";

// ── Sub-workspace card (shown in top-level workspace view) ──────────────

function SubWorkspaceCard({ ws, onClick }: { ws: Workspace; onClick: () => void }) {
  return (
    <div className="sub-ws-card" onClick={onClick}>
      <div className="sub-ws-card-header">
        <span className="sub-ws-card-icon">{ws.icon || "📁"}</span>
        <span className="sub-ws-card-name">{ws.name}</span>
      </div>
      {ws.description && (
        <div className="sub-ws-card-desc">{ws.description}</div>
      )}
      <div className="sub-ws-card-footer">
        <span className="sub-ws-card-hint">Click to view tabs →</span>
      </div>
    </div>
  );
}

// ── Top-level workspace card (shown in "Current Space" view) ────────────

function TopLevelWsCard({
  ws,
  subCount,
  onClick,
}: {
  ws: Workspace;
  subCount: number;
  onClick: () => void;
}) {
  return (
    <div className="top-ws-card" onClick={onClick}>
      <div className="top-ws-card-header">
        <div className="top-ws-card-avatar">
          {ws.icon || (ws.name.charAt(0) || "?").toUpperCase()}
        </div>
        <div className="top-ws-card-info">
          <span className="top-ws-card-name">{ws.name}</span>
          {ws.description && (
            <span className="top-ws-card-desc">{ws.description}</span>
          )}
          <span className="top-ws-card-meta">
            {subCount} sub-workspace{subCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main Content ──────────────────────────────────────────────────────

export function MainContent() {
  const {
    currentWsId, workspaces, query, results, searching, theme, changeTheme,
    navigate, openAllTabs, closeAllWorkspaceTabs, closeAllDuplicateTabs,
    saveSession, restoreSession, deleteSession,
    hasSession, switchWorkspace, tree,
  } = useApp();

  const currentWs = workspaces.find((ws) => ws.id === currentWsId);
  const showSearch = query.trim().length > 0;
  const showWsActions = currentWsId > 0 && !showSearch;

  // Determine view mode:
  //  - currentWsId === 0 → "Current Space" (dashboard of top-level workspaces)
  //  - currentWsId > 0 && parent_id === 0 → top-level workspace (show sub-workspaces)
  //  - currentWsId > 0 && parent_id > 0 → sub-workspace (show groups/tabs)
  const isTopLevel = currentWsId > 0 && currentWs?.parent_id === 0;
  const isSubLevel = currentWsId > 0 && currentWs && currentWs.parent_id > 0;
  const isCurrent = currentWs?.name === CURRENT_WS_NAME && currentWs?.parent_id === 0;

  // Filter sub-workspaces for the current top-level workspace.
  const subWorkspaces = workspaces.filter((w) => w.parent_id === currentWsId);

  // Compute total tab count for the current workspace.
  const totalTabs =
    (tree?.groups ?? []).reduce((sum, g) => sum + (g.tabs?.length ?? 0), 0) +
    (tree?.ungrouped_tabs?.length ?? 0);

  return (
    <div className="main-content">
      {/* Sticky header */}
      <div className="main-header">
        <div className="main-header-left">
          {showSearch && <IconSearch size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />}
          <span className="main-header-title">
            {showSearch
              ? `Search: "${query}"`
              : currentWs
                ? currentWs.name
                : "Current Space"}
          </span>
        </div>
        <div className="main-header-actions">
          {/* Workspace-level actions — only for non-root */}
          {showWsActions && (
            <div className="ws-actions">
              {/* Open All Tabs in One Window */}
              <button className="icon-btn" title="Open all tabs in One Window" onClick={openAllTabs}>
                <IconWindow size={16} />
              </button>
              {/* Close duplicate tabs */}
              <button className="icon-btn" title="Close all duplicate tabs" onClick={closeAllDuplicateTabs}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
              </button>
              {/* Close all workspace tabs */}
              {totalTabs > 0 && (
                <button
                  className="icon-btn icon-btn-danger"
                  title={`Close all ${totalTabs} tabs in this workspace`}
                  onClick={closeAllWorkspaceTabs}
                >
                  <IconX size={16} />
                </button>
              )}
              <button className="icon-btn" title="Save session" onClick={saveSession}>
                <IconSave size={16} />
              </button>
              {hasSession && (
                <>
                  <button className="icon-btn" title="Restore saved session" onClick={restoreSession}>
                    <IconRefresh size={16} />
                  </button>
                  <button className="icon-btn icon-btn-danger" title="Delete saved session" onClick={deleteSession}>
                    <IconTrash size={16} />
                  </button>
                </>
              )}
              <span className="ws-actions-sep" />
            </div>
          )}
          <button className="icon-btn" title="Settings" onClick={() => chrome.runtime.openOptionsPage()}>
            <IconSettings size={16} />
          </button>
          <div className="theme-toggle">
            <button className={`icon-btn${theme === "system" ? " active" : ""}`} onClick={() => changeTheme("system")} title="System">
              <IconMonitor size={14} />
            </button>
            <button className={`icon-btn${theme === "light" ? " active" : ""}`} onClick={() => changeTheme("light")} title="Light">
              <IconSun size={14} />
            </button>
            <button className={`icon-btn${theme === "dark" ? " active" : ""}`} onClick={() => changeTheme("dark")} title="Dark">
              <IconMoon size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="main-body">
        {showSearch ? (
          <ResultList results={results} loading={searching} onNavigate={navigate} />
        ) : currentWsId === 0 ? (
          /* Current Space — dashboard of top-level workspaces */
          <div className="current-space-view">
            <div className="section-header">
              <h2 className="section-title">Top-Level Workspaces</h2>
              <span className="section-count">{workspaces.filter((w) => w.parent_id === 0).length}</span>
            </div>
            {workspaces.filter((w) => w.parent_id === 0).length === 0 ? (
              <div className="empty-state">
                <IconLayers size={48} className="empty-state-icon" />
                <div className="empty-state-text">No workspaces yet</div>
                <div className="empty-state-hint">Click + in the sidebar to create your first workspace</div>
              </div>
            ) : (
              <div className="top-ws-grid">
                {workspaces
                  .filter((w) => w.parent_id === 0)
                  .map((ws) => (
                    <TopLevelWsCard
                      key={ws.id}
                      ws={ws}
                      subCount={workspaces.filter((w) => w.parent_id === ws.id).length}
                      onClick={() => switchWorkspace(ws.id)}
                    />
                  ))}
              </div>
            )}
          </div>
        ) : isCurrent ? (
          /* Current workspace — auto-captures tabs, no sub-workspaces */
          <GroupedTabList isCurrent />
        ) : isTopLevel && !isCurrent ? (
          /* Top-level workspace (non-Current) — show sub-workspaces */
          <div className="top-level-view">
            <div className="section-header">
              <h2 className="section-title">Sub Workspaces</h2>
              <span className="section-count">{subWorkspaces.length}</span>
            </div>
            {subWorkspaces.length === 0 ? (
              <div className="empty-state">
                <IconLayers size={48} className="empty-state-icon" />
                <div className="empty-state-text">No sub-workspaces</div>
                <div className="empty-state-hint">Right-click this workspace to add sub-workspaces</div>
              </div>
            ) : (
              <div className="sub-ws-grid">
                {subWorkspaces.map((ws) => (
                  <SubWorkspaceCard
                    key={ws.id}
                    ws={ws}
                    onClick={() => switchWorkspace(ws.id)}
                  />
                ))}
              </div>
            )}
            {/* Also show tabs directly in the top-level workspace */}
            <GroupedTabList />
          </div>
        ) : isSubLevel ? (
          /* Sub-level workspace — show groups + tabs */
          <GroupedTabList />
        ) : (
          /* Fallback empty state */
          <div className="empty-state">
            <IconLayers size={48} className="empty-state-icon" />
            <div className="empty-state-text">Select a workspace</div>
            <div className="empty-state-hint">Choose a workspace from the sidebar to view its tabs</div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useMemo, useEffect, useRef } from "react";
import { useApp } from "../lib/context";
import type { Workspace } from "../lib/types";
import { IconSearch, IconPlus, IconX, IconChevronRight, IconTrash, IconHome, IconDots } from "./Icons";
import { ContextMenu, type MenuAction } from "./ContextMenu";

// Deterministic color from workspace name for the avatar.
const AVATAR_COLORS = [
  "#5b5fc7", "#22a06b", "#d97706", "#8b5cf6", "#dc3545",
  "#06b6d4", "#ec4899", "#64748b", "#e8922d", "#3b82f6",
];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]!;
}

function avatarLetter(name: string): string {
  return (name.charAt(0) || "?").toUpperCase();
}

// ── Tree helpers ────────────────────────────────────────────────────────

interface TreeNode {
  ws: Workspace;
  children: TreeNode[];
}

function buildTree(workspaces: Workspace[]): TreeNode[] {
  // Sort by sort_order, but "Current" always first.
  const sorted = [...workspaces].sort((a, b) => {
    const aCurrent = a.name === "Current" && a.parent_id === 0;
    const bCurrent = b.name === "Current" && b.parent_id === 0;
    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;
    return a.sort_order - b.sort_order;
  });
  const map = new Map<number, TreeNode>();
  const roots: TreeNode[] = [];
  for (const ws of sorted) {
    map.set(ws.id, { ws, children: [] });
  }
  for (const ws of sorted) {
    const node = map.get(ws.id)!;
    if (ws.parent_id > 0) {
      const parent = map.get(ws.parent_id);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }
  return roots;
}

interface FlatItem {
  ws: Workspace;
  depth: number;
  hasChildren: boolean;
}

function flattenTree(nodes: TreeNode[], depth = 0): FlatItem[] {
  const out: FlatItem[] = [];
  for (const node of nodes) {
    out.push({ ws: node.ws, depth, hasChildren: node.children.length > 0 });
    out.push(...flattenTree(node.children, depth + 1));
  }
  return out;
}

// ── Sidebar component ───────────────────────────────────────────────────

export function Sidebar() {
  const {
    workspaces, currentWsId, query, results,
    switchWorkspace, setQuery, createWorkspace, deleteWorkspace,
    openAllTabs, reorderWorkspaces, navigate,
  } = useApp();
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createParentId, setCreateParentId] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [deletingWs, setDeletingWs] = useState<Workspace | null>(null);

  // Context menu state (Opt 16 — triggered by ⋮ icon click, not right-click)
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number; ws: Workspace; isTop: boolean; isCurrent: boolean;
  } | null>(null);

  // Rename state
  const [renamingWs, setRenamingWs] = useState<Workspace | null>(null);
  const [renameName, setRenameName] = useState("");

  // Drag-and-drop state (Opt 27)
  const [dragWs, setDragWs] = useState<Workspace | null>(null);
  const [dragOverWs, setDragOverWs] = useState<Workspace | null>(null);

  // Quick-search (Opt 28)
  const searchRef = useRef<HTMLInputElement>(null);
  const [enterCount, setEnterCount] = useState(0);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listen for focus-search command from background (Opt 28)
  useEffect(() => {
    const handler = (msg: { type: string }) => {
      if (msg.type === "focus-search" && searchRef.current) {
        searchRef.current.focus();
        searchRef.current.select();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // Reset enter count after a delay.
  useEffect(() => {
    if (enterCount > 0) {
      if (enterTimer.current) clearTimeout(enterTimer.current);
      enterTimer.current = setTimeout(() => setEnterCount(0), 1500);
    }
    return () => { if (enterTimer.current) clearTimeout(enterTimer.current); };
  }, [enterCount]);

  const tree = useMemo(() => buildTree(workspaces), [workspaces]);
  const flatList = useMemo(() => flattenTree(tree), [tree]);

  const toggleCollapse = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await createWorkspace(newName.trim(), "", createParentId);
    setNewName("");
    setShowCreate(false);
    setCreateParentId(0);
  };

  const startCreate = (parentId = 0) => {
    setCreateParentId(parentId);
    setNewName("");
    setShowCreate(true);
  };

  const handleDelete = (ws: Workspace) => {
    setDeletingWs(ws);
  };

  const confirmDelete = async () => {
    if (!deletingWs) return;
    await deleteWorkspace(deletingWs.id);
    setDeletingWs(null);
    setCtxMenu(null);
  };

  const cancelDelete = () => {
    setDeletingWs(null);
  };

  // ── Context menu (Opt 16: triggered by ⋮ icon) ──────────────────────
  const isCurrentWs = (ws: Workspace) => ws.name === "Current" && ws.parent_id === 0;

  const openContextMenu = (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtxMenu({
      x: rect.right,
      y: rect.bottom,
      ws,
      isTop: ws.parent_id === 0,
      isCurrent: isCurrentWs(ws),
    });
  };

  const handleMenuSelect = (kind: MenuAction["kind"]) => {
    if (!ctxMenu) return;
    const ws = ctxMenu.ws;
    setCtxMenu(null);

    switch (kind) {
      case "openAll":
        switchWorkspace(ws.id);
        setTimeout(() => openAllTabs(), 100);
        break;
      case "addSub":
        startCreate(ws.id);
        break;
      case "rename":
        setRenamingWs(ws);
        setRenameName(ws.name);
        break;
      case "delete":
        handleDelete(ws);
        break;
    }
  };

  const handleRenameSubmit = async () => {
    if (!renamingWs || !renameName.trim()) {
      setRenamingWs(null);
      return;
    }
    await createWorkspace(renameName.trim(), "", renamingWs.parent_id);
    await deleteWorkspace(renamingWs.id);
    setRenamingWs(null);
    setRenameName("");
  };

  // ── Drag-and-drop handlers (Opt 27) ─────────────────────────────────
  const handleDragStart = (e: React.DragEvent, ws: Workspace) => {
    e.dataTransfer.setData("text/ws-id", String(ws.id));
    e.dataTransfer.effectAllowed = "move";
    setDragWs(ws);
  };

  const handleDragOver = (e: React.DragEvent, ws: Workspace) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragWs && dragWs.id !== ws.id) {
      setDragOverWs(ws);
    }
  };

  const handleDragLeave = () => {
    setDragOverWs(null);
  };

  const handleDrop = async (e: React.DragEvent, targetWs: Workspace) => {
    e.preventDefault();
    setDragOverWs(null);
    setDragWs(null);
    const srcId = e.dataTransfer.getData("text/ws-id");
    if (!srcId || srcId === String(targetWs.id)) return;

    const src = workspaces.find((w) => w.id === Number(srcId));
    if (!src) return;

    // Determine new parent:
    // - Drop on a top-level workspace → becomes a sibling (parent_id = 0), level-2→1
    // - Drop on a sub-workspace → same parent as target
    const newParentId = targetWs.parent_id === 0 ? 0 : targetWs.parent_id;

    // Rebuild the sibling list in the new parent group.
    const siblings = workspaces
      .filter((w) => w.parent_id === newParentId && w.id !== src.id)
      .sort((a, b) => a.sort_order - b.sort_order);

    // Insert the dragged item at the target's position.
    const targetIdx = siblings.findIndex((w) => w.id === targetWs.id);
    const insertIdx = targetIdx >= 0 ? targetIdx : siblings.length;

    const updated = [
      ...siblings.slice(0, insertIdx),
      { id: src.id, parent_id: newParentId, sort_order: insertIdx },
    ];
    for (let i = insertIdx; i < siblings.length; i++) {
      updated.push({ id: siblings[i]!.id, parent_id: newParentId, sort_order: i + 1 });
    }

    await reorderWorkspaces(updated);
  };

  // Visibility filtering for collapsed parents.
  const isVisible = (item: FlatItem, idx: number): boolean => {
    for (let i = idx - 1; i >= 0; i--) {
      const ancestor = flatList[i]!;
      if (ancestor.depth < item.depth && collapsed.has(ancestor.ws.id)) {
        return false;
      }
    }
    return true;
  };

  return (
    <div className="sidebar">
      {/* Header — Home icon + Workspaces title + New button (Opt 17) */}
      <div className="sidebar-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            className="icon-btn"
            title="Home — show all workspaces"
            onClick={() => switchWorkspace(0)}
          >
            <IconHome size={17} />
          </button>
          <span className="sidebar-header-title">Workspaces</span>
        </div>
        <button
          className="icon-btn"
          title="New top-level workspace"
          onClick={() => startCreate(0)}
        >
          <IconPlus size={16} />
        </button>
      </div>

      {/* Search */}
      <div className="sidebar-search">
        <div className="sidebar-search-wrapper">
          <span className="sidebar-search-icon"><IconSearch size={14} /></span>
          <input
            ref={searchRef}
            type="text"
            placeholder="Search… (Ctrl+Shift+F)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setEnterCount(0); // reset on typing
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const trimmed = query.trim();
                if (!trimmed) return;
                // If there are results, first result opens on Enter (default behavior
                // is handled by the search results list; here we handle "no results").
                const hasResults = results && results.length > 0;
                if (!hasResults) {
                  e.preventDefault();
                  const newCount = enterCount + 1;
                  setEnterCount(newCount);
                  if (newCount >= 2) {
                    // Double Enter: let browser decide URL vs search.
                    setEnterCount(0);
                    setQuery("");
                    const url = trimmed;
                    // If it looks like a URL, add https:// prefix.
                    if (/^https?:\/\//i.test(url) || /\.\w{2,}(\/|$)/.test(url)) {
                      navigate(/^https?:\/\//i.test(url) ? url : "https://" + url, "tab");
                    } else {
                      // Looks like a search query — use Google search.
                      navigate("https://www.google.com/search?q=" + encodeURIComponent(url), "tab");
                    }
                  }
                }
              }
            }}
          />
        </div>
      </div>

      {/* Workspace tree */}
      <div className="sidebar-list">
        {/* Rename input */}
        {renamingWs && (
          <div className="ws-create-form" style={{ marginLeft: renamingWs.parent_id ? 24 : 4 }}>
            <input
              placeholder="New name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameSubmit();
                if (e.key === "Escape") setRenamingWs(null);
              }}
              autoFocus
            />
            <button className="btn btn-accent btn-sm" onClick={handleRenameSubmit}>OK</button>
            <button className="icon-btn" onClick={() => setRenamingWs(null)}>
              <IconX size={14} />
            </button>
          </div>
        )}

        {/* Create form — auto-indented for sub-workspaces (Opt 15) */}
        {showCreate && (
          <div className="ws-create-form" style={{ marginLeft: createParentId ? 24 : 4 }}>
            <input
              placeholder={createParentId ? "Sub-workspace name" : "Workspace name"}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setShowCreate(false); setCreateParentId(0); }
              }}
              autoFocus
            />
            <button className="btn btn-accent btn-sm" onClick={handleCreate}>Add</button>
            <button className="icon-btn" onClick={() => { setShowCreate(false); setCreateParentId(0); }}>
              <IconX size={14} />
            </button>
          </div>
        )}

        {/* Workspace items */}
        {flatList.map((item, idx) => {
          if (!isVisible(item, idx)) return null;
          const isTop = item.ws.parent_id === 0;

          return (
            <div key={item.ws.id}>
              <div
                className={`ws-item${currentWsId === item.ws.id ? " selected" : ""}${isTop ? " ws-item-top" : ""}${dragOverWs?.id === item.ws.id ? " drag-over" : ""}${dragWs?.id === item.ws.id ? " dragging" : ""}`}
                style={{ paddingLeft: 8 + item.depth * 20 }}
                draggable={!isCurrentWs(item.ws)}
                onClick={() => switchWorkspace(item.ws.id)}
                onDragStart={(e) => handleDragStart(e, item.ws)}
                onDragOver={(e) => handleDragOver(e, item.ws)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, item.ws)}
                title={isCurrentWs(item.ws) ? "Permanent workspace" : item.ws.description || item.ws.name}
              >
                {/* Toggle arrow for parents */}
                {item.hasChildren ? (
                  <span
                    className={`ws-toggle${collapsed.has(item.ws.id) ? "" : " open"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(item.ws.id);
                    }}
                  >
                    <IconChevronRight size={12} />
                  </span>
                ) : (
                  <span className="ws-toggle-placeholder" />
                )}
                <div
                  className="ws-avatar"
                  style={{ background: avatarColor(item.ws.name) }}
                >
                  {avatarLetter(item.ws.name)}
                </div>
                <span className="ws-item-name">{item.ws.name}</span>
                {/* ⋮ context menu trigger — hidden for Current workspace (Opt 20) */}
                {!isCurrentWs(item.ws) && (
                  <button
                    className="ws-menu-trigger"
                    title="More actions"
                    onClick={(e) => openContextMenu(e, item.ws)}
                  >
                    <IconDots size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* No "New Workspace" button at bottom (Opt 15) */}
      </div>

      {/* Delete confirmation popup */}
      {deletingWs && (
        <div className="ws-delete-confirm-overlay" onClick={cancelDelete}>
          <div className="ws-delete-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="ws-delete-confirm-icon">
              <IconTrash size={20} />
            </div>
            <div className="ws-delete-confirm-text">
              Delete <strong>{deletingWs.name}</strong>?
              {deletingWs.parent_id === 0 && flatList.some((f) => f.ws.parent_id === deletingWs.id) && (
                <span className="ws-delete-confirm-warn">
                  Its sub-workspaces will be moved to root.
                </span>
              )}
            </div>
            <div className="ws-delete-confirm-actions">
              <button className="btn btn-sm" onClick={cancelDelete}>Cancel</button>
              <button className="btn btn-sm btn-danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Context menu (Opt 16 — triggered by ⋮ click) */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          isTopLevel={ctxMenu.isTop}
          isCurrent={ctxMenu.isCurrent}
          onSelect={handleMenuSelect}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

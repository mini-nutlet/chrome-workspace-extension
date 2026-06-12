import { getDb, now, type WorkspaceRow } from "./database";

export interface Workspace {
  id: number;
  parent_id: number;
  sort_order: number;
  name: string;
  description: string;
  icon: string;
  created_at: string;
  updated_at: string;
}

/** Reserved name for the auto-tracking workspace. */
export const CURRENT_WS_NAME = "Current";

function toApi(row: WorkspaceRow): Workspace {
  return {
    id: row.id!,
    parent_id: row.parentId,
    sort_order: row.sortOrder,
    name: row.name,
    description: row.description,
    icon: row.icon,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const db = await getDb();
  const rows = await db.getAll("workspaces");
  return rows.map(toApi).sort((a, b) => a.parent_id - b.parent_id || a.sort_order - b.sort_order || a.id - b.id);
}

export async function getWorkspace(id: number): Promise<Workspace | null> {
  const db = await getDb();
  const row = await db.get("workspaces", id);
  return row ? toApi(row) : null;
}

export async function createWorkspace(
  name: string, description = "", icon = "", parentId = 0, afterId = 0
): Promise<Workspace> {
  // "Current" is the reserved auto-tracking workspace — only one may exist.
  if (name === CURRENT_WS_NAME && parentId === 0) {
    const db = await getDb();
    const all = await db.getAll("workspaces");
    const existing = all.find((w: WorkspaceRow) => w.name === CURRENT_WS_NAME && w.parentId === 0);
    if (existing) throw new Error(`"${CURRENT_WS_NAME}" workspace already exists`);
  }

  const db = await getDb();
  const tx = db.transaction("workspaces", "readwrite");
  const store = tx.objectStore("workspaces");

  // Compute sort_order
  let sortOrder = 0;
  const all = await store.getAll();
  const siblings = all.filter((w: WorkspaceRow) => w.parentId === parentId).sort((a: WorkspaceRow, b: WorkspaceRow) => a.sortOrder - b.sortOrder);
  if (afterId > 0) {
    const after = siblings.find((w: WorkspaceRow) => w.id === afterId);
    if (after) {
      sortOrder = after.sortOrder + 1;
      // Shift later siblings
      for (const s of siblings) {
        if (s.sortOrder > after.sortOrder) {
          await store.put({ ...s, sortOrder: s.sortOrder + 1 });
        }
      }
    }
  } else if (siblings.length > 0) {
    sortOrder = siblings[siblings.length - 1].sortOrder + 1;
  }

  const id = await store.add({
    parentId, sortOrder: sortOrder, name, description, icon,
    createdAt: now(), updatedAt: now(),
  });
  await tx.done;
  // Ungrouped group is created on-demand when a tab needs it (in ungroupedGroupId).
  return (await getWorkspace(id as number))!;
}

export async function updateWorkspace(id: number, fields: {
  name?: string; description?: string; icon?: string; parent_id?: number;
}): Promise<Workspace | null> {
  const db = await getDb();
  const row = await db.get("workspaces", id);
  if (!row) return null;
  // Block renaming any workspace to the reserved "Current" name.
  if (fields.name === CURRENT_WS_NAME && row.name !== CURRENT_WS_NAME && row.parentId === 0) {
    const all = await db.getAll("workspaces");
    const existing = all.find((w: WorkspaceRow) => w.name === CURRENT_WS_NAME && w.parentId === 0);
    if (existing) throw new Error(`"${CURRENT_WS_NAME}" is a reserved workspace name`);
  }
  Object.assign(row, {
    name: fields.name ?? row.name,
    description: fields.description ?? row.description,
    icon: fields.icon ?? row.icon,
    parentId: fields.parent_id ?? row.parentId,
    updatedAt: now(),
  });
  await db.put("workspaces", row);
  return getWorkspace(id);
}

export async function deleteWorkspace(id: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["workspaces", "tabWorkspaces", "tabGroups", "bookmarks"], "readwrite");

  // Clean junction entries
  const twIdx = tx.objectStore("tabWorkspaces").index("workspaceId");
  for (let c = await twIdx.openCursor(id); c; c = await c.continue()) { c.delete(); }

  // Clean groups
  const tgIdx = tx.objectStore("tabGroups").index("workspaceId");
  for (let c = await tgIdx.openCursor(id); c; c = await c.continue()) { c.delete(); }

  // Clean bookmarks
  const bmIdx = tx.objectStore("bookmarks").index("workspaceId");
  for (let c = await bmIdx.openCursor(id); c; c = await c.continue()) { c.delete(); }

  // Re-parent children
  const parentIdx = tx.objectStore("workspaces").index("parentId");
  const row = await tx.objectStore("workspaces").get(id);
  const newParent = row?.parentId ?? 0;
  for (let c = await parentIdx.openCursor(id); c; c = await c.continue()) {
    (c.value as WorkspaceRow).parentId = newParent;
    c.update(c.value);
  }

  tx.objectStore("workspaces").delete(id);
  await tx.done;
}

export async function reorderWorkspaces(
  items: { id: number; parent_id: number; sort_order: number }[]
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("workspaces", "readwrite");
  for (const item of items) {
    const row = await tx.objectStore("workspaces").get(item.id);
    if (row) {
      row.parentId = item.parent_id;
      row.sortOrder = item.sort_order;
      row.updatedAt = now();
      await tx.objectStore("workspaces").put(row);
    }
  }
  await tx.done;
}

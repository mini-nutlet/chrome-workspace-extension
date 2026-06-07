import { getDb, now, hashUrl, type BookmarkRow } from "./database";

export interface Bookmark {
  id: number;
  workspace_id: number;
  title: string;
  url: string;
  url_hash: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

function toApi(row: BookmarkRow): Bookmark {
  return {
    id: row.id!, workspace_id: row.workspaceId,
    title: row.title, url: row.url, url_hash: row.urlHash,
    tags: row.tags, created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export async function listBookmarks(workspaceId = 0): Promise<Bookmark[]> {
  const db = await getDb();
  if (workspaceId > 0) {
    const idx = db.transaction("bookmarks").store.index("workspaceId");
    return (await idx.getAll(workspaceId)).map(toApi);
  }
  return (await db.getAll("bookmarks")).map(toApi);
}

export async function createBookmark(bm: {
  workspace_id: number; title: string; url: string; tags?: string;
}): Promise<Bookmark> {
  const db = await getDb();
  const id = await db.add("bookmarks", {
    workspaceId: bm.workspace_id, title: bm.title, url: bm.url,
    urlHash: hashUrl(bm.url), tags: bm.tags ?? "",
    createdAt: now(), updatedAt: now(),
  });
  return (await db.get("bookmarks", id)) as unknown as Bookmark;
}

export async function deleteBookmark(id: number): Promise<void> {
  await (await getDb()).delete("bookmarks", id);
}

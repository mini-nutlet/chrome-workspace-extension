import { getDb, now } from "./database";
import type { Tab } from "./tab-repo";

export async function saveSession(workspaceId: number, tabs: Tab[]): Promise<void> {
  const db = await getDb();
  await db.put("sessions", {
    workspaceId, tabsJson: JSON.stringify(tabs), savedAt: now(),
  });
}

export async function restoreSession(workspaceId: number): Promise<{
  tabs: Tab[] | null; saved_at: string | null;
}> {
  const db = await getDb();
  const row = await db.get("sessions", workspaceId);
  if (!row) return { tabs: null, saved_at: null };
  return {
    tabs: JSON.parse(row.tabsJson),
    saved_at: row.savedAt,
  };
}

export async function deleteSession(workspaceId: number): Promise<void> {
  await (await getDb()).delete("sessions", workspaceId);
}

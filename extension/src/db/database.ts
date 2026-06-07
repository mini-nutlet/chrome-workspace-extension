// IndexedDB schema and connection for the standalone Workspace Companion.
// Uses the `idb` library for a clean Promise-based API.
import { openDB, type IDBPDatabase } from "idb";

export interface WorkspaceRow {
  id?: number;
  parentId: number;
  sortOrder: number;
  name: string;
  description: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
}

export interface TabRow {
  id?: number;
  windowId: number;
  chromeTabId: number;
  title: string;
  url: string;
  urlHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface TabWorkspaceRow {
  id?: number;
  tabId: number;
  workspaceId: number;
  active: number;       // 0/1
  groupId: number;
  addedAt: string;
}

export interface TabGroupRow {
  id?: number;
  workspaceId: number;
  name: string;
  color: string;
  collapsed: number;    // 0/1
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkRow {
  id?: number;
  workspaceId: number;
  title: string;
  url: string;
  urlHash: string;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutoGroupRuleRow {
  id?: number;
  domainPattern: string;
  groupName: string;
  enabled: number;      // 0/1
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRow {
  workspaceId: number;
  tabsJson: string;
  savedAt: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB("workspace-companion", 1, {
      upgrade(db) {
        // Workspaces
        const wsStore = db.createObjectStore("workspaces", {
          keyPath: "id",
          autoIncrement: true,
        });
        wsStore.createIndex("parentId", "parentId");
        wsStore.createIndex("sortOrder", "sortOrder");

        // Tabs (shared rows)
        const tabStore = db.createObjectStore("tabs", {
          keyPath: "id",
          autoIncrement: true,
        });
        tabStore.createIndex("windowChrome", ["windowId", "chromeTabId"], { unique: true });
        tabStore.createIndex("urlHash", "urlHash");

        // Tab-Workspace junction
        const twStore = db.createObjectStore("tabWorkspaces", {
          keyPath: "id",
          autoIncrement: true,
        });
        twStore.createIndex("tabWorkspace", ["tabId", "workspaceId"], { unique: true });
        twStore.createIndex("workspaceId", "workspaceId");
        twStore.createIndex("workspaceGroup", ["workspaceId", "groupId"]);

        // Tab Groups
        const tgStore = db.createObjectStore("tabGroups", {
          keyPath: "id",
          autoIncrement: true,
        });
        tgStore.createIndex("workspaceId", "workspaceId");

        // Bookmarks
        const bmStore = db.createObjectStore("bookmarks", {
          keyPath: "id",
          autoIncrement: true,
        });
        bmStore.createIndex("workspaceId", "workspaceId");
        bmStore.createIndex("urlHash", "urlHash");

        // Auto-group rules
        const agStore = db.createObjectStore("autoGroupRules", {
          keyPath: "id",
          autoIncrement: true,
        });
        agStore.createIndex("enabled", "enabled");

        // Sessions
        db.createObjectStore("sessions", { keyPath: "workspaceId" });
      },
    });
  }
  return dbPromise;
}

export function now(): string {
  return new Date().toISOString();
}

export function hashUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

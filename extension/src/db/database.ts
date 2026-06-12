// IndexedDB schema and connection for the standalone Workspace Companion.
// Uses the `idb` library for a clean Promise-based API.
import { openDB, type IDBPDatabase } from "idb";

// ── Similarity rule types (mirrors lib/types.ts) ─────────────────────
export type SimRuleType = "ignore_query" | "ignore_hash" | "ignore_path_query";

export interface SimilarityRule {
  id: string;
  domain_pattern: string;
  rule_type: SimRuleType;
  enabled: boolean;
  /** When true, a duplicate on this domain auto-switches. */
  auto_switch: boolean;
}

let cachedSimRules: SimilarityRule[] | null = null;
let simRulesLoadPromise: Promise<SimilarityRule[]> | null = null;

/** Load similarity rules from chrome.storage.local, with in-memory cache. */
export async function loadSimilarityRules(): Promise<SimilarityRule[]> {
  if (cachedSimRules) return cachedSimRules;
  if (simRulesLoadPromise) return simRulesLoadPromise;
  simRulesLoadPromise = (async () => {
    try {
      const result = await chrome.storage.local.get("similarityRules");
      const raw = (result.similarityRules as SimilarityRule[]) || [];
      // Normalise: old rules may lack auto_switch.
      cachedSimRules = raw.map((r) => ({ ...r, auto_switch: r.auto_switch ?? false }));
    } catch {
      cachedSimRules = [];
    }
    return cachedSimRules;
  })();
  return simRulesLoadPromise;
}

/** Invalidate the similarity-rules cache (call when settings change). */
export function invalidateSimRulesCache() { cachedSimRules = null; simRulesLoadPromise = null; }

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

/**
 * Default aggressive hash — strips query + hash + www, lowercases.
 * Used when no cached similarity rules are available (synchronous path).
 */
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

/**
 * Similarity-aware URL hashing — applies per-domain rules.
 * Must be called after loadSimilarityRules() has populated the cache.
 */
export function hashUrlWithRules(url: string, simRules: SimilarityRule[]): string {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, "");

    // Find the best-matching rule for this domain.
    let matchedRule: SimilarityRule | null = null;
    for (const rule of simRules) {
      if (!rule.enabled) continue;
      if (hostname.includes(rule.domain_pattern)) {
        matchedRule = rule;
        break; // first match wins (rules are sorted by priority)
      }
    }

    if (matchedRule) {
      switch (matchedRule.rule_type) {
        case "ignore_path_query":
          // Keep only hostname
          return hostname.toLowerCase();
        case "ignore_hash":
          // Strip hash; keep query + path
          u.hash = "";
          break;
        case "ignore_query":
          // Strip query; keep hash + path
          u.search = "";
          break;
      }
    } else {
      // No rule matched — default aggressive: strip both hash + query
      u.hash = "";
      u.search = "";
    }

    return u.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// IndexedDB schema and connection for the standalone Workspace Companion.
// Uses the `idb` library for a clean Promise-based API.
import { openDB, type IDBPDatabase } from "idb";

// ── Similarity rule types (re-exported from lib/types.ts) ────────────
export type { SimRuleType, SimilarityRule, SimPatternType } from "../lib/types";
import type { SimilarityRule } from "../lib/types";

let cachedSimRules: SimilarityRule[] | null = null;
let simRulesLoadPromise: Promise<SimilarityRule[]> | null = null;

let migrationDone = false;

/** One-shot migration: convert legacy autoSwitchDomains to SimilarityRule entries. */
async function migrateLegacyAutoSwitch(rules: SimilarityRule[]): Promise<SimilarityRule[]> {
  if (migrationDone) return rules;
  migrationDone = true;
  try {
    const stored = await chrome.storage.local.get("autoSwitchDomains");
    const domains = (stored.autoSwitchDomains as string[]) || [];
    if (domains.length === 0) return rules;
    const existingPatterns = new Set(
      rules.map((r) => `${r.pattern}|${r.pattern_type}`),
    );
    for (const domain of domains) {
      if (!domain) continue;
      const key = `${domain}|domain`;
      if (existingPatterns.has(key)) continue; // avoid duplicates
      rules.push({
        id: crypto.randomUUID(),
        pattern: domain,
        pattern_type: "domain",
        rule_type: "ignore_query",
        enabled: true,
        auto_switch: true,
      });
    }
    await chrome.storage.local.remove("autoSwitchDomains");
  } catch { /* non-critical */ }
  return rules;
}

/** Load similarity rules from chrome.storage.local, with in-memory cache. */
export async function loadSimilarityRules(): Promise<SimilarityRule[]> {
  if (cachedSimRules) return cachedSimRules;
  if (simRulesLoadPromise) return simRulesLoadPromise;
  simRulesLoadPromise = (async () => {
    try {
      const result = await chrome.storage.local.get("similarityRules");
      const raw = (result.similarityRules as any[]) || [];
      // Normalise: old rules may lack auto_switch, pattern_type, or have domain_pattern.
      cachedSimRules = raw.map((r: any) => ({
        id: r.id ?? crypto.randomUUID(),
        pattern: r.pattern ?? r.domain_pattern ?? "",
        pattern_type: r.pattern_type ?? "domain",
        rule_type: r.rule_type ?? "ignore_query",
        enabled: r.enabled !== false,
        auto_switch: r.auto_switch ?? false,
      }));
      // Persist normalised rules back so next read is clean.
      await chrome.storage.local.set({ similarityRules: cachedSimRules });
      // Migrate legacy autoSwitchDomains → SimilarityRule entries.
      cachedSimRules = await migrateLegacyAutoSwitch(cachedSimRules);
      if (cachedSimRules.length > 0) {
        await chrome.storage.local.set({ similarityRules: cachedSimRules });
      }
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
 * Match a URL against a single SimilarityRule.
 * Supports domain, exact-path, and path-prefix matching.
 */
export function matchRule(url: string, rule: SimilarityRule): boolean {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    const pathname = u.pathname.toLowerCase();

    // Parse pattern into hostname and optional path parts.
    const slashIdx = rule.pattern.indexOf("/");
    const patHost = slashIdx === -1
      ? rule.pattern.toLowerCase()
      : rule.pattern.slice(0, slashIdx).toLowerCase();
    const patPath = slashIdx === -1 ? "" : rule.pattern.slice(slashIdx).toLowerCase();

    // Hostname match (substring — preserves existing behaviour).
    if (!hostname.includes(patHost.replace(/^www\./, ""))) return false;

    // Path match for exact_path and path_prefix.
    if (rule.pattern_type === "exact_path" || rule.pattern_type === "path_prefix") {
      if (!patPath) return true; // no path in pattern → fall back to domain-only
      // Normalise trailing slashes.
      const normPath = pathname.replace(/\/+$/, "") || "/";
      const normPat = patPath.replace(/\/+$/, "") || "/";
      if (rule.pattern_type === "exact_path") {
        return normPath === normPat;
      }
      // path_prefix: "/settings" matches "/settings/profile" but not "/settingsX"
      if (normPath === normPat) return true;
      return normPath.startsWith(normPat + "/");
    }

    // domain mode — hostname match was sufficient.
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the first enabled SimilarityRule matching the given URL.
 * Returns null if no rule matches.
 */
export function findRule(url: string, rules: SimilarityRule[]): SimilarityRule | null {
  for (const r of rules) {
    if (!r.enabled) continue;
    if (matchRule(url, r)) return r;
  }
  return null;
}

/**
 * Default URL hash — strips query + www, lowercases.
 * Hash fragments are preserved: SPA hash-route pages (/page#a vs /page#b)
 * are different pages by default.  Use an ignore_hash similarity rule to
 * collapse them.
 */
export function hashUrl(url: string): string {
  try {
    const u = new URL(url);
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

    // Find the best-matching rule using enhanced pattern matching.
    const matchedRule = findRule(url, simRules);

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
        case "exact":
          // Keep full URL — no normalisation (hash-based SPA routing)
          break;
      }
    } else {
      // No rule matched — default: strip query, keep hash (matches hashUrl)
      u.search = "";
    }

    return u.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

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

export interface Tab {
  id: number;
  window_id: number;
  chrome_tab_id: number;
  workspace_id: number;
  group_id: number;
  title: string;
  url: string;
  url_hash: string;
  active: boolean;
  snapshot?: boolean;
  is_open?: boolean;
  open_count?: number;
  created_at: string;
  updated_at: string;
}

export interface TabGroup {
  id: number;
  workspace_id: number;
  name: string;
  color: string;
  collapsed: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TabGroupWithTabs extends TabGroup {
  tabs: Tab[];
}

export interface TabGroupTree {
  groups: TabGroupWithTabs[];
  ungrouped_tabs: Tab[];
}

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

export interface AutoGroupRule {
  id: number;
  domain_pattern: string;
  group_name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  kind: string;
  id: number;
  title: string;
  url: string;
  workspace_id: number;
  group_id?: number;
  active?: boolean;
  rank: number;
}

export interface DuplicateCheck {
  duplicate: boolean;
  tab: { chrome_tab_id: number; window_id: number; title: string; } | null;
}

export interface Session {
  tabs: Tab[] | null;
  saved_at: string | null;
}

export type SimPatternType = "domain" | "exact_path" | "path_prefix";

export interface SimilarityRule {
  id: string;
  /** URL pattern: "github.com" | "github.com/settings" | "github.com/settings/" */
  pattern: string;
  pattern_type: SimPatternType;
  rule_type: SimRuleType;
  enabled: boolean;
  /** When true, a duplicate matching this rule auto-switches to the existing
   *  tab instead of showing a notification prompt. */
  auto_switch: boolean;
}

export type SimRuleType = "ignore_query" | "ignore_hash" | "ignore_path_query" | "exact";

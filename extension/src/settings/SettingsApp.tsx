import { useState, useEffect, useCallback, useRef } from "react";
import type { AutoGroupRule, SimilarityRule, SimRuleType, SimPatternType } from "../lib/types";
import type { Theme } from "../lib/context";
import * as api from "../lib/api";
import { IconPlus, IconEdit, IconTrash, IconMonitor, IconSun, IconMoon, IconSettings, IconDownload, IconUpload } from "../components/Icons";

// ── Similarity rule helpers ─────────────────────────────────────────────

const RULE_TYPE_LABELS: Record<SimRuleType, string> = {
  ignore_query: "Ignore query params (?...)",
  ignore_hash: "Ignore hash fragment (#...)",
  ignore_path_query: "Ignore path + query (domain only)",
  exact: "Exact full URL (keep # and ?)",
};

function newSimRule(): SimilarityRule {
  return {
    id: crypto.randomUUID(),
    pattern: "",
    pattern_type: "domain",
    rule_type: "ignore_query",
    enabled: true,
    auto_switch: false,
  };
}

type SectionKey = "theme" | "simRules" | "autoGroup" | "dataMgmt";

export function SettingsApp() {
  const [rules, setRules] = useState<AutoGroupRule[]>([]);
  const [theme, setTheme] = useState<Theme>("system");
  const [newDomain, setNewDomain] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDomain, setEditDomain] = useState("");
  const [editGroup, setEditGroup] = useState("");

  // Collapsible sections
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());
  const toggleSection = (key: SectionKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const isCollapsed = (key: SectionKey) => collapsed.has(key);

  // Unified Single-Instance rules (URL/domain-level duplicate prevention).
  const [simRules, setSimRules] = useState<SimilarityRule[]>([]);

  useEffect(() => {
    api.listAutoGroupRules().then((r) => setRules(r ?? [])).catch(() => {});
    chrome.storage.local.get("theme", (r) => {
      setTheme((r.theme as Theme) || "system");
    });
    chrome.storage.local.get("similarityRules", (r) => {
      const loaded = (r.similarityRules as any[]) || [];
      // Normalise: map old domain_pattern → pattern, add defaults.
      setSimRules(loaded.map((item: any) => ({
        id: item.id ?? crypto.randomUUID(),
        pattern: item.pattern ?? item.domain_pattern ?? "",
        pattern_type: item.pattern_type ?? "domain",
        rule_type: item.rule_type ?? "ignore_query",
        enabled: item.enabled !== false,
        auto_switch: item.auto_switch ?? false,
      })));
    });
  }, []);

  const saveSimRules = useCallback((updated: SimilarityRule[]) => {
    setSimRules(updated);
    chrome.storage.local.set({ similarityRules: updated });
  }, []);

  const changeTheme = useCallback((t: Theme) => {
    setTheme(t);
    if (t === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", t);
    }
    chrome.storage.local.set({ theme: t });
  }, []);

  const refreshRules = async () => {
    const r = await api.listAutoGroupRules();
    setRules(r ?? []);
  };

  const handleAdd = async () => {
    if (!newDomain.trim() || !newGroup.trim()) return;
    await api.createAutoGroupRule(newDomain.trim(), newGroup.trim());
    setNewDomain("");
    setNewGroup("");
    await refreshRules();
  };

  const handleDelete = async (id: number) => {
    await api.deleteAutoGroupRule(id);
    await refreshRules();
  };

  const handleToggle = async (rule: AutoGroupRule) => {
    await api.updateAutoGroupRule(rule.id, { enabled: !rule.enabled });
    await refreshRules();
  };

  const startEdit = (rule: AutoGroupRule) => {
    setEditingId(rule.id);
    setEditDomain(rule.domain_pattern);
    setEditGroup(rule.group_name);
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    await api.updateAutoGroupRule(editingId, { domain_pattern: editDomain, group_name: editGroup });
    setEditingId(null);
    await refreshRules();
  };

  const handleRunAutoGroup = async () => {
    const result = await api.runAutoGroup();
    alert(`Grouped ${result.grouped_count} tabs`);
  };

  // ── Export / Import ──────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    try {
      await api.exportData();
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!api.validateExportFormat(data)) {
        alert("Invalid export file. The file is not a valid Workspace Companion backup.");
        return;
      }

      if (!confirm(
        "This will replace ALL existing workspaces, tabs, bookmarks, and settings. " +
        "This action cannot be undone.\n\nContinue with import?"
      )) {
        return;
      }

      await api.importData(text);
      alert("Data imported successfully. The page will reload to apply changes.");
      window.location.reload();
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setImporting(false);
      // Reset file input so the same file can be re-selected
      e.target.value = "";
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, display: "flex", alignItems: "center", gap: 8 }}>
        <IconSettings size={22} /> Settings
      </h1>

      {/* Theme */}
      <section style={{ marginBottom: 32 }}>
        <h2
          onClick={() => toggleSection("theme")}
          style={{
            fontSize: 14, fontWeight: 600, marginBottom: isCollapsed("theme") ? 0 : 10,
            color: "var(--text-secondary)", cursor: "pointer", userSelect: "none",
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <span style={{ display: "inline-block", transition: "transform 0.15s", transform: isCollapsed("theme") ? "rotate(-90deg)" : "rotate(0deg)", fontSize: 10 }}>▼</span>
          Theme
        </h2>
        {!isCollapsed("theme") && (
        <div className="theme-toggle" style={{ display: "inline-flex" }}>
          <button className={`icon-btn${theme === "system" ? " active" : ""}`} onClick={() => changeTheme("system")} title="System">
            <IconMonitor size={15} />
          </button>
          <button className={`icon-btn${theme === "light" ? " active" : ""}`} onClick={() => changeTheme("light")} title="Light">
            <IconSun size={15} />
          </button>
          <button className={`icon-btn${theme === "dark" ? " active" : ""}`} onClick={() => changeTheme("dark")} title="Dark">
            <IconMoon size={15} />
          </button>
        </div>
        )}
      </section>

      {/* Single-Instance Rules — unified duplicate prevention */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h2
            onClick={() => toggleSection("simRules")}
            style={{
              fontSize: 14, fontWeight: 600, color: "var(--text-secondary)",
              cursor: "pointer", userSelect: "none",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            <span style={{ display: "inline-block", transition: "transform 0.15s", transform: isCollapsed("simRules") ? "rotate(-90deg)" : "rotate(0deg)", fontSize: 10 }}>▼</span>
            ⚡ Single-Instance Rules
          </h2>
          {!isCollapsed("simRules") && (
          <button className="btn btn-sm" onClick={() => saveSimRules([...simRules, newSimRule()])}>
            <IconPlus size={12} /> Add
          </button>
          )}
        </div>
        {!isCollapsed("simRules") && (
        <>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>
          When you open a URL matching one of these rules, the extension treats it as a duplicate.
          <br /><strong>⚡ Auto-switch</strong>: close the new tab and switch to existing silently.
          <br /><strong>Pattern types</strong>: <em>Domain</em> (entire site), <em>Exact path</em> (specific page),
          <em>Path prefix</em> (page and its sub-pages).
        </p>
        <div className="card" style={{ overflow: "hidden" }}>
          {simRules.length === 0 && (
            <div style={{ padding: "16px 12px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>
              No rules configured. Add one below to enforce single-instance mode.
            </div>
          )}
          {simRules.map((rule, idx) => (
            <div
              key={rule.id}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "8px 12px",
                borderBottom: idx < simRules.length - 1 ? "1px solid var(--border)" : "none",
                opacity: rule.enabled ? 1 : 0.45,
              }}
            >
              <input
                placeholder={rule.pattern_type === "domain" ? "Domain (github.com)" : "URL (github.com/settings)"}
                value={rule.pattern}
                onChange={(e) => {
                  const updated = [...simRules];
                  updated[idx] = { ...updated[idx]!, pattern: e.target.value };
                  saveSimRules(updated);
                }}
                style={{ flex: 1, fontSize: 12, padding: "4px 6px" }}
              />
              <select
                value={rule.pattern_type}
                onChange={(e) => {
                  const updated = [...simRules];
                  updated[idx] = { ...updated[idx]!, pattern_type: e.target.value as SimPatternType };
                  saveSimRules(updated);
                }}
                style={{ fontSize: 11, padding: "2px 2px", borderRadius: "var(--radius-xs)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
                title="Match scope"
              >
                <option value="domain">Domain</option>
                <option value="exact_path">Exact path</option>
                <option value="path_prefix">Path prefix</option>
              </select>
              <select
                value={rule.rule_type}
                onChange={(e) => {
                  const updated = [...simRules];
                  updated[idx] = { ...updated[idx]!, rule_type: e.target.value as SimRuleType };
                  saveSimRules(updated);
                }}
                style={{ fontSize: 11, padding: "4px 4px", borderRadius: "var(--radius-xs)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
                title="How to compare URLs"
              >
                {Object.entries(RULE_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button
                className="icon-btn"
                onClick={() => {
                  const updated = [...simRules];
                  updated[idx] = { ...updated[idx]!, enabled: !rule.enabled };
                  saveSimRules(updated);
                }}
                title={rule.enabled ? "Disable" : "Enable"}
                style={{ color: rule.enabled ? "var(--accent)" : "var(--text-tertiary)" }}
              >
                {rule.enabled ? "✓" : "✕"}
              </button>
              <button
                className="icon-btn"
                onClick={() => {
                  const updated = [...simRules];
                  updated[idx] = { ...updated[idx]!, auto_switch: !rule.auto_switch };
                  saveSimRules(updated);
                }}
                title={rule.auto_switch ? "Auto-switch ON — click to disable" : "Auto-switch OFF — click to enable"}
                style={{
                  color: rule.auto_switch ? "var(--accent)" : "var(--text-tertiary)",
                  fontWeight: rule.auto_switch ? 700 : 400,
                  fontSize: 11,
                  minWidth: 24,
                }}
              >
                {rule.auto_switch ? "⚡" : "—"}
              </button>
              <button
                className="icon-btn"
                onClick={() => saveSimRules(simRules.filter((_, i) => i !== idx))}
                title="Delete rule"
                style={{ color: "var(--danger)" }}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
        </>
        )}
      </section>

      {/* Auto-group rules */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h2
            onClick={() => toggleSection("autoGroup")}
            style={{
              fontSize: 14, fontWeight: 600, color: "var(--text-secondary)",
              cursor: "pointer", userSelect: "none",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            <span style={{ display: "inline-block", transition: "transform 0.15s", transform: isCollapsed("autoGroup") ? "rotate(-90deg)" : "rotate(0deg)", fontSize: 10 }}>▼</span>
            Auto-Group Rules
          </h2>
          {!isCollapsed("autoGroup") && (
          <button className="btn btn-accent btn-sm" onClick={handleRunAutoGroup}>
            Run Now
          </button>
          )}
        </div>
        {!isCollapsed("autoGroup") && (
        <>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>
          Tabs matching a domain pattern are automatically grouped.
        </p>

        <div className="card" style={{ overflow: "hidden" }}>
          {rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 12px",
                borderBottom: "1px solid var(--border)",
                opacity: rule.enabled ? 1 : 0.45,
              }}
            >
              {editingId === rule.id ? (
                <>
                  <input value={editDomain} onChange={(e) => setEditDomain(e.target.value)}
                    style={{ flex: 1, fontSize: 12, padding: "4px 6px" }} />
                  <input value={editGroup} onChange={(e) => setEditGroup(e.target.value)}
                    style={{ flex: 1, fontSize: 12, padding: "4px 6px" }}
                    onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
                  <button className="btn btn-accent btn-sm" onClick={saveEdit}>Save</button>
                  <button className="btn btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}>{rule.domain_pattern}</span>
                  <span style={{ flex: 1, fontSize: 12, color: "var(--text-secondary)" }}>→ {rule.group_name}</span>
                  <button className="icon-btn" onClick={() => handleToggle(rule)} title={rule.enabled ? "Disable" : "Enable"}
                    style={{ color: rule.enabled ? "var(--accent)" : "var(--text-tertiary)" }}>
                    {rule.enabled ? "✓" : "✕"}
                  </button>
                  <button className="icon-btn" onClick={() => startEdit(rule)} title="Edit">
                    <IconEdit size={13} />
                  </button>
                  <button className="icon-btn" onClick={() => handleDelete(rule.id)} title="Delete"
                    style={{ color: "var(--danger)" }}>
                    <IconTrash size={13} />
                  </button>
                </>
              )}
            </div>
          ))}

          <div style={{ display: "flex", gap: 6, padding: "8px 12px", alignItems: "center" }}>
            <input
              placeholder="Domain (e.g. github.com)"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              style={{ flex: 1, fontSize: 12, padding: "5px 8px" }}
            />
            <input
              placeholder="Group name"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              style={{ flex: 1, fontSize: 12, padding: "5px 8px" }}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
            <button className="btn btn-accent btn-sm" onClick={handleAdd}>
              <IconPlus size={12} /> Add
            </button>
          </div>
        </div>
        </>
        )}
      </section>

      {/* Data Management */}
      <section style={{ marginBottom: 32 }}>
        <h2
          onClick={() => toggleSection("dataMgmt")}
          style={{
            fontSize: 14, fontWeight: 600, marginBottom: isCollapsed("dataMgmt") ? 0 : 10,
            color: "var(--text-secondary)", cursor: "pointer", userSelect: "none",
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <span style={{ display: "inline-block", transition: "transform 0.15s", transform: isCollapsed("dataMgmt") ? "rotate(-90deg)" : "rotate(0deg)", fontSize: 10 }}>▼</span>
          Data Management
        </h2>
        {!isCollapsed("dataMgmt") && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
              Export all workspaces, tabs, bookmarks, and settings to a JSON backup file.
              You can later import this file to restore your data or migrate between browsers.
              <br />
              <strong style={{ color: "var(--danger)" }}>
                Importing replaces ALL existing data. Make a backup first.
              </strong>
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-accent btn-sm" onClick={handleExport}>
                <IconDownload size={12} /> Export Data
              </button>
              <button
                className="btn btn-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                <IconUpload size={12} /> {importing ? "Importing..." : "Import Data"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                style={{ display: "none" }}
                onChange={handleFileImport}
              />
            </div>
          </div>
        </div>
        )}
      </section>
    </div>
  );
}

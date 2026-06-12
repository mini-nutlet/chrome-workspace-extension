import { useState, useEffect, useCallback } from "react";
import type { AutoGroupRule, SimilarityRule, SimRuleType } from "../lib/types";
import type { Theme } from "../lib/context";
import * as api from "../lib/api";
import { IconPlus, IconEdit, IconTrash, IconMonitor, IconSun, IconMoon, IconSettings } from "../components/Icons";

// ── Similarity rule helpers ─────────────────────────────────────────────

const RULE_TYPE_LABELS: Record<SimRuleType, string> = {
  ignore_query: "Ignore query params (?...)",
  ignore_hash: "Ignore hash fragment (#...)",
  ignore_path_query: "Ignore path + query (domain only)",
};

function newSimRule(): SimilarityRule {
  return {
    id: crypto.randomUUID(),
    domain_pattern: "",
    rule_type: "ignore_query",
    enabled: true,
    auto_switch: false,
  };
}

export function SettingsApp() {
  const [rules, setRules] = useState<AutoGroupRule[]>([]);
  const [theme, setTheme] = useState<Theme>("system");
  const [newDomain, setNewDomain] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDomain, setEditDomain] = useState("");
  const [editGroup, setEditGroup] = useState("");

  // Similarity rules (Opt 24)
  const [simRules, setSimRules] = useState<SimilarityRule[]>([]);

  useEffect(() => {
    api.listAutoGroupRules().then((r) => setRules(r ?? [])).catch(() => {});
    chrome.storage.local.get("theme", (r) => {
      setTheme((r.theme as Theme) || "system");
    });
    chrome.storage.local.get("similarityRules", (r) => {
      setSimRules((r.similarityRules as SimilarityRule[]) || []);
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

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, display: "flex", alignItems: "center", gap: 8 }}>
        <IconSettings size={22} /> Settings
      </h1>

      {/* Theme */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: "var(--text-secondary)" }}>Theme</h2>
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
      </section>

      {/* Similarity Rules (Opt 24) */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>Similarity Rules</h2>
          <button className="btn btn-sm" onClick={() => saveSimRules([...simRules, newSimRule()])}>
            <IconPlus size={12} /> Add
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>
          Custom rules override the default URL-hash duplicate detection. Matched by domain.<br />
          <strong>⚡ Auto-switch</strong>: when a duplicate is detected, immediately switch to the
          existing tab without showing a notification.
        </p>
        <div className="card" style={{ overflow: "hidden" }}>
          {simRules.length === 0 && (
            <div style={{ padding: "16px 12px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>
              No custom rules. Default hash-based matching is used.
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
                placeholder="Domain (e.g. github.com)"
                value={rule.domain_pattern}
                onChange={(e) => {
                  const updated = [...simRules];
                  updated[idx] = { ...updated[idx]!, domain_pattern: e.target.value };
                  saveSimRules(updated);
                }}
                style={{ flex: 1, fontSize: 12, padding: "4px 6px" }}
              />
              <select
                value={rule.rule_type}
                onChange={(e) => {
                  const updated = [...simRules];
                  updated[idx] = { ...updated[idx]!, rule_type: e.target.value as SimRuleType };
                  saveSimRules(updated);
                }}
                style={{ fontSize: 11, padding: "4px 4px", borderRadius: "var(--radius-xs)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
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
      </section>

      {/* Auto-group rules */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>Auto-Group Rules</h2>
          <button className="btn btn-accent btn-sm" onClick={handleRunAutoGroup}>
            Run Now
          </button>
        </div>
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
      </section>
    </div>
  );
}

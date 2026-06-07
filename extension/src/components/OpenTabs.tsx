import { useEffect, useState } from "react";
import type { SearchResult } from "../lib/types";
import * as api from "../lib/api";

interface OpenTabsProps {
  workspaceId: number;
  onNavigate: (url: string, kind: string) => void;
}

export function OpenTabs({ workspaceId, onNavigate }: OpenTabsProps) {
  const [tabs, setTabs] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    api
      .search("", workspaceId, 20)
      .then((r) => r.filter((s) => s.kind === "tab"))
      .then(setTabs)
      .catch(() => setTabs([]));
  }, [workspaceId]);

  if (tabs.length === 0) return null;

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
          OPEN TABS ({tabs.length})
        </span>
        <span style={{ color: "var(--text-secondary)" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div>
          {tabs.map((t) => (
            <div
              key={t.id}
              className="list-item"
              onClick={() => onNavigate(t.url, "tab")}
            >
              <img
                src={`https://www.google.com/s2/favicons?domain=${new URL(t.url).hostname}&sz=16`}
                alt=""
                width={16}
                height={16}
                style={{ borderRadius: 2 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title || t.url}
                </div>
              </div>
              {t.active && <span className="badge badge-active">ACTIVE</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

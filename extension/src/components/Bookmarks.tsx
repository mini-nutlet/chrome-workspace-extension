import { useEffect, useState } from "react";
import type { Bookmark } from "../lib/types";
import * as api from "../lib/api";

interface BookmarksProps {
  workspaceId: number;
  onNavigate: (url: string, kind: string) => void;
}

export function Bookmarks({ workspaceId, onNavigate }: BookmarksProps) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    api
      .listBookmarks(workspaceId)
      .then(setBookmarks)
      .catch(() => setBookmarks([]));
  }, [workspaceId]);

  if (bookmarks.length === 0) return null;

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
          BOOKMARKS ({bookmarks.length})
        </span>
        <span style={{ color: "var(--text-secondary)" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div>
          {bookmarks.map((b) => (
            <div
              key={b.id}
              className="list-item"
              onClick={() => onNavigate(b.url, "bookmark")}
            >
              <img
                src={`https://www.google.com/s2/favicons?domain=${new URL(b.url).hostname}&sz=16`}
                alt=""
                width={16}
                height={16}
                style={{ borderRadius: 2 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.title || b.url}
                </div>
                {b.tags && (
                  <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                    {b.tags.split(",").map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "var(--surface-hover)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {tag.trim()}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="btn btn-sm"
                style={{ color: "var(--danger)" }}
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.deleteBookmark(b.id);
                  setBookmarks((prev) => prev.filter((x) => x.id !== b.id));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

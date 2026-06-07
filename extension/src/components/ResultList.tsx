import type { SearchResult } from "../lib/types";

interface ResultListProps {
  results: SearchResult[];
  loading: boolean;
  onNavigate: (url: string, kind: string) => void;
}

const KIND_CLASS: Record<string, string> = {
  tab: "badge-tab",
  bookmark: "badge-bookmark",
  history: "badge-tab",
};

const KIND_LABEL: Record<string, string> = {
  tab: "Tab",
  bookmark: "Bookmark",
  history: "History",
};

export function ResultList({ results, loading, onNavigate }: ResultListProps) {
  if (loading && results.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">Searching…</div>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">No results found</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {results.map((r) => {
        const isOpen = (r as any).is_open === true;
        const isActive = r.active === true;
        return (
        <div
          key={`${r.kind}-${r.id}`}
          className="search-result"
          onClick={() => onNavigate(r.url, r.kind)}
        >
          <span className={`badge ${KIND_CLASS[r.kind] ?? "badge-tab"}`}>
            {KIND_LABEL[r.kind] ?? r.kind}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="search-result-title">
              {r.title || r.url}
              {((r as any).open_count ?? 0) > 1 && (
                <span className="badge" style={{ background: "var(--text-tertiary)", color: "#fff", fontSize: 10, marginLeft: 4 }}>×{(r as any).open_count}</span>
              )}
              {isOpen && (
                <span className="tab-open-dot" title="Open in browser" style={{ marginLeft: 4 }}>
                  <svg width="8" height="8" viewBox="0 0 8 8">
                    <circle cx="4" cy="4" r="4" fill="currentColor" />
                  </svg>
                </span>
              )}
              {isActive && <span className="badge badge-active">ACTIVE</span>}
            </div>
            <div className="search-result-url">{r.url}</div>
          </div>
        </div>
        );
      })}
    </div>
  );
}

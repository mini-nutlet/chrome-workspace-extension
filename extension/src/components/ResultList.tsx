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

/**
 * Split text into segments, wrapping matched character ranges in
 * <span className="search-highlight"> elements.
 */
function highlightMatches(
  text: string,
  indices?: Array<{ start: number; end: number }>
): React.ReactNode {
  if (!indices || indices.length === 0) return text;

  // Sort and merge overlapping / adjacent indices for clean rendering.
  const sorted = [...indices].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && r.start <= prev.end) {
      prev.end = Math.max(prev.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  const segments: React.ReactNode[] = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor) {
      segments.push(text.slice(cursor, r.start));
    }
    segments.push(
      <span key={r.start} className="search-highlight">
        {text.slice(r.start, r.end)}
      </span>
    );
    cursor = r.end;
  }
  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }

  return <>{segments}</>;
}

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
              {highlightMatches(r.title || r.url, r.match_indices)}
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

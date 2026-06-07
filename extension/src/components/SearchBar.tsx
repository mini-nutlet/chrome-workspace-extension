interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
}

export function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        placeholder="Search tabs, bookmarks, history…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
        style={{
          width: "100%",
          padding: "14px 18px",
          fontSize: 16,
          borderRadius: 10,
        }}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 18,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

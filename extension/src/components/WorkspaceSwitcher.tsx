import { useState } from "react";
import type { Workspace } from "../lib/types";
import * as api from "../lib/api";

interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  currentId: number;
  onSwitch: (id: number) => void;
  onRefresh: () => void;
}

export function WorkspaceSwitcher({
  workspaces,
  currentId,
  onSwitch,
  onRefresh,
}: WorkspaceSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api.createWorkspace(trimmed);
      setName("");
      setCreating(false);
      onRefresh();
    } catch {
      // Show error in UI later; for now just bail.
    }
  };

  const handleDelete = async (id: number) => {
    await api.deleteWorkspace(id);
    if (currentId === id) onSwitch(0);
    onRefresh();
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
          WORKSPACES
        </span>
        <button className="btn btn-sm" onClick={() => setCreating(!creating)}>
          {creating ? "Cancel" : "+ New"}
        </button>
      </div>

      {creating && (
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            placeholder="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            style={{ flex: 1 }}
            autoFocus
          />
          <button className="btn btn-accent btn-sm" onClick={handleCreate}>
            Create
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button
          className={`btn btn-sm${currentId === 0 ? " btn-accent" : ""}`}
          onClick={() => onSwitch(0)}
        >
          All
        </button>
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            className={`btn btn-sm${currentId === ws.id ? " btn-accent" : ""}`}
            onClick={() => onSwitch(ws.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              handleDelete(ws.id);
            }}
            title={`${ws.description || ws.name} — right-click to delete`}
          >
            {ws.icon && <span>{ws.icon}</span>}
            {ws.name}
          </button>
        ))}
      </div>
    </div>
  );
}

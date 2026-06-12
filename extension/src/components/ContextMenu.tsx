import React, { useEffect, useRef, useState, useCallback } from "react";
import { IconWindow, IconEdit, IconTrash, IconFolderPlus } from "./Icons";

export interface MenuAction {
  kind: "openAll" | "rename" | "delete" | "addSub";
  label: string;
  icon: (size: number) => React.ReactNode;
  danger?: boolean;
}

const MENU_ACTIONS: Record<string, MenuAction> = {
  openAll:  { kind: "openAll", label: "Open All Tabs",   icon: (s) => <IconWindow size={s} /> },
  addSub:   { kind: "addSub",  label: "Add Sub Workspace",icon: (s) => <IconFolderPlus size={s} /> },
  rename:   { kind: "rename",  label: "Rename",           icon: (s) => <IconEdit size={s} /> },
  delete:   { kind: "delete",  label: "Delete Workspace", icon: (s) => <IconTrash size={s} />, danger: true },
};

interface ContextMenuProps {
  x: number;
  y: number;
  isTopLevel: boolean;
  /** Current workspace: no delete, no rename, no add-sub (Opt 20) */
  isCurrent?: boolean;
  onSelect: (kind: MenuAction["kind"]) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, isTopLevel, isCurrent, onSelect, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doClose = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 150); // wait for animation
  }, [onClose]);

  // Click outside → close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        doClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") doClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [doClose]);

  // Mouse leave → delayed close with animation (Opt 23)
  const handleMouseLeave = () => {
    closeTimer.current = setTimeout(doClose, 400);
  };
  const handleMouseEnter = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
  };

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  // Adjust position so the menu doesn't overflow the viewport.
  // Measure after first paint so the ref is available — inline
  // measurement during render would always see `null`.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const adjusted = { left: x, top: y };
    if (rect.right > window.innerWidth) adjusted.left = x - rect.width;
    if (rect.bottom > window.innerHeight) adjusted.top = y - rect.height;
    setPos(adjusted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  const style: React.CSSProperties = { left: pos.left, top: pos.top };

  // Current workspace (Opt 20): no actions available — permanent & independent.
  let kinds: MenuAction["kind"][];
  if (isCurrent) {
    kinds = []; // locked down
  } else if (isTopLevel) {
    kinds = ["openAll", "addSub", "rename", "delete"];
  } else {
    kinds = ["openAll", "rename", "delete"];
  }

  if (kinds.length === 0) return null;

  return (
    <div
      className={`context-menu${closing ? " context-menu-closing" : ""}`}
      ref={ref}
      style={style}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
    >
      {kinds.map((kind) => {
        const action = MENU_ACTIONS[kind]!;
        return (
          <div
            key={kind}
            className={`context-menu-item${action.danger ? " danger" : ""}`}
            onClick={() => onSelect(kind)}
          >
            <span className="context-menu-icon">{action.icon(14)}</span>
            <span>{action.label}</span>
          </div>
        );
      })}
    </div>
  );
}

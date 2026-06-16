import { useEffect, useState } from "react";
import { AppProvider, useApp } from "../lib/context";
import { Sidebar } from "../components/Sidebar";
import { MainContent } from "../components/MainContent";
import { TabPicker } from "../components/TabPicker";
import "./index.css";

function AppLayout({ defaultSidebarCollapsed = false }: { defaultSidebarCollapsed?: boolean }) {
  const { tabPickerOpen, setTabPickerOpen } = useApp();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(defaultSidebarCollapsed);

  // Ctrl+T opens the newtab page — auto-focus the search bar so the
  // user can start typing immediately.  Retry once if the first attempt
  // fires before the Sidebar has rendered its input.
  useEffect(() => {
    const attempt = (delay: number) => setTimeout(() => {
      chrome.runtime.sendMessage({ type: "focus-search" }).catch(() => {});
    }, delay);
    const t1 = attempt(100);
    const t2 = attempt(400); // fallback if first attempt misses
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  return (
    <div className={`app-layout${tabPickerOpen ? " has-picker" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar />
      <div
        className="sidebar-toggle"
        title={sidebarCollapsed ? "Show workspace sidebar" : "Hide workspace sidebar"}
        onClick={() => setSidebarCollapsed((v) => !v)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
        >
          <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <MainContent />
      {tabPickerOpen && (
        <TabPicker open={tabPickerOpen} onClose={() => setTabPickerOpen(false)} />
      )}
    </div>
  );
}

export function App({ defaultSidebarCollapsed = false }: { defaultSidebarCollapsed?: boolean }) {
  return (
    <AppProvider>
      <AppLayout defaultSidebarCollapsed={defaultSidebarCollapsed} />
    </AppProvider>
  );
}

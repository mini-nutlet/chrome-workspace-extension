import { useEffect } from "react";
import { AppProvider, useApp } from "../lib/context";
import { Sidebar } from "../components/Sidebar";
import { MainContent } from "../components/MainContent";
import { TabPicker } from "../components/TabPicker";
import "./index.css";

function AppLayout() {
  const { tabPickerOpen, setTabPickerOpen } = useApp();

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
    <div className={`app-layout${tabPickerOpen ? " has-picker" : ""}`}>
      <Sidebar />
      <MainContent />
      {tabPickerOpen && (
        <TabPicker open={tabPickerOpen} onClose={() => setTabPickerOpen(false)} />
      )}
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <AppLayout />
    </AppProvider>
  );
}

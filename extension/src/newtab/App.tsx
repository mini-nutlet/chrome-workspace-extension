import { AppProvider, useApp } from "../lib/context";
import { Sidebar } from "../components/Sidebar";
import { MainContent } from "../components/MainContent";
import { TabPicker } from "../components/TabPicker";
import "./index.css";

function AppLayout() {
  const { tabPickerOpen, setTabPickerOpen } = useApp();

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

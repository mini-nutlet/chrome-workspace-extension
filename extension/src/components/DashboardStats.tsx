import { useEffect, useState, useCallback, useRef } from "react";
import * as api from "../lib/api";

interface StatsData {
  totalTabs: number;
  duplicateTabs: number;
  activeBrowserTabs: number;
  topDomains: { domain: string; count: number }[];
}

export function DashboardStats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [totalTabs, duplicateTabs, activeBrowserTabs, topDomains] = await Promise.all([
        api.countAllTabs(),
        api.countDuplicateTabs(),
        api.countActiveBrowserTabs(),
        api.topDomains(3),
      ]);
      if (!cancelledRef.current) {
        setStats({ totalTabs, duplicateTabs, activeBrowserTabs, topDomains });
      }
    } catch { /* keep current state */ }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    load();

    // Refresh whenever the background reports a tab/window change.
    const onMessage = (msg: { type: string }) => {
      if (msg.type === "tabs-changed") load();
    };
    chrome.runtime.onMessage.addListener(onMessage);

    return () => {
      cancelledRef.current = true;
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [load]);

  if (!stats) return null;

  return (
    <div className="dashboard-stats">
      <div className="stat-card">
        <div className="stat-card-value">{stats.totalTabs}</div>
        <div className="stat-card-label">Open Tabs</div>
      </div>
      <div className="stat-card">
        <div className="stat-card-value">{stats.duplicateTabs}</div>
        <div className="stat-card-label">Duplicates</div>
      </div>
      <div className="stat-card">
        <div className="stat-card-value">{stats.activeBrowserTabs}</div>
        <div className="stat-card-label">Windows</div>
      </div>
      <div className="stat-card stat-card-domains">
        <div className="stat-card-label">Top Domains</div>
        <div className="stat-card-domain-list">
          {stats.topDomains.map((d, i) => (
            <div key={d.domain} className="stat-card-domain-row">
              <span className="stat-card-domain-rank">{i + 1}</span>
              <span className="stat-card-domain-name">{d.domain}</span>
              <span className="stat-card-domain-count">{d.count}</span>
            </div>
          ))}
          {stats.topDomains.length === 0 && (
            <div className="stat-card-domain-empty">No data</div>
          )}
        </div>
      </div>
    </div>
  );
}

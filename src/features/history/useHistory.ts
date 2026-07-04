import { useState, useEffect, useCallback } from "react";
import { getHistory, getStats, deleteHistoryItem } from "@/lib/tauriCommands";
import type { HistoryFilter, HistorySearchTarget, PlaybackHistory, Stats, StatsPeriod } from "@/shared/types";

export function useHistory() {
  const [history, setHistory] = useState<PlaybackHistory[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [period, setPeriod] = useState<StatsPeriod>({ type: "week" });
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [loading, setLoading] = useState(false);

  const loadHistory = useCallback(async (f: HistoryFilter) => {
    setLoading(true);
    try {
      const data = await getHistory(f);
      setHistory(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async (p: StatsPeriod) => {
    try {
      const data = await getStats(p);
      setStats(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadHistory(filter); }, [loadHistory, filter]);
  useEffect(() => { loadStats(period); }, [loadStats, period]);

  const search = useCallback((keyword: string, target: HistorySearchTarget = "all") => {
    setFilter((f) => ({
      ...f,
      search: keyword || undefined,
      searchTarget: keyword ? target : undefined,
    }));
  }, []);

  const removeHistoryItem = useCallback(async (id: number) => {
    setHistory((prev) => prev.filter((item) => item.id !== id));
    try {
      await deleteHistoryItem(id);
      await loadStats(period);
    } catch { /* ignore */ }
  }, [loadStats, period]);

  const filterByDate = useCallback((date: string | null) => {
    if (!date) { setFilter({}); return; }
    // completed_at は RFC3339 形式（例: "2025-05-15T12:34:56+00:00"）のため
    // "2025-05-15T..." > "2025-05-15" となり <= "2025-05-15" では全件除外される。
    // Date.UTC で UTC 基準の翌日を計算し toDate = "2025-05-16" とすることで
    // completed_at <= "2025-05-16" が当日全件を正しく含む。
    // new Date(date + "T00:00:00") はローカル TZ で解釈されるため使用しない。
    const [y, m, d] = date.split("-").map(Number);
    const toDate = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    setFilter({ fromDate: date, toDate });
  }, []);

  return {
    history,
    stats,
    period,
    loading,
    search,
    setPeriod,
    filterByDate,
    removeHistoryItem,
  };
}

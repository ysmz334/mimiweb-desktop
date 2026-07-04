import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Star, Play, X } from "lucide-react";
import { useHistory } from "./useHistory";
import { getStats } from "@/lib/tauriCommands";
import { Favicon } from "@/shared/Favicon";
import { wordCloudBus } from "@/shared/wordCloudBus";
import { markSelfCopied } from "@/features/clipboard/useClipboardMonitor";
import type { Article, HistorySearchTarget, PlaybackHistory, Stats, StatsPeriod } from "@/shared/types";

// ─── 日付ユーティリティ ────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function formatGroupDate(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === today) return "今日";
  if (dateStr === yesterday) return "昨日";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function groupHistoryByDate(
  items: PlaybackHistory[]
): { dateStr: string; label: string; items: PlaybackHistory[] }[] {
  const map = new Map<string, PlaybackHistory[]>();
  for (const item of items) {
    const key = item.completedAt.slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return Array.from(map.entries()).map(([dateStr, items]) => ({
    dateStr,
    label: formatGroupDate(dateStr),
    items,
  }));
}

// ─── 折りたたみセクション ─────────────────────────────────────────────────

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 20 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--border)",
          borderRadius: 0,
          cursor: "pointer",
          padding: "2px 0 8px",
          marginBottom: open ? 14 : 0,
          textAlign: "left",
          color: "var(--text)",
          fontFamily: "inherit",
          boxShadow: "none",
          fontSize: "inherit",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1, flexShrink: 0 }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      </button>
      {open && children}
    </div>
  );
}

// ─── 再生カレンダー ────────────────────────────────────────────────────────

const CELL = 11;
const GAP = 2;
const STEP = CELL + GAP;
const DAY_LABEL_W = 20;
const NUM_WEEKS = 53;
const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
const DOW_LABELS = ["", "月", "", "水", "", "金", ""];

function calColor(seconds: number): string {
  if (seconds <= 0)   return "var(--cal-empty)";
  if (seconds < 300)  return "var(--cal-l1)";
  if (seconds < 900)  return "var(--cal-l2)";
  if (seconds < 1800) return "var(--cal-l3)";
  return "var(--cal-l4)";
}

interface CalCell {
  date: string;
  seconds: number; // -1 = 未来
  month: number;
}

function buildCalendarGrid(today: Date, dataMap: Map<string, number>): CalCell[][] {
  const dow = today.getDay();
  const weekSun = new Date(today);
  weekSun.setDate(today.getDate() - dow);
  const gridStart = new Date(weekSun);
  gridStart.setDate(weekSun.getDate() - (NUM_WEEKS - 1) * 7);

  return Array.from({ length: NUM_WEEKS }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + w * 7 + d);
      const isFuture = date > today;
      const dateStr = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("-");
      return {
        date: dateStr,
        seconds: isFuture ? -1 : (dataMap.get(dateStr) ?? 0),
        month: date.getMonth(),
      };
    })
  );
}

function PlaybackCalendar({
  breakdown,
  selectedDate,
  onDateClick,
  onDateHover,
}: {
  breakdown: Array<{ date: string; count: number; totalSeconds: number }>;
  selectedDate?: string | null;
  onDateClick?: (date: string) => void;
  onDateHover?: (date: string | null) => void;
}) {
  const [tooltip, setTooltip] = useState<{ rect: DOMRect; date: string; seconds: number } | null>(null);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const weeks = useMemo(() => {
    const dataMap = new Map(breakdown.map((d) => [d.date, d.totalSeconds]));
    return buildCalendarGrid(today, dataMap);
  }, [today, breakdown]);

  const monthLabels = useMemo(
    () =>
      weeks.map((week, w) => {
        const m = week[0].month;
        if (w === 0) return MONTH_NAMES[m];
        return weeks[w - 1][0].month !== m ? MONTH_NAMES[m] : "";
      }),
    [weeks]
  );

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {/* 月ラベル */}
      <div style={{ display: "flex", marginLeft: DAY_LABEL_W + GAP, marginBottom: 2 }}>
        {monthLabels.map((label, w) => (
          <div
            key={w}
            style={{
              width: STEP,
              fontSize: 9,
              color: "var(--text-muted)",
              overflow: "visible",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {label}
          </div>
        ))}
      </div>

      {/* 曜日行 × NUM_WEEKS週のセルグリッド */}
      {DOW_LABELS.map((dayLabel, dow) => (
        <div
          key={dow}
          style={{
            display: "flex",
            alignItems: "center",
            gap: GAP,
            marginBottom: dow < 6 ? GAP : 0,
          }}
        >
          <div
            style={{
              width: DAY_LABEL_W,
              fontSize: 9,
              color: "var(--text-muted)",
              textAlign: "right",
              lineHeight: `${CELL}px`,
              flexShrink: 0,
            }}
          >
            {dayLabel}
          </div>
          {weeks.map((week, w) => {
            const cell = week[dow];
            const isFuture = cell.seconds < 0;
            const isSelected = cell.date === selectedDate;
            return (
              <div
                key={w}
                style={{
                  width: CELL,
                  height: CELL,
                  borderRadius: 2,
                  background: isFuture ? "transparent" : calColor(cell.seconds),
                  flexShrink: 0,
                  cursor: isFuture ? "default" : "pointer",
                  boxShadow: isSelected ? "0 0 0 2px var(--accent)" : "none",
                }}
                onClick={() => !isFuture && onDateClick?.(cell.date)}
                onMouseEnter={(e) => {
                  if (isFuture) return;
                  setTooltip({ rect: e.currentTarget.getBoundingClientRect(), date: cell.date, seconds: cell.seconds });
                  onDateHover?.(cell.date);
                }}
                onMouseLeave={() => {
                  setTooltip(null);
                  onDateHover?.(null);
                }}
              />
            );
          })}
        </div>
      ))}

      {/* 凡例 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginTop: 6,
          marginLeft: DAY_LABEL_W + GAP,
          fontSize: 10,
          color: "var(--text-muted)",
        }}
      >
        <span>少</span>
        {(["var(--cal-empty)", "var(--cal-l1)", "var(--cal-l2)", "var(--cal-l3)", "var(--cal-l4)"] as const).map(
          (color, i) => (
            <div
              key={i}
              style={{ width: CELL, height: CELL, borderRadius: 2, background: color, flexShrink: 0 }}
            />
          )
        )}
        <span>多</span>
      </div>

      {/* ツールチップ */}
      {tooltip && (
        <div
          style={{
            position: "fixed",
            top: tooltip.rect.top < 40 ? tooltip.rect.bottom + 4 : tooltip.rect.top - 26,
            left: tooltip.rect.left + CELL / 2,
            transform: "translateX(-50%)",
            background: "rgba(10,10,10,0.85)",
            color: "#f0f0f0",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 11,
            whiteSpace: "nowrap",
            zIndex: 1000,
            pointerEvents: "none",
          }}
        >
          {tooltip.date}　{tooltip.seconds > 0 ? formatDuration(tooltip.seconds) : "再生なし"}
        </div>
      )}
    </div>
  );
}

// ─── 統計ビュー ───────────────────────────────────────────────────────────

function StatsView({
  stats,
  period,
  onPeriodChange,
}: {
  stats: Stats | null;
  period: StatsPeriod;
  onPeriodChange: (p: StatsPeriod) => void;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button
          style={{ fontWeight: period.type === "week" ? 700 : 400 }}
          onClick={() => onPeriodChange({ type: "week" })}
        >
          今週
        </button>
        <button
          style={{ fontWeight: period.type === "month" ? 700 : 400 }}
          onClick={() => onPeriodChange({ type: "month" })}
        >
          今月
        </button>
      </div>
      {stats && (
        <div style={{ display: "flex", gap: 24, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{stats.totalPlayed}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>記事数</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {Math.round(stats.totalSeconds / 60)}分
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>合計再生時間</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 履歴行 ──────────────────────────────────────────────────────────────

function HistoryRow({
  item,
  onSelect,
  onDoubleClickPlay,
  onArticleContextMenu,
  onDelete,
}: {
  item: PlaybackHistory;
  onSelect?: (article: Article) => void;
  onDoubleClickPlay?: (articleId: number) => void;
  onArticleContextMenu?: (url: string, x: number, y: number) => void;
  onDelete?: (id: number) => void;
}) {
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasArticle = item.article !== null;

  function handleClick() {
    if (!hasArticle || !onSelect) return;
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onSelect(item.article!);
    }, 220);
  }

  function handleDoubleClick() {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (item.article) {
      onDoubleClickPlay?.(item.article.id);
    }
  }

  const isCompleted =
    item.lastSentenceIndex !== null &&
    item.sentenceCount !== null &&
    item.lastSentenceIndex + 1 >= item.sentenceCount;

  const hasProgress = item.lastSentenceIndex !== null && item.sentenceCount !== null;

  const progressColor = hasProgress
    ? isCompleted
      ? "var(--success)"
      : "var(--warning)"
    : "var(--text-muted)";

  const progressText = hasProgress
    ? isCompleted
      ? `全${item.sentenceCount}文 完了`
      : `第${item.lastSentenceIndex! + 1}文 / 全${item.sentenceCount}文`
    : null;

  const playedAt = item.startedAt ?? item.completedAt;

  return (
    <li
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseLeave={() => wordCloudBus.cancelPending()}
      onContextMenu={(e) => {
        const url = item.article?.url;
        if (!url) return;
        e.preventDefault();
        onArticleContextMenu?.(url, e.clientX, e.clientY);
      }}
      style={{
        padding: "8px 4px",
        borderBottom: "1px solid var(--border-light)",
        cursor: hasArticle && (onSelect || onDoubleClickPlay) ? "pointer" : "default",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      {item.article?.url && <Favicon url={item.article.url} size={14} />}
      {item.article?.language === "en" && (
        <span style={{ fontSize: 10, fontWeight: 700, color: "#0066cc", background: "#e8f0fe", borderRadius: 3, padding: "0 4px", flexShrink: 0 }}>EN</span>
      )}
      <div
        style={{ flex: 1, overflow: "hidden" }}
        onMouseEnter={() => {
          if (item.articleId !== null) {
            wordCloudBus.hover(item.articleId, item.article?.title ?? null, item.article?.url ?? null);
          }
        }}
      >
        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 2 }}>
          {item.article?.title ?? item.article?.url ?? "（タイトル不明）"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
          <span>{formatDateTime(playedAt)}</span>
          <span>再生時間: {formatDuration(item.durationSeconds)}</span>
          {progressText && (
            <span style={{ color: progressColor, fontWeight: 600 }}>
              {progressText}
            </span>
          )}
        </div>
      </div>
      {item.article && onDoubleClickPlay && (
        <button
          onClick={(e) => { e.stopPropagation(); onDoubleClickPlay(item.article!.id); }}
          title="もう一度再生"
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--success)",
            fontWeight: 600,
            fontSize: 12,
            padding: "2px 6px",
            lineHeight: 1,
            boxShadow: "none",
            borderRadius: 3,
            alignSelf: "center",
            whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 4,
          }}
        >
          <Play size={11} fill="currentColor" strokeWidth={0} /> また聴く
        </button>
      )}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
          title="履歴から削除"
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            padding: "2px 4px",
            lineHeight: 1,
            boxShadow: "none",
            borderRadius: 3,
            alignSelf: "center",
            display: "inline-flex", alignItems: "center",
          }}
        >
          <X size={13} />
        </button>
      )}
    </li>
  );
}

// ─── 日付セクションヘッダー ───────────────────────────────────────────────

function DateSectionHeader({
  label,
  dateStr,
  urls,
  onHover,
}: {
  label: string;
  dateStr: string;
  urls: string[];
  onHover?: (dateStr: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    const text = urls.join("\n");
    markSelfCopied(text);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <li
      onMouseEnter={() => onHover?.(dateStr)}
      onMouseLeave={() => onHover?.(null)}
      style={{
        padding: "6px 4px 4px",
        fontSize: 11,
        fontWeight: 700,
        color: "var(--text-muted, #888)",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        borderBottom: "1px solid var(--border-light, #eee)",
        background: "var(--surface, transparent)",
        position: "sticky",
        top: 0,
        zIndex: 1,
        cursor: "default",
        display: "flex",
        alignItems: "center",
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      <button
        onClick={handleCopy}
        style={{
          fontSize: 10, padding: "1px 6px", borderRadius: 3,
          border: "1px solid var(--border)", background: "none",
          color: copied ? "var(--success)" : "var(--text-muted)",
          cursor: "pointer", boxShadow: "none",
          fontWeight: 400, letterSpacing: 0, textTransform: "none",
          transition: "color 0.2s",
        }}
      >
        {copied ? "✓ コピー済み" : "URL一括コピー"}
      </button>
    </li>
  );
}

// ─── メインパネル ─────────────────────────────────────────────────────────

type PlayedAge = "all" | "week+" | "month+" | "quarter+";
type SortMode = "date-desc" | "date-asc" | "title-asc";

export function HistoryPanel({
  onSelectArticle,
  onDoubleClickPlay,
  onArticleContextMenu,
  externalSearch,
  onSearchChange,
}: {
  onSelectArticle?: (article: Article) => void;
  onDoubleClickPlay?: (articleId: number) => void;
  onArticleContextMenu?: (url: string, x: number, y: number) => void;
  externalSearch?: string;
  onSearchChange?: (text: string) => void;
} = {}) {
  const { history, stats, period, loading, search, setPeriod, filterByDate, removeHistoryItem } = useHistory();
  const [searchText, setSearchText] = useState("");
  const [searchTarget, setSearchTarget] = useState<HistorySearchTarget>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [playedAge, setPlayedAge] = useState<PlayedAge>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("date-desc");

  const dedupedHistory = useMemo(() => {
    const seen = new Set<number>();
    return history.filter(item => {
      if (item.articleId === null) return true;
      if (seen.has(item.articleId)) return false;
      seen.add(item.articleId);
      return true;
    });
  }, [history]);

  // フロントエンド側フィルタ・ソート
  const filteredHistory = useMemo(() => {
    let list = dedupedHistory;

    if (playedAge !== "all") {
      const d = new Date();
      if (playedAge === "week+") d.setDate(d.getDate() - 7);
      else if (playedAge === "month+") d.setDate(d.getDate() - 30);
      else if (playedAge === "quarter+") d.setDate(d.getDate() - 90);
      d.setHours(0, 0, 0, 0);
      const cutoff = d.toISOString();
      list = list.filter(item => (item.startedAt ?? item.completedAt) < cutoff);
    }

    if (favoriteOnly) {
      list = list.filter(item => item.article?.isFavorite === true);
    }

    if (sortMode !== "date-desc") {
      list = [...list].sort((a, b) => {
        if (sortMode === "title-asc") {
          const ta = a.article?.title ?? a.article?.url ?? "";
          const tb = b.article?.title ?? b.article?.url ?? "";
          return ta.localeCompare(tb, "ja");
        }
        const da = a.startedAt ?? a.completedAt;
        const db = b.startedAt ?? b.completedAt;
        return da.localeCompare(db);
      });
    }

    return list;
  }, [dedupedHistory, playedAge, favoriteOnly, sortMode]);

  const [calBreakdown, setCalBreakdown] = useState<
    Array<{ date: string; count: number; totalSeconds: number }>
  >([]);

  useEffect(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const weekSun = new Date(today);
    weekSun.setDate(today.getDate() - dow);
    const gridStart = new Date(weekSun);
    gridStart.setDate(weekSun.getDate() - (NUM_WEEKS - 1) * 7);

    const toStr = today.toISOString().slice(0, 10);
    const fromStr = gridStart.toISOString().slice(0, 10);

    getStats({ type: "custom", from: fromStr, to: toStr })
      .then((s) => setCalBreakdown(s.dailyBreakdown))
      .catch(() => {});
  }, []);

  function handleDateClick(date: string) {
    const next = selectedDate === date ? null : date;
    setSelectedDate(next);
    filterByDate(next);
  }

  function clearDateFilter() {
    setSelectedDate(null);
    filterByDate(null);
  }

  function handleDateHover(dateStr: string | null) {
    if (dateStr === null) {
      wordCloudBus.cancelPending();
      return;
    }
    const articleIds = [
      ...new Set(
        history
          .filter((h) => h.articleId !== null && h.completedAt.slice(0, 10) === dateStr)
          .map((h) => h.articleId!)
      ),
    ];
    if (articleIds.length === 0) {
      wordCloudBus.cancelPending();
      return;
    }
    wordCloudBus.hoverDate(dateStr, articleIds, formatGroupDate(dateStr));
  }

  // 300ms デバウンス自動検索
  useEffect(() => {
    const timer = setTimeout(() => {
      search(searchText, searchTarget);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, searchTarget, search]);

  // 外部検索ワード（ワードクラウドクリック・タブ間共有検索）を即時反映
  useEffect(() => {
    if (externalSearch === undefined) return;
    if (externalSearch === searchText) return; // 自分が発火元の場合はスキップ
    setSearchText(externalSearch);
    setSearchTarget("all");
    search(externalSearch, "all");
  }, [externalSearch, search]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSearchTargetChange(target: HistorySearchTarget) {
    setSearchTarget(target);
  }

  function resetFilters() {
    setSearchText("");
    setSearchTarget("all");
    search("", "all");
    setPlayedAge("all");
    setFavoriteOnly(false);
    setSortMode("date-desc");
    clearDateFilter();
    onSearchChange?.("");
  }

  const isFiltered = playedAge !== "all" || favoriteOnly || sortMode !== "date-desc" || !!searchText || selectedDate !== null;

  const groups = groupHistoryByDate(filteredHistory);

  const chipStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 12, padding: "2px 10px", borderRadius: 12, boxShadow: "none",
    background: active ? "var(--accent)" : "var(--surface)",
    color: active ? "#fff" : "var(--text)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    cursor: active ? "default" : "pointer",
  });

  return (
    <section>
      {/* ── 統計セクション ── */}
      <CollapsibleSection title="統計・再生活動">
        <div style={{
          padding: "12px 16px 14px",
          background: "var(--surface)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          overflowX: "auto",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10 }}>
            再生活動（過去365日）
          </div>
          <PlaybackCalendar
            breakdown={calBreakdown}
            selectedDate={selectedDate}
            onDateClick={handleDateClick}
            onDateHover={handleDateHover}
          />
        </div>
        <StatsView stats={stats} period={period} onPeriodChange={setPeriod} />
      </CollapsibleSection>

      {/* ── 履歴セクション ── */}
      <CollapsibleSection title="再生履歴">
        {/* キーワード検索 */}
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <div style={{ position: "relative", flex: 1 }}>
            <input
              placeholder="キーワード検索"
              value={searchText}
              onChange={(e) => { setSearchText(e.target.value); onSearchChange?.(e.target.value); }}
              style={{ width: "100%", padding: "4px 28px 4px 8px", boxSizing: "border-box" }}
            />
            {searchText && (
              <button
                onClick={() => { setSearchText(""); search("", searchTarget); onSearchChange?.(""); }}
                style={{
                  position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--text-muted)", padding: "0 2px",
                  lineHeight: 1, boxShadow: "none", display: "inline-flex", alignItems: "center",
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* フィルタ */}
        <div style={{ display: "flex", gap: 20, marginBottom: isFiltered ? 4 : 10, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* 検索対象 */}
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>検索対象</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(["all", "title", "content", "url"] as const).map(t => (
                <button key={t} onClick={() => handleSearchTargetChange(t)} style={chipStyle(searchTarget === t)}>
                  {t === "all" ? "すべて" : t === "title" ? "タイトル" : t === "content" ? "本文" : "URL"}
                </button>
              ))}
            </div>
          </div>
          {/* 再生期間 */}
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>再生期間</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(["all", "week+", "month+", "quarter+"] as const).map(r => (
                <button key={r} onClick={() => setPlayedAge(r)} style={chipStyle(playedAge === r)}>
                  {r === "all" ? "すべて" : r === "week+" ? "1週間以上前" : r === "month+" ? "1ヶ月以上前" : "3ヶ月以上前"}
                </button>
              ))}
            </div>
          </div>
          {/* お気に入り */}
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>お気に入り</div>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => setFavoriteOnly(v => !v)} style={{
                ...chipStyle(favoriteOnly),
                background: favoriteOnly ? "var(--favorite)" : "var(--surface)",
                border: `1px solid ${favoriteOnly ? "var(--favorite)" : "var(--border)"}`,
                display: "inline-flex", alignItems: "center", gap: 4,
              }}>
                <Star size={12} fill={favoriteOnly ? "currentColor" : "none"} /> お気に入りのみ
              </button>
            </div>
          </div>
          {/* ソート */}
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>ソート</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(["date-desc", "date-asc", "title-asc"] as const).map(m => (
                <button key={m} onClick={() => setSortMode(m)} style={chipStyle(sortMode === m)}>
                  {m === "date-desc" ? "再生日↓" : m === "date-asc" ? "再生日↑" : "タイトル A→Z"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* カレンダー日付絞り込みバッジ */}
        {selectedDate && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
            padding: "5px 10px",
            background: "rgba(0,102,204,0.07)",
            borderRadius: 6,
            border: "1px solid rgba(0,102,204,0.18)",
          }}>
            <span style={{ fontSize: 13, flex: 1 }}>
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>{formatGroupDate(selectedDate)}</span>
              {" "}の再生履歴を表示中
            </span>
            <button
              onClick={clearDateFilter}
              title="絞り込みを解除"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "0 2px", lineHeight: 1, boxShadow: "none", borderRadius: 3, display: "inline-flex", alignItems: "center" }}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* リセット・件数 */}
        {isFiltered && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <button onClick={resetFilters} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 12, color: "var(--text-muted)", background: "none", border: "1px solid var(--border)", boxShadow: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <X size={11} /> リセット
            </button>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {filteredHistory.length}件 / 全{dedupedHistory.length}件
            </span>
          </div>
        )}

        {loading ? (
          <p>読み込み中…</p>
        ) : filteredHistory.length === 0 ? (
          selectedDate ? (
            <p style={{ color: "var(--text-muted)" }}>この日の再生履歴はありません</p>
          ) : (
            <div style={{ color: "var(--text-muted)", padding: "24px 16px", textAlign: "center", lineHeight: 1.9 }}>
              <div style={{ fontSize: 30, marginBottom: 8 }}>🎧</div>
              <p style={{ margin: "0 0 6px", fontWeight: 600 }}>まだ再生履歴がありません</p>
              <p style={{ margin: 0, fontSize: 13 }}>
                記事を再生すると、ここに履歴と再生活動カレンダーが記録されます。
              </p>
            </div>
          )
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {groups.map(({ dateStr, label, items }) => (
              <>
                <DateSectionHeader
                    key={`header-${dateStr}`}
                    label={label}
                    dateStr={dateStr}
                    urls={items.map(item => item.article?.url).filter((url): url is string => !!url)}
                    onHover={handleDateHover}
                  />
                {items.map((item) => (
                  <HistoryRow
                    key={item.id}
                    item={item}
                    onSelect={onSelectArticle}
                    onDoubleClickPlay={onDoubleClickPlay}
                    onArticleContextMenu={onArticleContextMenu}
                    onDelete={removeHistoryItem}
                  />
                ))}
              </>
            ))}
          </ul>
        )}
      </CollapsibleSection>
    </section>
  );
}

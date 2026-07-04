import { useRef, useState, useMemo, useEffect } from "react";
import { Star, Play, X } from "lucide-react";
import { registerArticle } from "@/lib/tauriCommands";
import { useArticles } from "./useArticles";
import { useAudioCache } from "./useAudioCache";
import { Favicon } from "@/shared/Favicon";
import { wordCloudBus } from "@/shared/wordCloudBus";
import { markSelfCopied } from "@/features/clipboard/useClipboardMonitor";
import type { Article, ArticleError, ArticleSearchTarget } from "@/shared/types";
import type { CacheMeta } from "@/lib/audioCache";

const PAGE_SIZE = 20;

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function groupArticlesByDate(articles: Article[]): { label: string; items: Article[] }[] {
  const map = new Map<string, Article[]>();
  for (const a of articles) {
    const key = a.registeredAt.slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(a);
  }
  return Array.from(map.entries()).map(([date, items]) => ({
    label: formatGroupDate(date),
    items,
  }));
}

// ─── URL 登録フォーム ──────────────────────────────────────────────────────

function UrlForm({ onAdded }: { onAdded: (article: Article) => void }) {
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUrlError(null);
    setSubmitting(true);
    const result = await registerArticle(url.trim());
    setSubmitting(false);

    if (result.ok) {
      onAdded(result.value);
      setUrl("");
    } else {
      setUrlError(errorMessage(result.error));
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com/article"
        required
        style={{ flex: 1, padding: "6px 10px" }}
      />
      <button type="submit" disabled={submitting}>
        {submitting ? "登録中…" : "登録"}
      </button>
      {urlError && (
        <span style={{ color: "red", alignSelf: "center", fontSize: 13 }}>
          {urlError}
        </span>
      )}
    </form>
  );
}

function errorMessage(e: ArticleError): string {
  if (e.kind === "duplicate_url") return "この URL はすでに登録済みです";
  if (e.kind === "invalid_url") return "無効な URL です";
  return `エラー: ${e.message}`;
}

// ─── ステータスバッジ ─────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending:    { label: "待機中",     color: "var(--text-muted)" },
  extracting: { label: "抽出中",     color: "var(--warning)" },
  ready:      { label: "完了",       color: "var(--success)" },
  error:      { label: "エラー",     color: "var(--danger)" },
  queued:     { label: "キュー済み", color: "var(--accent)" },
  played:     { label: "再生済み",   color: "var(--text-muted)" },
};

function StatusBadge({ status }: { status: string }) {
  const { label, color } = STATUS_LABEL[status] ?? { label: status, color: "var(--text-muted)" };
  const isLoading = status === "pending" || status === "extracting";
  return (
    <span style={{ color, fontWeight: 600, fontSize: 12, marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 4, verticalAlign: "middle" }}>
      {isLoading && <span className="inline-spinner" style={{ width: 9, height: 9, borderWidth: "1.5px" }} />}
      [{label}]
    </span>
  );
}

// ─── 削除ボタン（2段階確認） ──────────────────────────────────────────────

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (confirming) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setConfirming(false);
      onDelete();
    } else {
      setConfirming(true);
      timerRef.current = setTimeout(() => {
        setConfirming(false);
        timerRef.current = null;
      }, 2500);
    }
  }

  return (
    <button
      onClick={handleClick}
      onBlur={() => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } setConfirming(false); }}
      style={{
        fontSize: 12,
        color: confirming ? "#fff" : "var(--danger)",
        background: confirming ? "var(--danger)" : "none",
        border: confirming ? "1px solid var(--danger)" : "none",
        borderRadius: confirming ? 4 : 0,
        padding: confirming ? "1px 6px" : 0,
        boxShadow: "none",
        flexShrink: 0,
        transition: "all 0.15s",
      }}
    >
      {confirming ? "確認?" : "削除"}
    </button>
  );
}

// ─── 記事行 ──────────────────────────────────────────────────────────────

function ArticleRow({
  article,
  cache,
  onDelete,
  onRetry,
  onEnqueue,
  onView,
  onDoubleClickPlay,
  onArticleContextMenu,
  onToggleFavorite,
}: {
  article: Article;
  cache: CacheMeta | undefined;
  onDelete: (id: number) => void;
  onRetry: (id: number) => void;
  onEnqueue: (id: number) => void;
  onView?: (article: Article) => void;
  onDoubleClickPlay?: (articleId: number) => void;
  onArticleContextMenu?: (url: string, x: number, y: number) => void;
  onToggleFavorite?: (id: number) => void;
}) {
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleClick() {
    if (!onView) return;
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onView(article);
    }, 220);
  }

  function handleDoubleClick() {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (article.status === "ready" || article.status === "queued" || article.status === "played") {
      onDoubleClickPlay?.(article.id);
    }
  }

  return (
    <li
      onMouseLeave={() => wordCloudBus.cancelPending()}
      onContextMenu={(e) => {
        e.preventDefault();
        onArticleContextMenu?.(article.url, e.clientX, e.clientY);
      }}
      style={{
        padding: "8px 4px",
        borderBottom: "1px solid var(--border-light, #eee)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(article.id); }}
          title={article.isFavorite ? "お気に入り解除" : "お気に入り登録"}
          style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", boxShadow: "none", cursor: "pointer", padding: "0 2px", color: article.isFavorite ? "var(--favorite)" : "var(--text-muted)", flexShrink: 0 }}
        >
          <Star size={16} fill={article.isFavorite ? "currentColor" : "none"} />
        </button>
      )}
      <Favicon url={article.url} size={14} />
      {article.language === "en" && (
        <span style={{ fontSize: 10, fontWeight: 700, color: "#0066cc", background: "#e8f0fe", borderRadius: 3, padding: "0 4px", flexShrink: 0 }}>EN</span>
      )}
      <div
        style={{ flex: 1, overflow: "hidden", cursor: onView ? "pointer" : "default" }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={() => wordCloudBus.hover(article.id, article.title)}
        title={onDoubleClickPlay ? "ダブルクリックで即時再生" : undefined}
      >
        <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {article.title ?? article.url}
          <StatusBadge status={article.status} />
          {cache && (
            <span style={{ fontSize: 11, color: cache.isComplete ? "var(--success)" : "var(--warning)", marginLeft: 6, fontWeight: 400 }}>
              ♪ {cache.isComplete ? "" : `${cache.sentenceCount}文/ `}{formatDuration(cache.totalDurationSeconds)} ({formatBytes(cache.totalSizeBytes)})
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {article.url}
        </div>
        {(article.status === "pending" || article.status === "extracting") && (
          <div style={{ fontSize: 11, color: "var(--warning)" }}>
            ページを取得して本文を抽出しています…
          </div>
        )}
        {article.status === "error" && (
          <div style={{ fontSize: 11, color: "var(--danger)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={article.errorMessage ?? undefined}>
            {article.errorMessage
              ? `取得に失敗しました: ${article.errorMessage}`
              : "ページの取得に失敗しました。「再試行」を押してください"}
          </div>
        )}
      </div>
      {(article.status === "ready" || article.status === "queued" || article.status === "played") && onDoubleClickPlay && (
        <button
          title="今すぐ再生"
          style={{ fontSize: 12, color: "var(--success)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}
          onClick={(e) => { e.stopPropagation(); onDoubleClickPlay(article.id); }}
        >
          <Play size={12} fill="currentColor" strokeWidth={0} /> 再生
        </button>
      )}
      {article.status === "ready" && (
        <button style={{ fontSize: 12, color: "var(--accent)" }} onClick={(e) => { e.stopPropagation(); onEnqueue(article.id); }}>
          キューに追加
        </button>
      )}
      {article.status === "error" && (
        <button style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onRetry(article.id); }}>
          再試行
        </button>
      )}
      <DeleteButton onDelete={() => onDelete(article.id)} />
    </li>
  );
}

// ─── 日付セクションヘッダー ───────────────────────────────────────────────

function DateSectionHeader({ label, urls }: { label: string; urls: string[] }) {
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
    <li style={{
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
      display: "flex",
      alignItems: "center",
    }}>
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

type SortMode = "date-desc" | "date-asc" | "title-asc";

export function ArticleListPanel({
  onViewArticle,
  onPlay,
  onArticleContextMenu,
  onUnplayedCount,
  externalSearch,
  onSearchChange,
  onRequestSynth,
  onArticleDeleted,
}: {
  onViewArticle?: (article: Article) => void;
  onPlay?: () => void;
  onArticleContextMenu?: (url: string, x: number, y: number) => void;
  onUnplayedCount?: (count: number) => void;
  externalSearch?: string;
  onSearchChange?: (text: string) => void;
  onRequestSynth?: (articleId: number) => void;
  onArticleDeleted?: (articleId: number) => void;
} = {}) {
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState<string | undefined>(undefined);
  const [searchTarget, setSearchTarget] = useState<ArticleSearchTarget>("all");
  const [backlogAge, setBacklogAge] = useState<"all" | "week+" | "month+" | "quarter+">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "unplayed" | "played">("all");
  const [sortMode, setSortMode] = useState<SortMode>("date-desc");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const backendFilter = useMemo(() => ({
    ...(appliedSearch ? { search: appliedSearch, searchTarget } : {}),
    ...(favoriteOnly ? { isFavorite: true } : {}),
    sortBy: sortMode === "title-asc" ? "title" as const : "registeredAt" as const,
    sortOrder: sortMode === "date-asc" ? "asc" as const : "desc" as const,
  }), [appliedSearch, searchTarget, sortMode, favoriteOnly]);

  const { articles, loading, error, remove, retry, addArticle, enqueue, enqueueFirst, toggleFavorite } = useArticles(backendFilter);
  const { cacheMap } = useAudioCache();

  useEffect(() => {
    const count = articles.filter(a => a.status !== "played" && a.status !== "error").length;
    onUnplayedCount?.(count);
  }, [articles, onUnplayedCount]);

  // 300ms デバウンス自動検索
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(search || undefined);
      setVisibleCount(PAGE_SIZE);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // 外部検索ワード（ワードクラウドクリック・タブ間共有検索）を即時反映
  useEffect(() => {
    if (externalSearch === undefined) return;
    if (externalSearch === search) return; // 自分が発火元の場合はスキップ
    setSearch(externalSearch);
    setAppliedSearch(externalSearch || undefined);
    setSearchTarget("all");
    setVisibleCount(PAGE_SIZE);
  }, [externalSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetFilters() {
    setSearch("");
    setAppliedSearch(undefined);
    setSearchTarget("all");
    setBacklogAge("all");
    setStatusFilter("all");
    setSortMode("date-desc");
    setFavoriteOnly(false);
    setVisibleCount(PAGE_SIZE);
    onSearchChange?.("");
  }

  const filteredArticles = useMemo(() => {
    let dateBefore: string | null = null;
    if (backlogAge !== "all") {
      const d = new Date();
      if (backlogAge === "week+") d.setDate(d.getDate() - 7);
      else if (backlogAge === "month+") d.setDate(d.getDate() - 30);
      else if (backlogAge === "quarter+") d.setDate(d.getDate() - 90);
      d.setHours(0, 0, 0, 0);
      dateBefore = d.toISOString();
    }
    return articles.filter(a => {
      if (dateBefore && a.registeredAt >= dateBefore) return false;
      if (statusFilter === "unplayed") return a.status !== "played" && a.status !== "error";
      if (statusFilter === "played") return a.status === "played";
      return true;
    });
  }, [articles, backlogAge, statusFilter]);

  async function handleDoubleClickPlay(articleId: number) {
    await enqueueFirst(articleId);
    onPlay?.();
  }

  // 「キューに追加」: 再生キューに入れると同時にバックグラウンド合成を開始する
  // （再生キューと合成キューの二重管理をユーザーに意識させないため）
  async function handleEnqueue(articleId: number) {
    await enqueue(articleId);
    onRequestSynth?.(articleId);
  }

  // 記事削除: DB で queue_items は CASCADE 削除される。再生中記事だった場合に
  // 鳴り続けないよう、削除完了後に親へ通知する（親が再生中なら次へ移行する）
  async function handleDelete(articleId: number) {
    await remove(articleId);
    onArticleDeleted?.(articleId);
  }

  const visibleArticles = filteredArticles.slice(0, visibleCount);
  const hasMore = filteredArticles.length > visibleCount;
  const remaining = filteredArticles.length - visibleCount;
  const groups = groupArticlesByDate(visibleArticles);
  const isFiltered = backlogAge !== "all" || statusFilter !== "all" || !!appliedSearch || sortMode !== "date-desc" || favoriteOnly || searchTarget !== "all";

  return (
    <section>
      <UrlForm onAdded={addArticle} />

      {/* フィルタ */}
      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            placeholder="キーワード検索"
            value={search}
            onChange={(e) => { setSearch(e.target.value); onSearchChange?.(e.target.value); }}
            style={{ width: "100%", padding: "4px 28px 4px 8px", boxSizing: "border-box" }}
          />
          {search && (
            <button
              onClick={() => { setSearch(""); setAppliedSearch(undefined); setVisibleCount(PAGE_SIZE); onSearchChange?.(""); }}
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
      <div style={{ display: "flex", gap: 20, marginBottom: isFiltered ? 4 : 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* 検索対象 */}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>検索対象</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(["all", "title", "content", "url"] as const).map(t => (
              <button key={t} onClick={() => setSearchTarget(t)} style={{
                fontSize: 12, padding: "2px 10px", borderRadius: 12, boxShadow: "none",
                background: searchTarget === t ? "var(--accent)" : "var(--surface)",
                color: searchTarget === t ? "#fff" : "var(--text)",
                border: `1px solid ${searchTarget === t ? "var(--accent)" : "var(--border)"}`,
              }}>
                {t === "all" ? "すべて" : t === "title" ? "タイトル" : t === "content" ? "本文" : "URL"}
              </button>
            ))}
          </div>
        </div>
        {/* 積読期間 */}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>積読期間</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(["all", "week+", "month+", "quarter+"] as const).map(r => (
              <button key={r} onClick={() => { setBacklogAge(r); setVisibleCount(PAGE_SIZE); }} style={{
                fontSize: 12, padding: "2px 10px", borderRadius: 12, boxShadow: "none",
                background: backlogAge === r ? "var(--accent)" : "var(--surface)",
                color: backlogAge === r ? "#fff" : "var(--text)",
                border: `1px solid ${backlogAge === r ? "var(--accent)" : "var(--border)"}`,
              }}>
                {r === "all" ? "すべて" : r === "week+" ? "1週間以上前" : r === "month+" ? "1ヶ月以上前" : "3ヶ月以上前"}
              </button>
            ))}
          </div>
        </div>
        {/* 状態 */}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>状態</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(["all", "unplayed", "played"] as const).map(s => (
              <button key={s} onClick={() => { setStatusFilter(s); setVisibleCount(PAGE_SIZE); }} style={{
                fontSize: 12, padding: "2px 10px", borderRadius: 12, boxShadow: "none",
                background: statusFilter === s ? "var(--accent)" : "var(--surface)",
                color: statusFilter === s ? "#fff" : "var(--text)",
                border: `1px solid ${statusFilter === s ? "var(--accent)" : "var(--border)"}`,
              }}>
                {s === "all" ? "すべて" : s === "unplayed" ? "未再生" : "再生済み"}
              </button>
            ))}
          </div>
        </div>
        {/* お気に入り */}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>お気に入り</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => { setFavoriteOnly(v => !v); setVisibleCount(PAGE_SIZE); }} style={{
              fontSize: 12, padding: "2px 10px", borderRadius: 12, boxShadow: "none",
              background: favoriteOnly ? "var(--favorite)" : "var(--surface)",
              color: favoriteOnly ? "#fff" : "var(--text)",
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
              <button key={m} onClick={() => { setSortMode(m); setVisibleCount(PAGE_SIZE); }} style={{
                fontSize: 12, padding: "2px 10px", borderRadius: 12, boxShadow: "none",
                background: sortMode === m ? "var(--accent)" : "var(--surface)",
                color: sortMode === m ? "#fff" : "var(--text)",
                border: `1px solid ${sortMode === m ? "var(--accent)" : "var(--border)"}`,
              }}>
                {m === "date-desc" ? "登録日↓" : m === "date-asc" ? "登録日↑" : "タイトル A→Z"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {isFiltered && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <button onClick={resetFilters} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 12, color: "var(--text-muted)", background: "none", border: "1px solid var(--border)", boxShadow: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <X size={11} /> リセット
          </button>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {filteredArticles.length}件 / 全{articles.length}件
          </span>
        </div>
      )}

      {error && <p style={{ color: "red" }}>{error}</p>}
      {loading ? (
        <p>読み込み中…</p>
      ) : articles.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "32px 16px", textAlign: "center", lineHeight: 1.9 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📰</div>
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>まだ記事がありません</p>
          <p style={{ margin: 0, fontSize: 13 }}>
            上の入力欄に記事の URL を貼り付けて「登録」するか、<br />
            ブラウザで URL をコピーすると自動で登録されます。
          </p>
        </div>
      ) : (
        <>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {groups.map(({ label, items }) => (
              <>
                <DateSectionHeader key={`header-${label}`} label={label} urls={items.map(a => a.url)} />
                {items.map((a) => (
                  <ArticleRow
                    key={a.id}
                    article={a}
                    cache={cacheMap.get(a.id)}
                    onDelete={handleDelete}
                    onRetry={retry}
                    onEnqueue={handleEnqueue}
                    onView={onViewArticle}
                    onDoubleClickPlay={handleDoubleClickPlay}
                    onArticleContextMenu={onArticleContextMenu}
                    onToggleFavorite={toggleFavorite}
                  />
                ))}
              </>
            ))}
          </ul>

          {hasMore && (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <button
                onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                style={{
                  padding: "6px 20px",
                  fontSize: 13,
                  color: "var(--accent, var(--accent))",
                  background: "none",
                  border: "1px solid currentColor",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                さらに{Math.min(PAGE_SIZE, remaining)}件表示（残り{remaining}件）
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

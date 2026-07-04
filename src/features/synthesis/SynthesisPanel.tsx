import { Fragment, useCallback, useMemo, useState } from "react";
import { Play, Square } from "lucide-react";
import { useArticles } from "@/features/articles/useArticles";
import { useAudioCache } from "@/features/articles/useAudioCache";
import { splitSentences } from "@/lib/voicevoxClient";
import { buildFullText } from "@/features/viewer/viewerUtils";
import { Favicon } from "@/shared/Favicon";
import { wordCloudBus } from "@/shared/wordCloudBus";
import type { Article } from "@/shared/types";
import type { UsePlaybackResult } from "@/features/playback/usePlayback";

const PAGE_SIZE = 20;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function formatGroupDate(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === today) return "今日";
  if (dateStr === yesterday) return "昨日";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric",
  });
}

// ─── Collapse wrapper ─────────────────────────────────────────────────────────

function CollapseSection({
  title, badge, collapsed, onToggle, children,
}: {
  title: string;
  badge?: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px", background: "var(--surface)",
          cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
          {collapsed ? "▶" : "▼"}
        </span>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>{title}</h3>
        {badge !== undefined && (
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>{badge}</span>
        )}
      </div>
      {!collapsed && <div>{children}</div>}
    </section>
  );
}

// ─── メインパネル ─────────────────────────────────────────────────────────────

export function SynthesisPanel({
  playback,
  onArticleContextMenu,
  onSelectArticle,
}: {
  playback: UsePlaybackResult;
  onArticleContextMenu?: (url: string, x: number, y: number) => void;
  onSelectArticle?: (article: Article) => void;
}) {
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [collapseSearch, setCollapseSearch] = useState(true);
  const [collapseUnsynth, setCollapseUnsynth] = useState(false);
  const [collapseSynth, setCollapseSynth] = useState(false);

  const [unsynthOffset, setUnsynthOffset] = useState(0);
  const [synthOffset, setSynthOffset] = useState(0);

  // 「すべて削除」の2段階確認
  const [confirmClear, setConfirmClear] = useState(false);

  const { articles } = useArticles();
  const { cacheMap, removeCache } = useAudioCache();

  const synthingId = playback.synthProgress?.articleId ?? null;
  const running = playback.batchSynthRunning;

  // 音声合成の対象になる記事（抽出完了済み）
  const processableArticles = useMemo(
    () => articles.filter(a => a.status === "ready" || a.status === "queued" || a.status === "played"),
    [articles],
  );

  // 未合成: cache が完了していない
  const unsynthArticles = useMemo(
    () => processableArticles.filter(a => !cacheMap.get(a.id)?.isComplete),
    [processableArticles, cacheMap],
  );

  // 合成済み: cache 完了、cachedAt 降順
  const synthArticles = useMemo(() => {
    const list = processableArticles.filter(a => cacheMap.get(a.id)?.isComplete === true);
    list.sort((a, b) => (cacheMap.get(b.id)?.cachedAt ?? "").localeCompare(cacheMap.get(a.id)?.cachedAt ?? ""));
    return list;
  }, [processableArticles, cacheMap]);

  // フロントエンド検索フィルタ
  const filterFn = useCallback((a: Article) => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (appliedSearch) {
      const q = appliedSearch.toLowerCase();
      return (a.title ?? a.url).toLowerCase().includes(q) || a.url.toLowerCase().includes(q);
    }
    return true;
  }, [appliedSearch, statusFilter]);

  const filteredUnsynth = useMemo(() => unsynthArticles.filter(filterFn), [unsynthArticles, filterFn]);
  const filteredSynth = useMemo(() => synthArticles.filter(filterFn), [synthArticles, filterFn]);

  const unsynthVisible = filteredUnsynth.slice(0, unsynthOffset + PAGE_SIZE);
  const unsynthHasMore = filteredUnsynth.length > unsynthOffset + PAGE_SIZE;
  const synthVisible = filteredSynth.slice(0, synthOffset + PAGE_SIZE);
  const synthHasMore = filteredSynth.length > synthOffset + PAGE_SIZE;

  const totalSynthSize = useMemo(
    () => synthArticles.reduce((sum, a) => sum + (cacheMap.get(a.id)?.totalSizeBytes ?? 0), 0),
    [synthArticles, cacheMap],
  );
  const totalUnsynthSize = useMemo(
    () => filteredUnsynth.reduce((sum, a) => sum + (cacheMap.get(a.id)?.totalSizeBytes ?? 0), 0),
    [filteredUnsynth, cacheMap],
  );

  // 表示中の未合成記事の全文章数
  const sentenceCountMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const a of unsynthVisible) {
      const text = buildFullText(a.title, a.content, a.contentHtml);
      if (text) map.set(a.id, splitSentences(text).length);
    }
    return map;
  }, [unsynthVisible]);

  // 未合成リストを登録日でグループ化
  const unsynthGroups = useMemo(() => {
    const map = new Map<string, Article[]>();
    for (const a of unsynthVisible) {
      const key = a.registeredAt.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return Array.from(map.entries()).map(([date, items]) => ({ label: formatGroupDate(date), items }));
  }, [unsynthVisible]);

  // ── アクション ───────────────────────────────────────────────────────────────

  // すべて合成 / 停止
  function handleToggleAll() {
    if (running) {
      const isPlayingBeingSynthed =
        playback.state.phase !== "idle" && "articleId" in playback.state &&
        synthingId === playback.state.articleId;
      playback.stopBatchSynth();
      if (isPlayingBeingSynthed) playback.skip();
    } else {
      playback.startBatchSynth().catch(() => {});
    }
  }

  // 個別記事の合成（バッチ実行中は無効）
  function handleSynthOne(articleId: number) {
    if (running) return;
    playback.startBatchSynth([articleId]).catch(() => {});
  }

  async function handleDeleteCache(articleId: number) {
    await removeCache(articleId);
  }

  async function handleClearAllSynth() {
    const ids = synthArticles.map(a => a.id);
    setConfirmClear(false);
    for (const id of ids) {
      await removeCache(id).catch(() => {});
    }
  }

  function applySearch() {
    setAppliedSearch(search);
    setUnsynthOffset(0);
    setSynthOffset(0);
  }

  const itemRowStyle: React.CSSProperties = {
    display: "flex", alignItems: "flex-start",
    gap: 8, padding: "8px 12px",
    borderBottom: "1px solid var(--border-light)",
  };
  const btnSm: React.CSSProperties = { fontSize: 12, padding: "2px 8px", flexShrink: 0 };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* ─── 説明＋一括操作バー ─────────────────────────────────────────────── */}
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
          🎧 <strong>このタブは普段は使いません。</strong>記事は再生ボタンを押せば自動で読み上げ用の音声が用意されます。
          外出前などに<strong>先にまとめて準備</strong>しておきたいときだけ、ここで一括準備できます（準備しておくと再生時に待ち時間なく聞けます）。
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {running ? (
            <button
              onClick={handleToggleAll}
              style={{ fontSize: 13, padding: "5px 14px", background: "#fff3cd", borderColor: "var(--warning)", color: "#333", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Square size={13} fill="currentColor" strokeWidth={0} /> 停止
            </button>
          ) : (
            <button
              onClick={handleToggleAll}
              disabled={filteredUnsynth.length === 0}
              style={{ fontSize: 13, padding: "5px 14px", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}
              title="準備待ちの記事をまとめて音声化します"
            >
              <Play size={13} fill="currentColor" strokeWidth={0} /> すべて準備
            </button>
          )}
          {running && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--warning)" }}>
              <span style={{
                display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                background: "var(--warning)", animation: "synth-pulse 1s ease-in-out infinite",
              }} />
              準備中
              {playback.synthProgress && (
                <span style={{ fontWeight: 400 }}>{playback.synthProgress.done}/{playback.synthProgress.total}文</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* ─── 検索 ─────────────────────────────────────────────────────────── */}
      <CollapseSection title="検索" collapsed={collapseSearch} onToggle={() => setCollapseSearch(v => !v)}>
        <div style={{ display: "flex", gap: 8, padding: "8px 12px", flexWrap: "wrap" }}>
          <input
            placeholder="キーワード検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === "Enter" && applySearch()}
            style={{ flex: 1, minWidth: 150, padding: "4px 8px" }}
          />
          <button onClick={applySearch} style={{ padding: "4px 10px" }}>検索</button>
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setUnsynthOffset(0); setSynthOffset(0); }}
            style={{ padding: "4px 8px" }}
          >
            <option value="">すべて</option>
            <option value="ready">完了</option>
            <option value="queued">キュー済み</option>
            <option value="played">再生済み</option>
          </select>
        </div>
      </CollapseSection>

      {/* ─── 未合成（合成待ち） ──────────────────────────────────────────────── */}
      <CollapseSection
        title="準備待ち"
        badge={`${filteredUnsynth.length}件${totalUnsynthSize > 0 ? ` / ${formatBytes(totalUnsynthSize)}` : ""}`}
        collapsed={collapseUnsynth}
        onToggle={() => setCollapseUnsynth(v => !v)}
      >
        {filteredUnsynth.length === 0 ? (
          <p style={{ color: "var(--success)", fontSize: 13, padding: "8px 12px", margin: 0 }}>
            ✓ すべての記事が準備済みです
          </p>
        ) : (
          <>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {unsynthGroups.map(({ label, items }) => (
                <Fragment key={label}>
                  <li style={{
                    padding: "5px 12px", fontSize: 11, fontWeight: 700,
                    color: "var(--text-muted)", letterSpacing: "0.05em",
                    background: "var(--surface)", position: "sticky", top: 0, zIndex: 1,
                    borderBottom: "1px solid var(--border-light)",
                  }}>
                    {label}
                  </li>
                  {items.map(a => {
                    const cache = cacheMap.get(a.id);
                    const isSynthing = synthingId === a.id;
                    const totalSents = sentenceCountMap.get(a.id);

                    return (
                      <li
                        key={a.id}
                        onClick={() => onSelectArticle?.(a)}
                        onContextMenu={e => { e.preventDefault(); onArticleContextMenu?.(a.url, e.clientX, e.clientY); }}
                        onMouseEnter={() => wordCloudBus.hover(a.id, a.title ?? null)}
                        onMouseLeave={() => wordCloudBus.cancelPending()}
                        style={{ ...itemRowStyle, cursor: onSelectArticle ? "pointer" : "default", background: isSynthing ? "rgba(251,146,60,0.08)" : undefined }}
                      >
                        <Favicon url={a.url} size={14} />
                        <div style={{ flex: 1, overflow: "hidden" }}>
                          <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {a.title ?? a.url}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {a.url}
                          </div>
                          {isSynthing && playback.synthProgress ? (
                            <div style={{ fontSize: 11, color: "var(--warning)" }}>
                              準備中: {playback.synthProgress.done}/{playback.synthProgress.total}文
                              {cache ? ` (${formatBytes(cache.totalSizeBytes)})` : ""}
                            </div>
                          ) : (
                            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                              {running ? "待機中" : (
                                <>
                                  {(cache?.sentenceCount ?? 0)}{totalSents ? `/${totalSents}` : ""}文 準備済み
                                  {cache && cache.totalSizeBytes > 0 ? ` (${formatBytes(cache.totalSizeBytes)})` : ""}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        {!running && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleSynthOne(a.id); }}
                            style={btnSm}
                            title="この記事の音声を準備する"
                          >
                            準備
                          </button>
                        )}
                        {cache && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteCache(a.id).catch(() => {}); }}
                            style={{ ...btnSm, color: "var(--text-muted)" }}
                            title="準備済みの音声を削除"
                          >
                            音声削除
                          </button>
                        )}
                      </li>
                    );
                  })}
                </Fragment>
              ))}
            </ul>
            {unsynthHasMore && (
              <div style={{ textAlign: "center", padding: "10px 0" }}>
                <button
                  onClick={() => setUnsynthOffset(v => v + PAGE_SIZE)}
                  style={{ fontSize: 13, color: "var(--accent)", background: "none", border: "1px solid currentColor", borderRadius: 4, padding: "4px 16px", cursor: "pointer", boxShadow: "none" }}
                >
                  さらに{Math.min(PAGE_SIZE, filteredUnsynth.length - (unsynthOffset + PAGE_SIZE))}件表示
                </button>
              </div>
            )}
          </>
        )}
      </CollapseSection>

      {/* ─── 合成済み（保存済み・ストレージ管理） ────────────────────────────── */}
      <CollapseSection
        title="準備完了（保存済み）"
        badge={`${filteredSynth.length}件 / ${formatBytes(totalSynthSize)}`}
        collapsed={collapseSynth}
        onToggle={() => setCollapseSynth(v => !v)}
      >
        {filteredSynth.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13, padding: "8px 12px", margin: 0 }}>
            準備済みの音声はまだありません
          </p>
        ) : (
          <>
            {/* ストレージ一括操作 */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--border-light)" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1 }}>
                合計 {formatBytes(totalSynthSize)} を使用中
              </span>
              {confirmClear ? (
                <>
                  <span style={{ fontSize: 12, color: "var(--danger)" }}>準備済みの音声をすべて削除しますか？</span>
                  <button onClick={() => handleClearAllSynth().catch(() => {})} style={{ ...btnSm, color: "#fff", background: "var(--danger)", borderColor: "var(--danger)" }}>削除する</button>
                  <button onClick={() => setConfirmClear(false)} style={btnSm}>キャンセル</button>
                </>
              ) : (
                <button onClick={() => setConfirmClear(true)} style={{ ...btnSm, color: "var(--text-muted)" }}>すべて削除</button>
              )}
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {synthVisible.map(a => {
                const cache = cacheMap.get(a.id)!;
                return (
                  <li
                    key={a.id}
                    onClick={() => onSelectArticle?.(a)}
                    onContextMenu={e => { e.preventDefault(); onArticleContextMenu?.(a.url, e.clientX, e.clientY); }}
                    onMouseEnter={() => wordCloudBus.hover(a.id, a.title ?? null)}
                    onMouseLeave={() => wordCloudBus.cancelPending()}
                    style={{ ...itemRowStyle, cursor: onSelectArticle ? "pointer" : "default" }}
                  >
                    <Favicon url={a.url} size={14} />
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.title ?? a.url}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.url}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {cache.sentenceCount}文 / {formatDuration(cache.totalDurationSeconds)} / {formatBytes(cache.totalSizeBytes)}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteCache(a.id).catch(() => {}); }}
                      style={{ ...btnSm, color: "var(--text-muted)" }}
                      title="準備済みの音声を削除"
                    >
                      音声削除
                    </button>
                  </li>
                );
              })}
            </ul>
            {synthHasMore && (
              <div style={{ textAlign: "center", padding: "10px 0" }}>
                <button
                  onClick={() => setSynthOffset(v => v + PAGE_SIZE)}
                  style={{ fontSize: 13, color: "var(--accent)", background: "none", border: "1px solid currentColor", borderRadius: 4, padding: "4px 16px", cursor: "pointer", boxShadow: "none" }}
                >
                  さらに{Math.min(PAGE_SIZE, filteredSynth.length - (synthOffset + PAGE_SIZE))}件表示
                </button>
              </div>
            )}
          </>
        )}
      </CollapseSection>

    </div>
  );
}

import { useRef, useState, useLayoutEffect, useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { Play, X, Pin, FileText } from "lucide-react";
import { useQueue } from "./useQueue";
import { wordCloudBus } from "@/shared/wordCloudBus";
import { WordCloud } from "@/shared/WordCloud";
import { getArticleKeywords } from "@/lib/tauriCommands";
import type { KeywordScore } from "@/shared/types";
import type { Article, PlaybackState, QueueItem } from "@/shared/types";

export const SIDEBAR_EXPANDED_WIDTH = 240;
export const SIDEBAR_COLLAPSED_WIDTH = 52;

function getFaviconUrl(url: string): string {
  try {
    const { hostname } = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return "";
  }
}

function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = getFaviconUrl(url);
  if (!src || failed) {
    return (
      <span style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}>
        🌐
      </span>
    );
  }
  return (
    <img
      src={src}
      width={20}
      height={20}
      draggable={false}
      style={{ objectFit: "contain", flexShrink: 0, display: "block" }}
      onError={() => setFailed(true)}
      alt=""
    />
  );
}

function SidebarItem({
  item,
  isPlaying,
  collapsed,
  isDragOver,
  onRemove,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onSelect,
  onDoubleClick,
  onArticleContextMenu,
  itemRef,
}: {
  item: QueueItem;
  isPlaying: boolean;
  collapsed: boolean;
  isDragOver: boolean;
  onRemove: (id: number) => void;
  onDragStart: (id: number) => void;
  onDragOver: () => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (targetId: number) => void;
  onDragEnd: () => void;
  onSelect?: (article: Article) => void;
  onDoubleClick?: () => void;
  onArticleContextMenu?: (url: string, x: number, y: number) => void;
  itemRef?: (el: HTMLLIElement | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const title = item.article.title ?? item.article.url;

  return (
    <li
      ref={itemRef}
      draggable
      onContextMenu={(e) => {
        // テキスト記事は URL 依存メニューを出さない（グローバルのテキストコピーは従来通り）
        if (item.article.sourceType === "text") return;
        e.preventDefault();
        onArticleContextMenu?.(item.article.url, e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(item.id));
        onDragStart(item.id);
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragOver(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(item.id); }}
      onDragEnd={onDragEnd}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => { setHovered(true); wordCloudBus.hover(item.article.id, item.article.title ?? null, item.article.sourceType === "text" ? null : item.article.url); }}
      onMouseLeave={() => { setHovered(false); wordCloudBus.cancelPending(); }}
      title={collapsed ? title : undefined}
      style={{
        padding: collapsed ? "8px 0" : "7px 8px 7px 10px",
        borderBottom: "1px solid var(--border-light)",
        display: "flex",
        alignItems: "center",
        gap: collapsed ? 0 : 7,
        justifyContent: collapsed ? "center" : "flex-start",
        background: isPlaying ? "rgba(0,102,204,0.08)" : hovered ? "var(--border-light)" : "transparent",
        borderLeft: isPlaying ? "3px solid var(--accent)" : "3px solid transparent",
        cursor: "grab",
        position: "relative",
        minHeight: 38,
        boxSizing: "border-box",
        userSelect: "none",
        // ドロップ先インジケーター（上端にライン）
        boxShadow: isDragOver ? "inset 0 2px 0 0 var(--accent)" : "none",
        transition: "background 0.1s ease, box-shadow 0.12s ease",
      }}
    >
      {/* favicon + 再生中インジケーター */}
      <div
        style={{ position: "relative", flexShrink: 0, cursor: onSelect ? "pointer" : "default" }}
        onClick={() => onSelect?.(item.article)}
      >
        {item.article.sourceType === "text" ? (
          <span title="テキスト記事" style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", flexShrink: 0 }}>
            <FileText size={16} />
          </span>
        ) : (
          <Favicon url={item.article.url} />
        )}
        {(item.article.language === "en" || item.article.language === "mixed") && (
          <span style={{ position: "absolute", top: -4, right: -6, fontSize: 9, fontWeight: 700, color: "#0066cc", background: "#e8f0fe", borderRadius: 2, padding: "0 2px", lineHeight: 1.4, pointerEvents: "none" }}>
            {item.article.language === "en" ? "EN" : "JA·EN"}
          </span>
        )}
        {isPlaying && (
          <span style={{
            position: "absolute",
            bottom: -3,
            right: -5,
            color: "var(--accent)",
            lineHeight: 1,
            pointerEvents: "none",
            display: "inline-flex",
          }}>
            <Play size={9} fill="currentColor" strokeWidth={0} />
          </span>
        )}
      </div>

      {/* タイトル + 削除ボタン (展開時のみ) */}
      {!collapsed && (
        <>
          <div
            style={{ flex: 1, minWidth: 0, cursor: onSelect ? "pointer" : "default" }}
            onClick={() => onSelect?.(item.article)}
          >
            <div style={{
              fontSize: 13,
              fontWeight: isPlaying ? 700 : 400,
              color: isPlaying ? "var(--accent)" : "var(--text)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              lineHeight: "1.3",
            }}>
              {title}
            </div>
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
            title="キューから削除"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: hovered ? "var(--danger)" : "transparent",
              padding: "0 2px",
              flexShrink: 0,
              lineHeight: 1,
              transition: "color 0.1s",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <X size={14} />
          </button>
        </>
      )}
    </li>
  );
}

export function QueueSidebar({
  collapsed,
  onToggleCollapsed,
  playbackState,
  onSelectArticle,
  onSkip,
  onPlayNow,
  onArticleContextMenu,
  onWordClick,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  playbackState: PlaybackState;
  onSelectArticle?: (article: Article) => void;
  onSkip?: () => void;
  onPlayNow?: () => void;
  onArticleContextMenu?: (url: string, x: number, y: number) => void;
  onWordClick?: (word: string) => void;
}) {
  const { queue, loading, remove, reorder, clearAll, restore } = useQueue();
  const dragId = useRef<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  // Undo トースト（直前の破壊的操作を元に戻す）
  const [undoToast, setUndoToast] = useState<{ msg: string; action: () => void } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showUndo(msg: string, action: () => void) {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoToast({ msg, action });
    undoTimerRef.current = setTimeout(() => setUndoToast(null), 6000);
  }

  // ─── ワードクラウド ───────────────────────────────────────────────────────
  const [wcOpen, setWcOpen] = useState(true);
  const [wcArticleId, setWcArticleId] = useState<number | null>(null);
  const [wcTitle, setWcTitle] = useState<string | null>(null);
  const [wcArticleUrl, setWcArticleUrl] = useState<string | null>(null);
  // 日付ホバー時のラベル（非null = 日付モード、null = 記事モードまたはidle）
  const [wcDateLabel, setWcDateLabel] = useState<string | null>(null);
  const [wcKeywords, setWcKeywords] = useState<KeywordScore[] | null>(null);
  const [wcLoading, setWcLoading] = useState(false);
  const wcCacheRef = useRef<Map<number, KeywordScore[]>>(new Map());
  // ピン留め: ON の間はホバーイベントで表示を切り替えない
  const [wcPinned, setWcPinned] = useState(false);
  const wcPinnedRef = useRef(false);
  wcPinnedRef.current = wcPinned;

  useEffect(() => {
    return wordCloudBus.subscribe(async (event) => {
      // ピン留め中はホバー/表示イベントを無視して現在の表示を維持する
      if (wcPinnedRef.current) return;
      if (event.type === "article") {
        const { articleId, title, url } = event;
        setWcArticleId(articleId);
        setWcTitle(title);
        setWcArticleUrl(url);
        setWcDateLabel(null);
        if (wcCacheRef.current.has(articleId)) {
          setWcKeywords(wcCacheRef.current.get(articleId)!);
          setWcLoading(false);
          return;
        }
        setWcKeywords(null);
        setWcLoading(true);
        try {
          const scores = await getArticleKeywords(articleId);
          // 空結果はキャッシュしない（抽出前ホバー時の空が永続化されるのを防ぐ）
          if (scores.length > 0) {
            wcCacheRef.current.set(articleId, scores);
          }
          setWcArticleId((prev) => {
            if (prev === articleId) {
              setWcKeywords(scores);
              setWcLoading(false);
            }
            return prev;
          });
        } catch {
          setWcLoading(false);
          setWcKeywords([]);
        }
      } else {
        // date イベント: その日の全記事キーワードを並列取得して集約
        const { articleIds, label } = event;
        setWcArticleId(null);
        setWcTitle(null);
        setWcArticleUrl(null);
        setWcDateLabel(label);
        if (articleIds.length === 0) {
          setWcKeywords([]);
          setWcLoading(false);
          return;
        }
        setWcKeywords(null);
        setWcLoading(true);
        try {
          const results = await Promise.all(
            articleIds.map((id) => {
              if (wcCacheRef.current.has(id)) return Promise.resolve(wcCacheRef.current.get(id)!);
              return getArticleKeywords(id).then((scores) => {
                if (scores.length > 0) wcCacheRef.current.set(id, scores);
                return scores;
              });
            })
          );
          const aggMap = new Map<string, number>();
          for (const scores of results) {
            for (const { word, score } of scores) {
              aggMap.set(word, (aggMap.get(word) ?? 0) + score);
            }
          }
          const aggregated: KeywordScore[] = Array.from(aggMap.entries())
            .map(([word, score]) => ({ word, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 50);
          setWcDateLabel((prevLabel) => {
            if (prevLabel === label) {
              setWcKeywords(aggregated);
              setWcLoading(false);
            }
            return prevLabel;
          });
        } catch {
          setWcLoading(false);
          setWcKeywords([]);
        }
      }
    });
  }, []);

  // 抽出完了時にキャッシュを無効化（抽出前ホバーで空キャッシュができた場合の救済）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ id: number }>("article:extraction-completed", (e) => {
      wcCacheRef.current.delete(e.payload.id);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // FLIP アニメーション用
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const prevPositionsRef = useRef<Map<number, number>>(new Map());
  const isReorderingRef = useRef(false);

  useLayoutEffect(() => {
    if (!isReorderingRef.current) return;
    isReorderingRef.current = false;

    const prev = prevPositionsRef.current;
    itemRefs.current.forEach((el, id) => {
      const prevTop = prev.get(id);
      if (prevTop === undefined) return;
      const nextTop = el.getBoundingClientRect().top;
      const dy = prevTop - nextTop;
      if (Math.abs(dy) < 1) return;

      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 0.22s cubic-bezier(0.2, 0, 0, 1)";
        el.style.transform = "";
      });
    });
  }, [queue]);

  const currentArticleId =
    playbackState.phase === "playing" ||
    playbackState.phase === "paused" ||
    playbackState.phase === "synthesizing" ||
    playbackState.phase === "error"
      ? playbackState.articleId
      : null;

  // 再生中アイテムが変わったら、その項目へスクロールして見失わないようにする
  const lastScrolledRef = useRef<number | null>(null);
  useEffect(() => {
    if (collapsed || currentArticleId === null) {
      lastScrolledRef.current = null;
      return;
    }
    if (lastScrolledRef.current === currentArticleId) return;
    const frontId = queue[0]?.id;
    if (frontId === undefined) return;
    const el = itemRefs.current.get(frontId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      lastScrolledRef.current = currentArticleId;
    }
  }, [currentArticleId, queue, collapsed]);

  async function handleDoubleClick(item: QueueItem) {
    const isAtFront = queue[0]?.id === item.id;
    const isActivelyPlaying =
      currentArticleId === item.article.id &&
      (playbackState.phase === "playing" || playbackState.phase === "synthesizing");

    // 先頭かつ再生中 → 何もしない
    if (isAtFront && isActivelyPlaying) return;

    if (!isAtFront) {
      const ids = queue.map((q) => q.id);
      const fromIdx = ids.indexOf(item.id);
      const next = [item.id, ...ids.filter((_, i) => i !== fromIdx)];
      capturePositions();
      isReorderingRef.current = true;
      await reorder(next);
    }

    onPlayNow?.();
  }

  function handleRemove(id: number) {
    const item = queue.find((q) => q.id === id);
    const isCurrentlyPlaying =
      currentArticleId !== null &&
      queue[0]?.id === id &&
      item?.articleId === currentArticleId;
    if (isCurrentlyPlaying && onSkip) {
      onSkip();
    } else {
      remove(id);
    }
  }

  function handleClearAll() {
    if (queue.length === 0) return;
    const snapshot = queue.map((q) => q.articleId);
    const isPlaying = currentArticleId !== null &&
      queue[0]?.articleId === currentArticleId;
    if (isPlaying && onSkip) {
      onSkip();
    }
    clearAll(queue);
    showUndo("キューを空にしました", () => {
      setUndoToast(null);
      restore(snapshot).catch(() => {});
    });
  }

  function capturePositions() {
    const positions = new Map<number, number>();
    itemRefs.current.forEach((el, id) => {
      positions.set(id, el.getBoundingClientRect().top);
    });
    prevPositionsRef.current = positions;
  }

  async function handleDrop(targetId: number) {
    if (dragId.current === null || dragId.current === targetId) return;
    const ids = queue.map((q) => q.id);
    const fromIdx = ids.indexOf(dragId.current);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId.current);

    const firstChanged = next[0] !== ids[0];
    capturePositions();
    isReorderingRef.current = true;
    await reorder(next);
    dragId.current = null;
    setDragOverId(null);

    const isActive =
      playbackState.phase === "playing" ||
      playbackState.phase === "synthesizing" ||
      playbackState.phase === "paused";
    if (firstChanged && isActive) {
      onPlayNow?.();
    }
  }

  const width = collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;

  // wcKeywords の参照が変わったときだけ新配列を生成（同一記事ホバー時の再レイアウト防止）
  const wcWords = useMemo(
    () => wcKeywords?.map((k) => ({ text: k.word, value: k.score })) ?? [],
    [wcKeywords]
  );

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 60,
        width,
        background: "var(--surface-alt)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        zIndex: 50,
        transition: "width 0.2s ease",
        overflow: "hidden",
        color: "var(--text)",
      }}
    >
      {/* ヘッダー */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: collapsed ? "center" : "space-between",
        padding: collapsed ? "10px 0" : "10px 10px 10px 14px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        minHeight: 44,
        boxSizing: "border-box",
      }}>
        {!collapsed && (
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
            再生キュー
            {queue.length > 0 && (
              <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>
                ({queue.length})
              </span>
            )}
            {queue.length > 0 && (
              <button
                onClick={handleClearAll}
                title="キューを全削除"
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontSize: 11,
                  color: "var(--danger)",
                  padding: "1px 5px",
                  lineHeight: 1.4,
                  fontWeight: 400,
                }}
              >
                全削除
              </button>
            )}
          </span>
        )}
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? "展開" : "圧縮"}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 16,
            color: "var(--text-muted)",
            padding: "2px 4px",
            lineHeight: 1,
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      {/* キューリスト */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0, overflowY: "auto", flex: 1, minHeight: 0 }}>
        {loading && (
          <li style={{ padding: "12px", color: "var(--text-muted)", fontSize: 13 }}>読み込み中…</li>
        )}
        {!loading && queue.length === 0 && (
          <li style={{
            padding: collapsed ? "12px 4px" : "16px 12px",
            color: "var(--text-muted)",
            fontSize: 12,
            textAlign: "center",
            lineHeight: 1.7,
          }}>
            {collapsed ? "—" : (
              <>
                <div style={{ fontSize: 22, marginBottom: 4 }}>📭</div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>キューは空です</div>
                <div style={{ fontSize: 11 }}>記事をダブルクリック、または「▶ 再生」「キューに追加」で登録できます。</div>
              </>
            )}
          </li>
        )}
        {queue.map((item) => {
          const isCurrentItem =
            currentArticleId !== null &&
            queue[0]?.articleId === currentArticleId &&
            item.id === queue[0]?.id;
          return (
            <SidebarItem
              key={item.id}
              item={item}
              isPlaying={isCurrentItem}
              collapsed={collapsed}
              isDragOver={dragOverId === item.id}
              onRemove={handleRemove}
              onDragStart={(id) => { dragId.current = id; }}
              onDragOver={() => setDragOverId(item.id)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverId((prev) => prev === item.id ? null : prev);
                }
              }}
              onDrop={handleDrop}
              onDragEnd={() => { dragId.current = null; setDragOverId(null); }}
              onSelect={onSelectArticle}
              onDoubleClick={() => handleDoubleClick(item).catch(() => {})}
              onArticleContextMenu={onArticleContextMenu}
              itemRef={(el) => {
                if (el) itemRefs.current.set(item.id, el);
                else itemRefs.current.delete(item.id);
              }}
            />
          );
        })}
      </ul>

      {/* Undo トースト（展開時のみ） */}
      {!collapsed && undoToast && (
        <div style={{
          position: "absolute", left: 8, right: 8, bottom: 8, zIndex: 60,
          background: "var(--text)", color: "var(--bg)", borderRadius: 6,
          padding: "8px 10px", display: "flex", alignItems: "center", gap: 8,
          fontSize: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
        }}>
          <span style={{ flex: 1 }}>{undoToast.msg}</span>
          <button
            onClick={undoToast.action}
            style={{ background: "none", border: "1px solid currentColor", borderRadius: 4, color: "inherit", cursor: "pointer", fontSize: 12, padding: "2px 8px", boxShadow: "none", flexShrink: 0 }}
          >
            元に戻す
          </button>
          <button
            onClick={() => setUndoToast(null)}
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, boxShadow: "none", padding: "0 2px", flexShrink: 0, lineHeight: 1 }}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      )}

      {/* ワードクラウドエリア（展開時のみ） */}
      {!collapsed && (
        <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)" }}>
          {/* 折り畳みヘッダー行（トグル + ピン留め） */}
          <div style={{ display: "flex", alignItems: "center", borderBottom: wcOpen ? "1px solid var(--border)" : "none" }}>
          <button
            onClick={() => setWcOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              flex: 1,
              minWidth: 0,
              background: "none",
              border: "none",
              borderRadius: 0,
              cursor: "pointer",
              padding: "6px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-muted)",
              textAlign: "left",
              boxShadow: "none",
            }}
          >
            <span style={{ fontSize: 9, lineHeight: 1 }}>{wcOpen ? "▾" : "▸"}</span>
            キーワード
            {(wcDateLabel !== null || wcTitle !== null) && (
              <>
                {wcDateLabel !== null ? (
                  <span style={{ fontSize: 11, lineHeight: 1, flexShrink: 0 }}>📅</span>
                ) : wcArticleUrl ? (
                  <img
                    src={getFaviconUrl(wcArticleUrl)}
                    width={12}
                    height={12}
                    alt=""
                    style={{ flexShrink: 0, objectFit: "contain", borderRadius: 1, display: "inline-block" }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                ) : null}
                <span style={{
                  fontWeight: 400,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  marginLeft: 3,
                  color: "var(--text-muted)",
                }}>
                  {wcDateLabel ?? wcTitle}
                </span>
              </>
            )}
          </button>
          {wcOpen && (wcArticleId !== null || wcDateLabel !== null) && (
            <button
              onClick={() => setWcPinned((v) => !v)}
              title={wcPinned
                ? "ピン留めを解除（ホバーで切り替わるようになります）"
                : "現在の表示をピン留め（ホバーしても変わらないようにします）"}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "4px 8px", flexShrink: 0, color: wcPinned ? "var(--accent)" : "var(--text-muted)",
                opacity: wcPinned ? 1 : 0.5, boxShadow: "none", lineHeight: 1,
                display: "inline-flex", alignItems: "center",
              }}
            >
              <Pin size={14} fill={wcPinned ? "currentColor" : "none"} />
            </button>
          )}
          </div>

          {/* ワードクラウド本体 */}
          {wcOpen && (
            <div style={{ padding: "8px 10px 10px" }}>
              {wcArticleId === null && wcDateLabel === null ? (
                <div style={{
                  color: "var(--text-muted)",
                  fontSize: 11,
                  textAlign: "center",
                  padding: "16px 0",
                  lineHeight: 1.6,
                }}>
                  記事にホバーすると<br />キーワードが表示されます
                </div>
              ) : wcLoading ? (
                <div style={{
                  color: "var(--text-muted)",
                  fontSize: 11,
                  textAlign: "center",
                  padding: "16px 0",
                }}>
                  分析中…
                </div>
              ) : !wcKeywords || wcKeywords.length === 0 ? (
                <div style={{
                  color: "var(--text-muted)",
                  fontSize: 11,
                  textAlign: "center",
                  padding: "16px 0",
                }}>
                  キーワードなし
                </div>
              ) : (
                <WordCloud
                  words={wcWords}
                  width={218}
                  height={156}
                  onWordClick={onWordClick}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

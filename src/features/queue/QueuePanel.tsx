import { useRef, useState, useLayoutEffect } from "react";
import { useQueue } from "./useQueue";
import type { Article, PlaybackState, QueueItem } from "@/shared/types";
import type { AudioCacheMap } from "@/features/articles/useAudioCache";
import type { CacheMeta } from "@/lib/audioCache";

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function QueueRow({
  item,
  isPlaying,
  cacheMeta,
  synthProgress,
  isDragOver,
  onRemove,
  onDeleteCache,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onSelect,
  itemRef,
}: {
  item: QueueItem;
  isPlaying: boolean;
  cacheMeta: CacheMeta | undefined;
  synthProgress: { done: number; total: number } | null;
  isDragOver: boolean;
  onRemove: (id: number) => void;
  onDeleteCache?: (articleId: number) => void;
  onDragStart: (id: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (targetId: number) => void;
  onSelect?: (article: Article) => void;
  itemRef?: (el: HTMLLIElement | null) => void;
}) {
  const title = item.article.title ?? item.article.url;
  const showProgress = isPlaying && synthProgress !== null && synthProgress.done < synthProgress.total;

  return (
    <li
      ref={itemRef}
      draggable
      onDragStart={() => onDragStart(item.id)}
      onDragOver={(e) => { e.preventDefault(); onDragOver(e); }}
      onDragLeave={onDragLeave}
      onDrop={() => onDrop(item.id)}
      style={{
        padding: "8px 4px",
        borderBottom: "1px solid #eee",
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: isPlaying ? "rgba(0,102,204,0.08)" : "transparent",
        cursor: "grab",
        // ドロップ先インジケーター（上端にライン）
        boxShadow: isDragOver ? "inset 0 2px 0 0 var(--accent)" : "none",
        transition: "background 0.1s ease, box-shadow 0.12s ease",
      }}
    >
      <span style={{ color: "var(--text-muted)", fontSize: 14 }}>☰</span>
      <div
        style={{ flex: 1, overflow: "hidden", cursor: onSelect ? "pointer" : "grab" }}
        onClick={() => onSelect?.(item.article)}
      >
        <div style={{ fontWeight: isPlaying ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {isPlaying && <span style={{ color: "var(--accent)", marginRight: 4 }}>▶</span>}
          {title}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          {showProgress ? (
            <span style={{ color: "var(--warning)" }}>
              合成中 {synthProgress!.done}/{synthProgress!.total}文…
            </span>
          ) : cacheMeta ? (
            <>
              {cacheMeta.isComplete ? (
                <span>♪ {formatDuration(cacheMeta.totalDurationSeconds)}</span>
              ) : (
                <span style={{ color: "var(--warning)" }}>
                  ♪ {cacheMeta.sentenceCount}文合成済み (部分)
                </span>
              )}
              {onDeleteCache && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteCache(item.articleId); }}
                  style={{
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    padding: "0 2px",
                    textDecoration: "underline",
                  }}
                  title="音声キャッシュを削除"
                >
                  キャッシュ削除
                </button>
              )}
            </>
          ) : (
            <span>未合成</span>
          )}
        </div>
      </div>
      <button style={{ fontSize: 12, color: "var(--danger)" }} onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}>
        削除
      </button>
    </li>
  );
}

export function QueuePanel({
  playbackState,
  cacheMap,
  synthProgress,
  onSelectArticle,
  onSkip,
  onDeleteCache,
}: {
  playbackState: PlaybackState;
  cacheMap: AudioCacheMap;
  synthProgress?: { done: number; total: number } | null;
  onSelectArticle?: (article: Article) => void;
  onSkip?: () => void;
  onDeleteCache?: (articleId: number) => void;
}) {
  const { queue, loading, remove, reorder } = useQueue();
  const dragId = useRef<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

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

  const totalCachedDuration = queue.reduce(
    (sum, q) => {
      const meta = cacheMap.get(q.articleId);
      return sum + (meta?.isComplete ? meta.totalDurationSeconds : 0);
    },
    0
  );

  const currentArticleId =
    playbackState.phase === "playing" ||
    playbackState.phase === "paused" ||
    playbackState.phase === "synthesizing" ||
    playbackState.phase === "error"
      ? playbackState.articleId
      : null;

  function handleRemove(id: number) {
    const isCurrentlyPlaying =
      currentArticleId !== null &&
      queue[0]?.id === id &&
      queue[0]?.articleId === currentArticleId;
    if (isCurrentlyPlaying && onSkip) {
      onSkip();
    } else {
      remove(id);
    }
  }

  function capturePositions() {
    const positions = new Map<number, number>();
    itemRefs.current.forEach((el, id) => {
      positions.set(id, el.getBoundingClientRect().top);
    });
    prevPositionsRef.current = positions;
  }

  function handleDrop(targetId: number) {
    if (dragId.current === null || dragId.current === targetId) return;
    const ids = queue.map((q) => q.id);
    const fromIdx = ids.indexOf(dragId.current);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId.current);

    capturePositions();
    isReorderingRef.current = true;
    reorder(next);
    dragId.current = null;
    setDragOverId(null);
  }

  return (
    <section>
      <h2 style={{ margin: "0 0 8px" }}>
        再生キュー
        {queue.length > 0 && totalCachedDuration > 0 && (
          <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
            合計: {formatDuration(totalCachedDuration)}
          </span>
        )}
      </h2>

      {loading ? (
        <p>読み込み中…</p>
      ) : queue.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>キューが空です</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {queue.map((item) => {
            const isCurrentItem =
              currentArticleId !== null &&
              queue[0]?.articleId === currentArticleId &&
              item.id === queue[0]?.id;
            return (
              <QueueRow
                key={item.id}
                item={item}
                isPlaying={isCurrentItem}
                cacheMeta={cacheMap.get(item.articleId)}
                synthProgress={isCurrentItem ? (synthProgress ?? null) : null}
                isDragOver={dragOverId === item.id}
                onRemove={handleRemove}
                onDeleteCache={onDeleteCache}
                onDragStart={(id) => { dragId.current = id; }}
                onDragOver={() => setDragOverId(item.id)}
                onDragLeave={() => setDragOverId((prev) => prev === item.id ? null : prev)}
                onDrop={handleDrop}
                onSelect={onSelectArticle}
                itemRef={(el) => {
                  if (el) itemRefs.current.set(item.id, el);
                  else itemRefs.current.delete(item.id);
                }}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

import { useState, useEffect, useCallback } from "react";
import { getQueue, addToQueue, removeFromQueue, reorderQueue } from "@/lib/tauriCommands";
import type { QueueItem } from "@/shared/types";
import { ARTICLES_CHANGED_EVENT } from "@/features/articles/useArticles";

export const QUEUE_CHANGED_EVENT = "queue:changed";

export function useQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getQueue();
      setQueue(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function handleChanged() { load(); }
    window.addEventListener(QUEUE_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, handleChanged);
  }, [load]);

  const add = useCallback(async (articleId: number) => {
    await addToQueue(articleId);
    await load();
  }, [load]);

  const remove = useCallback(async (id: number) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
    try {
      await removeFromQueue(id);
      // 削除完了後に再取得して競合による再表示を防ぐ
      await load();
    } catch {
      await load(); // 失敗時はサーバー状態に戻す
    }
  }, [load]);

  const reorder = useCallback(async (orderedIds: number[]) => {
    setQueue((prev) => {
      const map = new Map(prev.map((q) => [q.id, q]));
      return orderedIds
        .map((id, i) => ({ ...map.get(id)!, position: i + 1 }))
        .filter(Boolean);
    });
    await reorderQueue(orderedIds);
  }, []);

  const clearAll = useCallback(async (currentQueue: QueueItem[]) => {
    setQueue([]);
    await Promise.all(currentQueue.map((q) => removeFromQueue(q.id).catch(() => {})));
    // 記事の status（queued → 非queued）を更新するために通知
    window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
    window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
  }, []);

  // Undo 用: 指定した記事 ID 順でキューを復元する
  const restore = useCallback(async (articleIds: number[]) => {
    for (const id of articleIds) {
      await addToQueue(id).catch(() => {});
    }
    const q = await getQueue();
    const idByArticle = new Map(q.map((item) => [item.articleId, item.id]));
    const orderedIds = articleIds
      .map((aid) => idByArticle.get(aid))
      .filter((x): x is number => x !== undefined);
    if (orderedIds.length) await reorderQueue(orderedIds);
    await load();
    window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
  }, [load]);

  return { queue, loading, reload: load, add, remove, reorder, clearAll, restore };
}

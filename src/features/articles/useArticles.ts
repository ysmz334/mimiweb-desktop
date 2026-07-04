import { useState, useEffect, useCallback } from "react";
import {
  getArticles,
  deleteArticle,
  retryExtract,
  addToQueue,
  getQueue,
  reorderQueue,
  toggleFavorite as toggleFavoriteCmd,
} from "@/lib/tauriCommands";
import type { Article, ArticleFilter } from "@/shared/types";

export const ARTICLES_CHANGED_EVENT = "articles:changed";

export function useArticles(filter?: ArticleFilter) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getArticles(filter);
      setArticles(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function handleChanged() { load(); }
    window.addEventListener(ARTICLES_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(ARTICLES_CHANGED_EVENT, handleChanged);
  }, [load]);

  const remove = useCallback(async (id: number) => {
    await deleteArticle(id);
    setArticles((prev) => prev.filter((a) => a.id !== id));
    // DB 側で queue_items は ON DELETE CASCADE される。サイドバーの再生キュー表示を
    // 更新するため QUEUE_CHANGED_EVENT を発火する（これがないと削除済み記事がキューに残って見える）
    window.dispatchEvent(new CustomEvent("queue:changed"));
  }, []);

  const retry = useCallback(async (id: number) => {
    await retryExtract(id);
    setArticles((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, status: "extracting" as const } : a
      )
    );
  }, []);

  const addArticle = useCallback((article: Article) => {
    setArticles((prev) => [article, ...prev]);
    window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
  }, []);

  const enqueue = useCallback(async (id: number) => {
    await addToQueue(id);
    setArticles((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: "queued" as const } : a))
    );
    window.dispatchEvent(new CustomEvent("queue:changed"));
  }, []);

  const toggleFavorite = useCallback(async (id: number) => {
    const updated = await toggleFavoriteCmd(id);
    setArticles((prev) => prev.map((a) => (a.id === id ? updated : a)));
  }, []);

  // キューの先頭に追加する（既にキュー内にある場合は先頭へ移動）
  const enqueueFirst = useCallback(async (id: number) => {
    let queue = await getQueue();
    const existing = queue.find((q) => q.articleId === id);
    if (!existing) {
      await addToQueue(id);
      queue = await getQueue();
    }
    const target = queue.find((q) => q.articleId === id);
    if (target && queue[0]?.id !== target.id) {
      const otherIds = queue.filter((q) => q.id !== target.id).map((q) => q.id);
      await reorderQueue([target.id, ...otherIds]);
    }
    setArticles((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: "queued" as const } : a))
    );
    window.dispatchEvent(new CustomEvent("queue:changed"));
  }, []);

  return { articles, loading, error, reload: load, remove, retry, addArticle, enqueue, enqueueFirst, toggleFavorite };
}

import { useState, useEffect, useCallback } from "react";
import { getAllMeta, deleteAudio, CACHE_UPDATED_EVENT, type CacheMeta } from "@/lib/audioCache";

export type AudioCacheMap = Map<number, CacheMeta>;

export function useAudioCache() {
  const [cacheMap, setCacheMap] = useState<AudioCacheMap>(new Map());

  const load = useCallback(async () => {
    try {
      const metas = await getAllMeta();
      setCacheMap(new Map(metas.map((m) => [m.articleId, m])));
    } catch {
      /* IndexedDB 未対応環境では無視 */
    }
  }, []);

  useEffect(() => {
    void load();
    const handler = () => { void load(); };
    window.addEventListener(CACHE_UPDATED_EVENT, handler);
    return () => window.removeEventListener(CACHE_UPDATED_EVENT, handler);
  }, [load]);

  const removeCache = useCallback(async (articleId: number) => {
    await deleteAudio(articleId);
    setCacheMap((prev) => {
      const next = new Map(prev);
      next.delete(articleId);
      return next;
    });
    // 他のリスナー（usePlayback 等）にもキャッシュ変化を通知する
    window.dispatchEvent(new CustomEvent(CACHE_UPDATED_EVENT));
  }, []);

  return { cacheMap, removeCache };
}

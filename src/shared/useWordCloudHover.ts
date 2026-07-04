import { useState, useRef, useCallback } from "react";
import { getArticleKeywords } from "@/lib/tauriCommands";
import type { KeywordScore } from "./types";

export interface WordCloudHoverState {
  articleId: number;
  title: string | null;
  pos: { x: number; y: number };
  keywords: KeywordScore[] | null;
  loading: boolean;
}

export function useWordCloudHover() {
  const [hover, setHover] = useState<WordCloudHoverState | null>(null);
  const cacheRef = useRef<Map<number, KeywordScore[]>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEnter = useCallback(
    (articleId: number, title: string | null, e: React.MouseEvent) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const pos = { x: e.clientX, y: e.clientY };

      timerRef.current = setTimeout(async () => {
        // キャッシュヒット
        if (cacheRef.current.has(articleId)) {
          setHover({
            articleId,
            title,
            pos,
            keywords: cacheRef.current.get(articleId)!,
            loading: false,
          });
          return;
        }

        setHover({ articleId, title, pos, keywords: null, loading: true });

        try {
          const scores = await getArticleKeywords(articleId);
          cacheRef.current.set(articleId, scores);
          setHover((prev) =>
            prev?.articleId === articleId
              ? { ...prev, keywords: scores, loading: false }
              : prev
          );
        } catch {
          setHover((prev) =>
            prev?.articleId === articleId
              ? { ...prev, keywords: [], loading: false }
              : prev
          );
        }
      }, 400);
    },
    []
  );

  const onLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setHover(null);
  }, []);

  return { hover, onEnter, onLeave };
}

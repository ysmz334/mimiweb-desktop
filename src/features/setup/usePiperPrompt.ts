import { useState, useRef, useCallback, useEffect } from "react";
import type { ArticleLanguage } from "@/shared/types";

/** バナーの種類: registered = 登録時誘導 / fallback = フォールバック再生通知（文言差し替え） */
export type PiperPromptKind = "registered" | "fallback";

/**
 * Piper 誘導バナーの状態管理。
 * - 英語文を含む記事（en / mixed）のみ表示要求を受け付ける
 * - セッション中に閉じられた場合は再表示しない
 * - Piper 導入（piperInstalled が true になった瞬間）で表示中のバナーを自動で閉じる
 *
 * Piper 可用性の判定（表示すべき状況かどうか）は呼び出し側（App）が
 * piperInstalled 状態を参照して行う。
 */
export function usePiperPrompt(piperInstalled: boolean | null) {
  const [piperPrompt, setPiperPrompt] = useState<PiperPromptKind | null>(null);
  const dismissedRef = useRef(false);

  const requestPiperPrompt = useCallback((kind: PiperPromptKind, language: ArticleLanguage) => {
    if (dismissedRef.current) return;
    if (language !== "en" && language !== "mixed") return;
    setPiperPrompt(kind);
  }, []);

  const dismissPiperPrompt = useCallback(() => {
    setPiperPrompt(null);
    dismissedRef.current = true;
  }, []);

  useEffect(() => {
    if (piperInstalled === true) setPiperPrompt(null);
  }, [piperInstalled]);

  return { piperPrompt, requestPiperPrompt, dismissPiperPrompt };
}

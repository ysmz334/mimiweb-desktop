import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 1500;

// 自アプリがコピーしたテキスト（一括URLコピー等）を監視対象外にするための無視セット
const selfCopiedTexts = new Set<string>();

/**
 * 自アプリがクリップボードにコピーしたテキストを登録する。
 * 次回のポーリングで一致したとき無視されてセットから消費される。
 */
export function markSelfCopied(text: string): void {
  selfCopiedTexts.add(text);
}

function isHttpUrl(text: string): boolean {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * クリップボードのテキストから有効な URL リストを返す。
 * 改行またはカンマ区切りの複数 URL に対応。
 * 有効な URL のみ抽出して返し、1 件も取れなければ null を返す。
 */
function parseUrls(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (isHttpUrl(trimmed)) return [trimmed];

  const parts = trimmed
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (parts.length <= 1) return null;

  const validUrls = parts.filter(isHttpUrl);
  return validUrls.length > 0 ? validUrls : null;
}

export function useClipboardMonitor({
  enabled = true,
  onUrlDetected,
}: {
  enabled?: boolean;
  onUrlDetected: (url: string) => void;
}) {
  const seenRef = useRef<Set<string>>(new Set());
  const onUrlDetectedRef = useRef(onUrlDetected);
  onUrlDetectedRef.current = onUrlDetected;

  useEffect(() => {
    if (!enabled) return;

    async function check() {
      try {
        const rawText = await navigator.clipboard.readText();
        const trimmed = rawText.trim();

        // 自アプリがコピーしたテキストは無視（一括URLコピー等）
        if (selfCopiedTexts.has(trimmed)) {
          selfCopiedTexts.delete(trimmed);
          const urls = parseUrls(trimmed) ?? [];
          for (const url of urls) seenRef.current.add(url);
          return;
        }

        const urls = parseUrls(trimmed);
        if (!urls) return;
        for (const url of urls) {
          if (!seenRef.current.has(url)) {
            seenRef.current.add(url);
            onUrlDetectedRef.current(url);
          }
        }
      } catch {
        // clipboard access denied or unavailable — ignore silently
      }
    }

    // Initialize seen set from current clipboard without triggering onUrlDetected
    navigator.clipboard.readText().then((text) => {
      const urls = parseUrls(text.trim()) ?? [];
      for (const url of urls) seenRef.current.add(url);
    }).catch(() => {});

    const intervalId = setInterval(check, POLL_INTERVAL_MS);
    window.addEventListener("focus", check);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener("focus", check);
    };
  }, [enabled]);
}

import { useEffect } from "react";
import {
  onExtractionStarted,
  onExtractionCompleted,
  onExtractionFailed,
  saveExtractedContent,
  markExtractionError,
  fetchPageHtml,
} from "@/lib/tauriCommands";
import { ContentExtractor } from "@/lib/contentExtractor";
import { ARTICLES_CHANGED_EVENT } from "./useArticles";

/**
 * Tauri の記事抽出イベントをアプリ全体で受信するフック。
 * AppMain（常時マウント）で呼び出すことで、ユーザーがどのタブにいても
 * イベントを取り逃がさない。
 */
export function useExtractionListener() {
  // article:extraction-started: WebView スクレイピング完了 → JS 側で本文抽出
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    onExtractionStarted(async ({ id, html, url }) => {
      const firstResult = ContentExtractor.extract(html, url);

      if (!firstResult.success) {
        const fallback = firstResult.fallbackText;
        if (fallback.trim()) {
          await saveExtractedContent(id, url, fallback, null);
        } else {
          await markExtractionError(id, firstResult.reason);
        }
        window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
        return;
      }

      let title = firstResult.title || url;
      let textContent = firstResult.textContent;
      let contentHtml = firstResult.contentHtml;
      let nextPageUrl = firstResult.nextPageUrl;
      let pageCount = 1;
      const visitedUrls = new Set<string>([url]);

      while (nextPageUrl && pageCount < 10) {
        if (visitedUrls.has(nextPageUrl)) break;
        visitedUrls.add(nextPageUrl);
        try {
          const nextHtml = await fetchPageHtml(nextPageUrl);
          const nextResult = ContentExtractor.extract(nextHtml, nextPageUrl);
          if (nextResult.success && nextResult.textContent.trim()) {
            textContent += "\n\n" + nextResult.textContent;
            if (contentHtml && nextResult.contentHtml) {
              contentHtml += "\n" + nextResult.contentHtml;
            }
            nextPageUrl = nextResult.nextPageUrl;
            pageCount++;
          } else {
            break;
          }
        } catch {
          break;
        }
      }

      try {
        await saveExtractedContent(id, title, textContent, contentHtml);
      } catch (e) {
        await markExtractionError(id, String(e));
      }
      window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  // article:extraction-completed / article:extraction-failed: いずれも ARTICLES_CHANGED_EVENT を dispatch
  useEffect(() => {
    let unlistenCompleted: (() => void) | null = null;
    let unlistenFailed: (() => void) | null = null;

    onExtractionCompleted(() => {
      window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
    }).then((fn) => { unlistenCompleted = fn; });

    onExtractionFailed(() => {
      window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
    }).then((fn) => { unlistenFailed = fn; });

    return () => {
      unlistenCompleted?.();
      unlistenFailed?.();
    };
  }, []);
}

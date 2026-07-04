import { Readability, isProbablyReaderable } from "@mozilla/readability";
import type { ExtractionResult } from "@/shared/types";

function extractTitleFromJsonLd(doc: Document): string {
  for (const script of doc.querySelectorAll(
    'script[type="application/ld+json"]',
  )) {
    try {
      const raw = script.textContent;
      if (!raw) continue;
      const data: unknown = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const headline = record["headline"] ?? record["name"];
          if (typeof headline === "string" && headline.trim()) {
            return headline.trim();
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return "";
}

function extractTitle(doc: Document): string {
  // OGP
  const ogTitle = doc
    .querySelector('meta[property="og:title"]')
    ?.getAttribute("content")
    ?.trim();
  if (ogTitle) return ogTitle;

  // Twitter Card
  const twitterTitle = doc
    .querySelector('meta[name="twitter:title"]')
    ?.getAttribute("content")
    ?.trim();
  if (twitterTitle) return twitterTitle;

  // JSON-LD headline (schema.org NewsArticle など)
  const jsonLdTitle = extractTitleFromJsonLd(doc);
  if (jsonLdTitle) return jsonLdTitle;

  // itemprop="headline"
  const itempropTitle = doc
    .querySelector('[itemprop="headline"]')
    ?.textContent?.trim();
  if (itempropTitle) return itempropTitle;

  // <title> 要素（ソーシャルOGが無いサイト向け）
  const docTitle = doc.title?.trim();
  if (docTitle) return docTitle;

  // h1
  const h1 = doc.querySelector("h1")?.textContent?.trim();
  if (h1) return h1;

  return "";
}

/**
 * 非リンクテキスト量が最も多いコンテナを返す。
 * article / main / [role="main"] を候補として採点し、リンク密度が低い（＝本文が多い）要素を選ぶ。
 */
function selectBestContainer(doc: Document): Element | null {
  const candidates: Element[] = [
    ...Array.from(doc.querySelectorAll("article")),
    ...Array.from(doc.querySelectorAll('main, [role="main"]')),
  ];
  if (candidates.length === 0) return null;

  let bestEl: Element | null = null;
  let bestScore = -1;
  for (const el of candidates) {
    const total = el.textContent?.trim().length ?? 0;
    if (total < 200) continue;
    const linkLen = Array.from(el.querySelectorAll("a")).reduce(
      (sum, a) => sum + (a.textContent?.trim().length ?? 0),
      0,
    );
    const score = total - linkLen;
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }
  return bestEl;
}

/**
 * script/style 除去後、ページ構造ノイズを取り除いてから記事本文コンテナに絞り込む。
 * doc は破壊的に変更されるため、cleanBodyText 取得後に呼ぶこと。
 */
function preprocessForReadability(doc: Document): void {
  // トップレベルの構造ノイズを除去
  for (const sel of [
    "header", "footer", "nav", "aside",
    '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]', '[role="complementary"]',
  ]) {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  }

  const container = selectBestContainer(doc);
  if (!container) return;

  // コンテナ内部のナビゲーション要素を除去
  container.querySelectorAll('nav, [role="navigation"]').forEach((el) => el.remove());

  // コンテナ内部のリンク過多リスト（サイトマップ・タグ一覧・関連記事リスト）を除去。
  // ul/ol 内テキストの 70% 以上がリンクテキストなら本文でないと判断する。
  for (const list of Array.from(container.querySelectorAll("ul, ol"))) {
    if (!(list as Element).isConnected) continue;
    const total = ((list as Element).textContent?.trim() ?? "").length;
    if (total < 10) { (list as Element).remove(); continue; }
    const links = (list as Element).querySelectorAll("a");
    const linkLen = Array.from(links).reduce(
      (sum, a) => sum + (a.textContent?.trim().length ?? 0),
      0,
    );
    if (links.length >= 2 && linkLen / total > 0.7) {
      (list as Element).remove();
    }
  }

  doc.body.innerHTML = "";
  doc.body.appendChild(container);
}

/**
 * 次ページURLを返す。検出できない場合は null。
 * preprocessForReadability が nav 要素を除去する前に呼ぶこと。
 *
 * 検出優先順位:
 *   1. <link rel="next">           — SEO標準、headにあるため前処理に影響されない
 *   2. <a rel="next">              — アンカーのrel属性
 *   3. ?page=currentPage+1 パターン — テキスト不問。Yahoo News等クエリパラメータ方式の確実な検出
 *   4. 「次へ」等のテキスト・aria-label を持つリンク
 */
function extractNextPageUrl(doc: Document, baseUrl: string): string | null {
  let normalizedBase: string;
  let baseOrigin: string;
  let basePath: string;
  let currentPage: number;
  try {
    const baseObj = new URL(baseUrl);
    normalizedBase = baseObj.href;
    baseOrigin = baseObj.origin;
    basePath = baseObj.pathname;
    currentPage = Math.max(1, parseInt(baseObj.searchParams.get("page") ?? "1", 10) || 1);
  } catch {
    return null;
  }

  function resolveAndValidate(href: string | null): string | null {
    if (!href || href.startsWith("#")) return null;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.origin !== baseOrigin) return null;
      if (resolved.href === normalizedBase) return null;
      return resolved.href;
    } catch {
      return null;
    }
  }

  // 1. <link rel="next"> in head
  const url1 = resolveAndValidate(
    doc.querySelector('link[rel="next"]')?.getAttribute("href") ?? null
  );
  if (url1) return url1;

  // 2. <a rel="next">
  const url2 = resolveAndValidate(
    doc.querySelector('a[rel="next"]')?.getAttribute("href") ?? null
  );
  if (url2) return url2;

  // 3. ?page=(currentPage+1) かつ同一パスのリンク（テキスト不問）
  // Yahoo News等 ?page=N 形式のサイトで確実に機能する
  const nextPage = currentPage + 1;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href");
    if (!href) continue;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.origin !== baseOrigin) continue;
      if (resolved.pathname !== basePath) continue;
      if (parseInt(resolved.searchParams.get("page") ?? "0", 10) === nextPage) {
        return resolved.href;
      }
    } catch {
      continue;
    }
  }

  // 4. 「次へ」等のテキスト・aria-label を持つリンク（同一ドメイン）
  const nextPattern = /^(次へ|次のページ|次ページ|next page|next|›|»|>)$/i;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const text = (a.textContent?.trim() ?? "").replace(/\s+/g, " ");
    const aria = (a.getAttribute("aria-label") ?? "").trim();
    if (nextPattern.test(text) || nextPattern.test(aria)) {
      const url = resolveAndValidate(a.getAttribute("href"));
      if (url) return url;
    }
  }

  return null;
}

/**
 * body を clone してから script/style だけ除去したテキストを返す。
 * doc 本体は変更しない。
 */
function getCleanBodyText(body: HTMLElement | null): string {
  if (!body) return "";
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script, style").forEach((el) => el.remove());
  return clone.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export class ContentExtractor {
  static extract(html: string, url: string): ExtractionResult {
    // try ブロック外で宣言することで、例外発生時も catch から参照できる
    let cleanBodyText = "";
    let extractedTitle = "";

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const base = doc.createElement("base");
      base.href = url;
      doc.head.prepend(base);

      extractedTitle = extractTitle(doc);
      // clone ベースで fallback テキストを確保（doc は汚染しない）
      cleanBodyText = getCleanBodyText(doc.body);

      console.log(
        `[ContentExtractor] url=${url}`,
        `html.length=${html.length}`,
        `cleanBodyText.length=${cleanBodyText.length}`,
        `title="${extractedTitle}"`,
      );

      // preprocessForReadability が nav 要素を除去する前に次ページURLを検出する
      const nextPageUrl = extractNextPageUrl(doc, url) ?? undefined;

      // Readability に渡す前に doc から script/style を除去し、本文コンテナに絞り込む
      doc.querySelectorAll("script, style").forEach((el) => el.remove());
      preprocessForReadability(doc);

      if (!isProbablyReaderable(doc)) {
        console.log("[ContentExtractor] not readerable → fallback text");
        return {
          success: true,
          title: extractedTitle,
          textContent: cleanBodyText,
          contentHtml: null,
          isLikelyArticle: false,
          nextPageUrl,
        };
      }

      const reader = new Readability(doc);
      const article = reader.parse();

      const readabilityTextLen = article?.textContent?.trim().length ?? 0;
      console.log(
        "[ContentExtractor] Readability →",
        article
          ? `title="${article.title}" textContent.length=${readabilityTextLen}`
          : "null",
      );

      // Readability が何も取れなかった、または極端に短い場合は cleanBodyText を優先する
      const MIN_READABILITY_LEN = 50;
      if (!article || readabilityTextLen < MIN_READABILITY_LEN) {
        if (cleanBodyText) {
          return {
            success: true,
            title: extractedTitle,
            textContent: cleanBodyText,
            contentHtml: null,
            isLikelyArticle: false,
            nextPageUrl,
          };
        }
        return {
          success: false,
          fallbackText: cleanBodyText,
          reason: "Readability はコンテンツを抽出できませんでした",
        };
      }

      return {
        success: true,
        title: article.title?.trim() || extractedTitle,
        textContent: article.textContent ?? "",
        contentHtml: article.content ?? null,
        isLikelyArticle: true,
        nextPageUrl,
      };
    } catch (e) {
      console.error("[ContentExtractor] exception:", e);
      return {
        success: false,
        fallbackText: cleanBodyText,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

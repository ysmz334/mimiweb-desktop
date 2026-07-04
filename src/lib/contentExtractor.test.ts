import { describe, it, expect } from "vitest";
import { ContentExtractor } from "./contentExtractor";

const BASE_URL = "https://example.com/article";

// 十分なテキスト量を持つ通常の記事 HTML
const ARTICLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>テスト記事</title></head>
<body>
<article>
  <h1>テスト記事タイトル</h1>
  <p>これは記事の本文です。Readability が読み取れる量のテキストが含まれています。
     Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.</p>
  <p>第2段落: ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation
     ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor.</p>
  <p>第3段落: Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt
     mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem.</p>
  <p>第4段落: Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit,
     sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.</p>
</article>
</body>
</html>
`;

// コンテンツが少ない SPA 風 HTML
const SPA_HTML = `
<!DOCTYPE html>
<html>
<head><title>SPA アプリ</title></head>
<body>
<div id="root"></div>
</body>
</html>
`;

// 空の body
const EMPTY_HTML = `
<!DOCTYPE html>
<html><head></head><body></body></html>
`;

describe("ContentExtractor", () => {
  describe("通常の記事 HTML", () => {
    it("success:true かつ isLikelyArticle:true を返す", () => {
      const result = ContentExtractor.extract(ARTICLE_HTML, BASE_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.isLikelyArticle).toBe(true);
        expect(result.textContent.length).toBeGreaterThan(0);
      }
    });

    it("記事タイトルを返す", () => {
      const result = ContentExtractor.extract(ARTICLE_HTML, BASE_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.title).toBeTruthy();
      }
    });

    it("textContent に本文テキストが含まれる", () => {
      const result = ContentExtractor.extract(ARTICLE_HTML, BASE_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.textContent).toContain("テスト記事");
      }
    });
  });

  describe("SPA 風ページ（テキスト不足）", () => {
    it("success:true かつ isLikelyArticle:false を返す", () => {
      const result = ContentExtractor.extract(SPA_HTML, BASE_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.isLikelyArticle).toBe(false);
      }
    });

    it("ExtractionResult 型に準拠している", () => {
      const result = ContentExtractor.extract(SPA_HTML, BASE_URL);
      // success フィールドが存在する
      expect("success" in result).toBe(true);
    });
  });

  describe("空コンテンツ", () => {
    it("success または success:false を返し例外を投げない", () => {
      expect(() => ContentExtractor.extract(EMPTY_HTML, BASE_URL)).not.toThrow();
    });

    it("ExtractionResult の型に準拠している", () => {
      const result = ContentExtractor.extract(EMPTY_HTML, BASE_URL);
      if (result.success) {
        expect(typeof result.textContent).toBe("string");
        expect(typeof result.isLikelyArticle).toBe("boolean");
      } else {
        expect(typeof result.fallbackText).toBe("string");
        expect(typeof result.reason).toBe("string");
      }
    });
  });

  describe("次ページURL検出", () => {
    const PAGE1_URL = "https://example.com/articles/test";

    it("<link rel='next'> から次ページURLを取得する", () => {
      const html = `<!DOCTYPE html><html>
        <head>
          <title>記事</title>
          <link rel="next" href="/articles/test?page=2">
        </head>
        <body><article>
          <h1>タイトル</h1>
          <p>本文テキスト。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
        </article></body>
        </html>`;
      const result = ContentExtractor.extract(html, PAGE1_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBe("https://example.com/articles/test?page=2");
      }
    });

    it("<a rel='next'> から次ページURLを取得する", () => {
      const html = `<!DOCTYPE html><html>
        <head><title>記事</title></head>
        <body>
          <article>
            <h1>タイトル</h1>
            <p>本文テキスト。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          </article>
          <nav><a rel="next" href="/articles/test?page=2">次へ</a></nav>
        </body>
        </html>`;
      const result = ContentExtractor.extract(html, PAGE1_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBe("https://example.com/articles/test?page=2");
      }
    });

    it("「次へ」テキストのリンクから次ページURLを取得する", () => {
      const html = `<!DOCTYPE html><html>
        <head><title>記事</title></head>
        <body>
          <article>
            <h1>タイトル</h1>
            <p>本文テキスト。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          </article>
          <div class="pagination">
            <span>1 / 2ページ</span>
            <a href="/articles/test?page=2">次へ</a>
          </div>
        </body>
        </html>`;
      const result = ContentExtractor.extract(html, PAGE1_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBe("https://example.com/articles/test?page=2");
      }
    });

    it("?page=2 を含む同一パスのリンクから次ページURLを取得する（Yahoo News等）", () => {
      const html = `<!DOCTYPE html><html>
        <head><title>記事</title></head>
        <body>
          <article>
            <h1>タイトル</h1>
            <p>本文テキスト。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
            <p>次ページは：<a href="/articles/test?page=2">続きを読む</a></p>
          </article>
          <nav>
            <a href="/articles/test">1</a>
            <a href="/articles/test?page=2">2</a>
            <a href="/articles/test?page=2">次へ</a>
          </nav>
        </body>
        </html>`;
      const result = ContentExtractor.extract(html, PAGE1_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBe("https://example.com/articles/test?page=2");
      }
    });

    it("2ページ目から3ページ目のURLを取得する", () => {
      const html = `<!DOCTYPE html><html>
        <head><title>記事 ページ2</title></head>
        <body>
          <article>
            <h1>タイトル</h1>
            <p>2ページ目の本文。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          </article>
          <nav>
            <a href="/articles/test">1</a>
            <a href="/articles/test?page=2">2</a>
            <a href="/articles/test?page=3">3</a>
            <a href="/articles/test?page=3">次へ</a>
          </nav>
        </body>
        </html>`;
      const page2Url = "https://example.com/articles/test?page=2";
      const result = ContentExtractor.extract(html, page2Url);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBe("https://example.com/articles/test?page=3");
      }
    });

    it("別パスの ?page=2 リンクは次ページと判定しない", () => {
      const html = `<!DOCTYPE html><html>
        <head><title>記事</title></head>
        <body>
          <article>
            <h1>タイトル</h1>
            <p>本文テキスト。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
          </article>
          <nav>
            <a href="/other-articles/test?page=2">関連記事の次ページ</a>
          </nav>
        </body>
        </html>`;
      const result = ContentExtractor.extract(html, PAGE1_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBeUndefined();
      }
    });

    it("次ページがない場合は nextPageUrl が undefined", () => {
      const result = ContentExtractor.extract(ARTICLE_HTML, BASE_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBeUndefined();
      }
    });

    it("別ドメインへのリンクは次ページと判定しない", () => {
      const html = `<!DOCTYPE html><html>
        <head>
          <title>記事</title>
          <link rel="next" href="https://other-domain.com/articles/test?page=2">
        </head>
        <body><article>
          <h1>タイトル</h1>
          <p>本文テキスト。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
        </article></body>
        </html>`;
      const result = ContentExtractor.extract(html, PAGE1_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBeUndefined();
      }
    });

    it("自ページへのループリンクは次ページと判定しない", () => {
      const html = `<!DOCTYPE html><html>
        <head>
          <title>記事</title>
          <link rel="next" href="/articles/test">
        </head>
        <body><article>
          <h1>タイトル</h1>
          <p>本文テキスト。Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
        </article></body>
        </html>`;
      const result = ContentExtractor.extract(html, PAGE1_URL);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.nextPageUrl).toBeUndefined();
      }
    });
  });

  describe("base href の設定", () => {
    it("url 引数が base href として使われる（例外が発生しない）", () => {
      const htmlWithRelativeLinks = `
        <html><body>
        <article>
          <p>本文テキストが続きます。<a href="/relative/path">リンク</a></p>
          <p>第2段落: Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.</p>
          <p>第3段落: Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip.</p>
          <p>第4段落: Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat.</p>
        </article>
        </body></html>
      `;
      expect(() =>
        ContentExtractor.extract(htmlWithRelativeLinks, "https://example.com")
      ).not.toThrow();
    });
  });
});

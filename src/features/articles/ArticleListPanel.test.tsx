import { render, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Article } from "@/shared/types";

const {
  mockGetArticles,
  mockRegisterTextArticle,
  mockRegisterArticle,
} = vi.hoisted(() => ({
  mockGetArticles: vi.fn(),
  mockRegisterTextArticle: vi.fn(),
  mockRegisterArticle: vi.fn(),
}));

vi.mock("@/lib/tauriCommands", () => ({
  getArticles: mockGetArticles,
  registerArticle: mockRegisterArticle,
  registerTextArticle: mockRegisterTextArticle,
  deleteArticle: vi.fn(),
  retryExtract: vi.fn(),
  addToQueue: vi.fn(),
  getQueue: vi.fn().mockResolvedValue([]),
  reorderQueue: vi.fn(),
  toggleFavorite: vi.fn(),
}));

import { ArticleListPanel } from "./ArticleListPanel";

const TEXT_ARTICLE: Article = {
  id: 2,
  url: "text://00000000-0000-4000-8000-000000000000",
  title: "貼り付けたテキスト記事",
  content: "本文です。",
  contentHtml: null,
  status: "ready",
  errorMessage: null,
  registeredAt: new Date().toISOString(),
  extractedAt: new Date().toISOString(),
  isFavorite: false,
  language: "ja",
  sourceType: "text",
};

const CONTENT_PLACEHOLDER = "読み上げるテキストを貼り付け";

// 登録後の ARTICLES_CHANGED_EVENT による再フェッチでも記事が残るよう、
// 動的ストアで registerTextArticle → getArticles を連動させる
const articlesStore: Article[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  articlesStore.length = 0;
  mockGetArticles.mockImplementation(async () => [...articlesStore]);
  mockRegisterTextArticle.mockImplementation(async () => {
    articlesStore.unshift(TEXT_ARTICLE);
    return { ok: true, value: TEXT_ARTICLE };
  });
});

describe("ArticleListPanel — テキスト記事の縮退表示 (5.1)", () => {
  const WEB_ARTICLE: Article = {
    id: 3,
    url: "https://example.com/web-article",
    title: "ウェブ記事",
    content: "本文",
    contentHtml: null,
    status: "ready",
    errorMessage: null,
    registeredAt: new Date().toISOString(),
    extractedAt: new Date().toISOString(),
    isFavorite: false,
    language: "ja",
    sourceType: "web",
  };

  it("テキスト記事の行は favicon ではなくテキストアイコンを表示し、URL を出さない", async () => {
    articlesStore.push(TEXT_ARTICLE, WEB_ARTICLE);
    const { container, findByText, queryByText } = render(<ArticleListPanel />);
    await findByText("貼り付けたテキスト記事");

    // テキスト記事アイコン (lucide FileText) が 1 つ、favicon img は web 記事の 1 つのみ
    expect(container.querySelectorAll("svg.lucide-file-text")).toHaveLength(1);
    const faviconImgs = Array.from(container.querySelectorAll("img")).filter((img) =>
      img.src.includes("favicon")
    );
    expect(faviconImgs).toHaveLength(1);

    // プレースホルダ URL (text://) は表示しない
    expect(queryByText(TEXT_ARTICLE.url)).toBeNull();
    // web 記事の URL は従来通り表示される
    expect(queryByText(WEB_ARTICLE.url)).toBeTruthy();
  });

  it("テキスト記事の行では記事アイテムメニューを開かない (web 記事では開く)", async () => {
    articlesStore.push(TEXT_ARTICLE, WEB_ARTICLE);
    const onArticleContextMenu = vi.fn();
    const { findByText } = render(
      <ArticleListPanel onArticleContextMenu={onArticleContextMenu} />
    );

    const textRow = (await findByText("貼り付けたテキスト記事")).closest("li")!;
    fireEvent.contextMenu(textRow);
    expect(onArticleContextMenu).not.toHaveBeenCalled();

    const webRow = (await findByText("ウェブ記事")).closest("li")!;
    fireEvent.contextMenu(webRow);
    expect(onArticleContextMenu).toHaveBeenCalledWith(
      WEB_ARTICLE.url,
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("URL一括コピーはテキスト記事を除外し、テキスト記事のみの日付では表示しない", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    // テキスト記事のみ → コピー対象が無いのでボタン自体を出さない
    articlesStore.push(TEXT_ARTICLE);
    const view1 = render(<ArticleListPanel />);
    await view1.findByText("貼り付けたテキスト記事");
    expect(view1.queryByText("URL一括コピー")).toBeNull();
    view1.unmount();

    // web 記事が混在 → ボタンは出るが web の URL のみコピーされる
    articlesStore.push(WEB_ARTICLE);
    const view2 = render(<ArticleListPanel />);
    const copyBtn = await view2.findByText("URL一括コピー");
    fireEvent.click(copyBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain(WEB_ARTICLE.url);
    expect(copied).not.toContain("text://");
  });
});

describe("ArticleListPanel — 言語バッジとフォールバック警告 (5.2)", () => {
  const WARN_TITLE = "英語文は日本語音声で代読されます（Piper 未導入）";

  const JA_ARTICLE: Article = {
    id: 3,
    url: "https://example.com/ja",
    title: "日本語記事",
    content: "本文",
    contentHtml: null,
    status: "ready",
    errorMessage: null,
    registeredAt: new Date().toISOString(),
    extractedAt: new Date().toISOString(),
    isFavorite: false,
    language: "ja",
    sourceType: "web",
  };
  const EN_ARTICLE: Article = {
    ...JA_ARTICLE,
    id: 4,
    url: "https://example.com/en",
    title: "English Article",
    language: "en",
  };
  const MIXED_ARTICLE: Article = {
    ...JA_ARTICLE,
    id: 5,
    url: "text://00000000-0000-4000-8000-000000000005",
    title: "対訳スクリプト",
    language: "mixed",
    sourceType: "text",
  };

  it("en 記事は EN、mixed 記事は JA·EN バッジを表示し、ja 記事にはバッジを出さない", async () => {
    articlesStore.push(JA_ARTICLE, EN_ARTICLE, MIXED_ARTICLE);
    const { findByText, queryAllByText } = render(<ArticleListPanel />);
    await findByText("日本語記事");

    expect(queryAllByText("EN")).toHaveLength(1);
    expect(queryAllByText("JA·EN")).toHaveLength(1);
  });

  it("Piper 未導入時のみ英語文を含む記事に警告バッジが出て、可用性の切替に一斉追従する", async () => {
    articlesStore.push(JA_ARTICLE, EN_ARTICLE, MIXED_ARTICLE);
    const view = render(<ArticleListPanel piperInstalled={true} />);
    await view.findByText("日本語記事");

    // 導入済み → 警告なし
    expect(view.queryAllByTitle(WARN_TITLE)).toHaveLength(0);

    // 未導入 → en / mixed の 2 記事に一斉表示（ja には出ない）
    view.rerender(<ArticleListPanel piperInstalled={false} />);
    expect(view.getAllByTitle(WARN_TITLE)).toHaveLength(2);

    // 導入すると一斉に消える
    view.rerender(<ArticleListPanel piperInstalled={true} />);
    expect(view.queryAllByTitle(WARN_TITLE)).toHaveLength(0);
  });

  it("可用性が未解決 (null) の間は警告バッジを出さない", async () => {
    articlesStore.push(EN_ARTICLE);
    const { findByText, queryAllByTitle } = render(<ArticleListPanel piperInstalled={null} />);
    await findByText("English Article");
    expect(queryAllByTitle(WARN_TITLE)).toHaveLength(0);
  });
});

describe("ArticleListPanel — 登録エリアの URL / テキスト切替 (4.1)", () => {
  it("初期表示は URL フォームで、テキストへ切り替えると本文入力が表示される", async () => {
    const { getByRole, getByPlaceholderText, queryByPlaceholderText } = render(
      <ArticleListPanel />
    );
    await waitFor(() => expect(mockGetArticles).toHaveBeenCalled());

    // 初期状態: URL 入力が表示され、テキスト入力はない
    expect(getByPlaceholderText("https://example.com/article")).toBeTruthy();
    expect(queryByPlaceholderText(CONTENT_PLACEHOLDER)).toBeNull();

    // テキストへ切替
    fireEvent.click(getByRole("button", { name: "テキストで登録" }));
    expect(queryByPlaceholderText("https://example.com/article")).toBeNull();
    expect(getByPlaceholderText(CONTENT_PLACEHOLDER)).toBeTruthy();

    // URL へ戻す
    fireEvent.click(getByRole("button", { name: "URLで登録" }));
    expect(getByPlaceholderText("https://example.com/article")).toBeTruthy();
  });

  it("テキストを貼り付けて登録すると一覧に即時反映される", async () => {
    const { getByRole, getByPlaceholderText, findByText } = render(
      <ArticleListPanel />
    );
    await waitFor(() => expect(mockGetArticles).toHaveBeenCalled());

    fireEvent.click(getByRole("button", { name: "テキストで登録" }));
    fireEvent.change(getByPlaceholderText(CONTENT_PLACEHOLDER), {
      target: { value: "本文です。" },
    });
    fireEvent.click(getByRole("button", { name: "登録" }));

    // 登録した記事が一覧に表示される
    await findByText("貼り付けたテキスト記事");
    expect(mockRegisterTextArticle).toHaveBeenCalledWith("本文です。", undefined);
  });
});

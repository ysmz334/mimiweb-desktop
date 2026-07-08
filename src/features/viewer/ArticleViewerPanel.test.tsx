import { render, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/tauriCommands", () => ({
  fetchPageHtml: vi.fn(),
  registerArticle: vi.fn(),
  getArticleKeywords: vi.fn().mockResolvedValue([]),
}));

import { ArticleViewerPanel } from "./ArticleViewerPanel";
import { buildFullText } from "./viewerUtils";
import { segmentText } from "@/lib/languageSegmenter";
import { splitSentences } from "@/lib/voicevoxClient";
import type { Article, PlaybackState, Result, ArticleError } from "@/shared/types";

// ─── テスト共通データ ──────────────────────────────────────────────────────

const BASE: Omit<Article, "id" | "content" | "language"> = {
  url: "text://fixture",
  title: null,
  contentHtml: null,
  status: "ready",
  errorMessage: null,
  registeredAt: "2026-01-01T00:00:00Z",
  extractedAt: "2026-01-01T00:00:00Z",
  isFavorite: false,
  sourceType: "text",
};

// 英語行が複数文を含む対訳形式: splitSentences(ja) では行ごと1文になるが、
// segmentText(mixed) では英語文分割規則で 2 文に分かれる（分割規則の差が出る形）
const MIXED_CONTENT = "こんにちは。\nHello world. How are you?\nさようなら。";

const MIXED_ARTICLE: Article = {
  ...BASE,
  id: 5,
  content: MIXED_CONTENT,
  language: "mixed",
};

const JA_ARTICLE: Article = {
  ...BASE,
  id: 6,
  content: "これはテスト。次の文です。",
  language: "ja",
  sourceType: "web",
  url: "https://example.com",
};

const IDLE: PlaybackState = { phase: "idle" };

/** プレーンテキストモードの文セグメント span を昇順で取得する */
function segSpans(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-seg-idx]"));
}

/** セグメント span の本文テキスト（行頭の番号ラベルを除く）を取得する */
function segTexts(container: HTMLElement): string[] {
  return segSpans(container).map((el) => el.lastChild?.textContent ?? "");
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── テスト ────────────────────────────────────────────────────────────────

describe("ArticleViewerPanel — セグメンタ統一 (3.2)", () => {
  it("混在記事のプレーンテキスト表示が languageSegmenter の分割と一致する", () => {
    const fullText = buildFullText(MIXED_ARTICLE.title, MIXED_ARTICLE.content, null);
    const expected = segmentText(fullText, "mixed").map((s) => s.text);
    // フィクスチャの前提確認: mixed 分割は英語行を 2 文に分ける（計4文）
    expect(expected).toEqual([
      "こんにちは。",
      "Hello world.",
      "How are you?",
      "さようなら。",
    ]);

    const { container } = render(
      <ArticleViewerPanel
        article={MIXED_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
      />
    );

    expect(segTexts(container)).toEqual(expected);
  });

  it("混在記事のセグメントクリックで segmenter 基準のインデックスが通知される", () => {
    const onSegmentClick = vi.fn();
    const { container } = render(
      <ArticleViewerPanel
        article={MIXED_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSegmentClick={onSegmentClick}
      />
    );

    const spans = segSpans(container);
    expect(spans).toHaveLength(4);

    // "How are you?" は mixed 分割でインデックス 2
    fireEvent.click(spans[2]);
    expect(onSegmentClick).toHaveBeenCalledWith(2);
  });

  it("再生中の segmentIndex が mixed 分割基準の文にハイライトされる", () => {
    const playing: PlaybackState = {
      phase: "playing",
      articleId: MIXED_ARTICLE.id,
      currentTime: 0,
      duration: 0,
    };
    const { container } = render(
      <ArticleViewerPanel
        article={MIXED_ARTICLE}
        playbackState={playing}
        segmentIndex={1}
      />
    );

    const spans = segSpans(container);
    // インデックス 1 = "Hello world."（mixed 分割）がハイライトされる
    expect(spans[1].lastChild?.textContent).toBe("Hello world.");
    expect(spans[1].style.backgroundColor).not.toBe("transparent");
    expect(spans[0].style.backgroundColor).toBe("transparent");
    expect(spans[2].style.backgroundColor).toBe("transparent");
  });

  it("日本語記事の分割は従来の splitSentences と一致する（非退行）", () => {
    const fullText = buildFullText(JA_ARTICLE.title, JA_ARTICLE.content, null);
    const expected = splitSentences(fullText, "ja");

    const { container } = render(
      <ArticleViewerPanel
        article={JA_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
      />
    );

    expect(segTexts(container)).toEqual(expected);
  });
});

describe("ArticleViewerPanel — 言語バッジとフォールバック警告 (5.2)", () => {
  const WARN_TITLE = "英語文は日本語音声で代読されます（Piper 未導入）";
  const MIXED_TEXT_ARTICLE: Article = {
    ...BASE,
    id: 10,
    title: "対訳スクリプト",
    content: "こんにちは。\nHello.",
    language: "mixed",
  };
  const EN_WEB_ARTICLE: Article = {
    ...BASE,
    id: 11,
    url: "https://example.com/en",
    title: "English Article",
    content: "Hello world.",
    language: "en",
    sourceType: "web",
  };

  it("mixed 記事のヘッダーに JA·EN バッジ、en 記事には従来の EN バッジを表示する", () => {
    const view1 = render(
      <ArticleViewerPanel article={MIXED_TEXT_ARTICLE} playbackState={IDLE} segmentIndex={null} />
    );
    expect(view1.getByText("JA·EN")).toBeTruthy();
    view1.unmount();

    const view2 = render(
      <ArticleViewerPanel article={EN_WEB_ARTICLE} playbackState={IDLE} segmentIndex={null} />
    );
    expect(view2.getByText("EN")).toBeTruthy();
  });

  it("Piper 未導入時のみ警告バッジが表示され、導入状態の切替に追従する", () => {
    const view = render(
      <ArticleViewerPanel
        article={MIXED_TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        piperInstalled={false}
      />
    );
    expect(view.getByTitle(WARN_TITLE)).toBeTruthy();

    view.rerender(
      <ArticleViewerPanel
        article={MIXED_TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        piperInstalled={true}
      />
    );
    expect(view.queryByTitle(WARN_TITLE)).toBeNull();
  });
});

describe("ArticleViewerPanel — URL 依存 UI の縮退 (5.1)", () => {
  const TEXT_ARTICLE: Article = {
    ...BASE,
    id: 8,
    title: "テキスト記事",
    content: "本文です。",
    language: "ja",
  };
  const WEB_ARTICLE: Article = {
    ...BASE,
    id: 9,
    url: "https://example.com/a",
    title: "ウェブ記事",
    content: "本文です。",
    language: "ja",
    sourceType: "web",
  };

  it("web 記事ではウェブモードトグルと更新ボタンが表示される", () => {
    const { queryByRole } = render(
      <ArticleViewerPanel
        article={WEB_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        showFontSlider
        onRefresh={vi.fn()}
      />
    );
    expect(queryByRole("button", { name: "ウェブ" })).toBeTruthy();
    expect(queryByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("テキスト記事ではウェブモードトグルと更新ボタンを提供しない", () => {
    const { queryByRole } = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        showFontSlider
        onRefresh={vi.fn()}
      />
    );
    expect(queryByRole("button", { name: "ウェブ" })).toBeNull();
    expect(queryByRole("button", { name: "テキスト" })).toBeNull();
    expect(queryByRole("button", { name: "更新" })).toBeNull();
  });
});

describe("ArticleViewerPanel — テキスト記事の編集モード (4.2)", () => {
  const TEXT_ARTICLE: Article = {
    ...BASE,
    id: 7,
    title: "元タイトル",
    content: "元の本文です。二つ目の文です。",
    language: "ja",
  };

  function okSave(): Promise<Result<Article, ArticleError>> {
    return Promise.resolve({ ok: true, value: TEXT_ARTICLE });
  }

  it("テキスト記事では編集ボタンが表示され、web 記事では表示されない", () => {
    const view1 = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={vi.fn(okSave)}
      />
    );
    expect(view1.queryByRole("button", { name: "編集" })).toBeTruthy();
    view1.unmount();

    const view2 = render(
      <ArticleViewerPanel
        article={JA_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={vi.fn(okSave)}
      />
    );
    expect(view2.queryByRole("button", { name: "編集" })).toBeNull();
  });

  it("編集ボタンで編集モードに入り、タイトル・本文の初期値が入る（文セグメントは非表示）", () => {
    const { getByRole, getByDisplayValue, container } = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={vi.fn(okSave)}
      />
    );

    fireEvent.click(getByRole("button", { name: "編集" }));

    expect(getByDisplayValue("元タイトル")).toBeTruthy();
    expect(getByDisplayValue("元の本文です。二つ目の文です。")).toBeTruthy();
    expect(getByRole("button", { name: "保存" })).toBeTruthy();
    expect(getByRole("button", { name: "キャンセル" })).toBeTruthy();
    // 編集中は文セグメント（クリックジャンプ対象）が表示されない
    expect(container.querySelectorAll("[data-seg-idx]")).toHaveLength(0);
  });

  it("キャンセルで編集モードを抜け、変更は破棄される", () => {
    const onSaveTextEdit = vi.fn(okSave);
    const { getByRole, getByDisplayValue, container } = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={onSaveTextEdit}
      />
    );

    fireEvent.click(getByRole("button", { name: "編集" }));
    fireEvent.change(getByDisplayValue("元の本文です。二つ目の文です。"), {
      target: { value: "書き換え途中" },
    });
    fireEvent.click(getByRole("button", { name: "キャンセル" }));

    expect(onSaveTextEdit).not.toHaveBeenCalled();
    // 文セグメント表示に戻る
    expect(container.querySelectorAll("[data-seg-idx]").length).toBeGreaterThan(0);

    // 再度編集を開くと元の本文が入っている（破棄されている）
    fireEvent.click(getByRole("button", { name: "編集" }));
    expect(getByDisplayValue("元の本文です。二つ目の文です。")).toBeTruthy();
  });

  it("保存で onSaveTextEdit が (id, content, title) で呼ばれ、成功すると編集モードを抜ける", async () => {
    const onSaveTextEdit = vi.fn(okSave);
    const { getByRole, getByDisplayValue, container } = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={onSaveTextEdit}
      />
    );

    fireEvent.click(getByRole("button", { name: "編集" }));
    fireEvent.change(getByDisplayValue("元の本文です。二つ目の文です。"), {
      target: { value: "新しい本文です。" },
    });
    fireEvent.click(getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onSaveTextEdit).toHaveBeenCalledWith(7, "新しい本文です。", "元タイトル");
    });
    // 成功すると編集モードを抜けて通常表示に戻る
    await waitFor(() => {
      expect(container.querySelectorAll("[data-seg-idx]").length).toBeGreaterThan(0);
    });
  });

  it("タイトルを空にして保存すると title は省略される", async () => {
    const onSaveTextEdit = vi.fn(okSave);
    const { getByRole, getByDisplayValue } = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={onSaveTextEdit}
      />
    );

    fireEvent.click(getByRole("button", { name: "編集" }));
    fireEvent.change(getByDisplayValue("元タイトル"), { target: { value: "  " } });
    fireEvent.click(getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onSaveTextEdit).toHaveBeenCalledWith(
        7,
        "元の本文です。二つ目の文です。",
        undefined
      );
    });
  });

  it("本文を空にすると保存ボタンが無効になる", () => {
    const { getByRole, getByDisplayValue } = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={vi.fn(okSave)}
      />
    );

    fireEvent.click(getByRole("button", { name: "編集" }));
    fireEvent.change(getByDisplayValue("元の本文です。二つ目の文です。"), {
      target: { value: "   " },
    });
    expect((getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("保存失敗時はエラーを表示し編集モードに留まる", async () => {
    const onSaveTextEdit = vi.fn().mockResolvedValue({
      ok: false,
      error: { type: "database_error", message: "disk full" },
    });
    const { getByRole, getByDisplayValue, findByText } = render(
      <ArticleViewerPanel
        article={TEXT_ARTICLE}
        playbackState={IDLE}
        segmentIndex={null}
        onSaveTextEdit={onSaveTextEdit}
      />
    );

    fireEvent.click(getByRole("button", { name: "編集" }));
    fireEvent.click(getByRole("button", { name: "保存" }));

    await findByText(/disk full/);
    // 編集モードに留まる（textarea が残っている）
    expect(getByDisplayValue("元の本文です。二つ目の文です。")).toBeTruthy();
  });
});

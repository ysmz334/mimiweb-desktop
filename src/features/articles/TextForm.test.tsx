import { render, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Article } from "@/shared/types";

const { mockRegisterTextArticle } = vi.hoisted(() => ({
  mockRegisterTextArticle: vi.fn(),
}));

vi.mock("@/lib/tauriCommands", () => ({
  registerTextArticle: mockRegisterTextArticle,
}));

import { TextForm } from "./TextForm";

const TEXT_ARTICLE: Article = {
  id: 2,
  url: "text://00000000-0000-4000-8000-000000000000",
  title: "テキスト記事",
  content: "本文です。",
  contentHtml: null,
  status: "ready",
  errorMessage: null,
  registeredAt: "2026-01-01T00:00:00Z",
  extractedAt: "2026-01-01T00:00:00Z",
  isFavorite: false,
  language: "ja",
  sourceType: "text",
};

const TITLE_PLACEHOLDER = "タイトル（省略時は本文の先頭行）";
const CONTENT_PLACEHOLDER = "読み上げるテキストを貼り付け";

beforeEach(() => {
  vi.clearAllMocks();
  mockRegisterTextArticle.mockResolvedValue({ ok: true, value: TEXT_ARTICLE });
});

describe("TextForm", () => {
  it("空本文では登録ボタンが無効", () => {
    const { getByRole } = render(<TextForm onAdded={vi.fn()} />);
    const button = getByRole("button", { name: "登録" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("空白のみの本文でも登録ボタンは無効のまま", () => {
    const { getByRole, getByPlaceholderText } = render(<TextForm onAdded={vi.fn()} />);
    fireEvent.change(getByPlaceholderText(CONTENT_PLACEHOLDER), {
      target: { value: "   \n\t  " },
    });
    const button = getByRole("button", { name: "登録" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("本文を入力すると有効になり、登録成功で onAdded が呼ばれフィールドがクリアされる", async () => {
    const onAdded = vi.fn();
    const { getByRole, getByPlaceholderText } = render(<TextForm onAdded={onAdded} />);

    const titleInput = getByPlaceholderText(TITLE_PLACEHOLDER) as HTMLInputElement;
    const textarea = getByPlaceholderText(CONTENT_PLACEHOLDER) as HTMLTextAreaElement;
    fireEvent.change(titleInput, { target: { value: "テキスト記事" } });
    fireEvent.change(textarea, { target: { value: "本文です。" } });

    const button = getByRole("button", { name: "登録" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledWith(TEXT_ARTICLE);
    });
    expect(mockRegisterTextArticle).toHaveBeenCalledWith("本文です。", "テキスト記事");
    // 成功後は次の入力に備えてクリアされる
    expect(titleInput.value).toBe("");
    expect(textarea.value).toBe("");
  });

  it("タイトル未入力（空白のみ含む）のときは title を省略して呼ぶ", async () => {
    const { getByRole, getByPlaceholderText } = render(<TextForm onAdded={vi.fn()} />);

    fireEvent.change(getByPlaceholderText(TITLE_PLACEHOLDER), { target: { value: "   " } });
    fireEvent.change(getByPlaceholderText(CONTENT_PLACEHOLDER), {
      target: { value: "本文です。" },
    });
    fireEvent.click(getByRole("button", { name: "登録" }));

    await waitFor(() => {
      expect(mockRegisterTextArticle).toHaveBeenCalledWith("本文です。", undefined);
    });
  });

  it("バックエンドの拒否エラー (empty_content) をフィールドエラーとして表示する", async () => {
    mockRegisterTextArticle.mockResolvedValue({
      ok: false,
      error: { type: "empty_content" },
    });
    const onAdded = vi.fn();
    const { getByRole, getByPlaceholderText, findByText } = render(
      <TextForm onAdded={onAdded} />
    );

    fireEvent.change(getByPlaceholderText(CONTENT_PLACEHOLDER), {
      target: { value: "本文です。" },
    });
    fireEvent.click(getByRole("button", { name: "登録" }));

    await findByText("本文を入力してください");
    expect(onAdded).not.toHaveBeenCalled();
    // 入力値は保持される（ユーザーが修正して再送信できるように）
    expect((getByPlaceholderText(CONTENT_PLACEHOLDER) as HTMLTextAreaElement).value).toBe(
      "本文です。"
    );
  });
});

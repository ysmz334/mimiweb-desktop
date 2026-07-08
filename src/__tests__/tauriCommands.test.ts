import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  registerArticle,
  registerTextArticle,
  updateTextArticle,
  getArticles,
  getQueue,
  getSettings,
  onVoicevoxStatusChanged,
} from "@/lib/tauriCommands";
import { setupInvokeMap } from "@/test-utils/tauriMocks";
import type { Article, QueueItem, Settings, VoicevoxStatus } from "@/shared/types";

const ARTICLE: Article = {
  id: 1,
  url: "https://example.com",
  title: "Example Article",
  content: "Body text",
  contentHtml: null,
  status: "ready",
  errorMessage: null,
  registeredAt: "2024-01-01T00:00:00Z",
  extractedAt: "2024-01-01T00:01:00Z",
  isFavorite: false,
  language: "ja" as const,
  sourceType: "web" as const,
};

describe("tauriCommands — invoke ラッパー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registerArticle", () => {
    it("invoke が正しいコマンド名と引数で呼ばれ、ok 結果を返す", async () => {
      setupInvokeMap({ register_article: ARTICLE });

      const result = await registerArticle("https://example.com");

      expect(result).toEqual({ ok: true, value: ARTICLE });
      expect(invoke).toHaveBeenCalledWith("register_article", {
        url: "https://example.com",
      });
    });

    it("invoke が拒否されたとき error 結果を返す", async () => {
      const err = { type: "duplicate_url" };
      setupInvokeMap({ register_article: err }, { throws: ["register_article"] });

      const result = await registerArticle("https://example.com");

      expect(result).toEqual({ ok: false, error: err });
    });
  });

  describe("registerTextArticle", () => {
    const TEXT_ARTICLE: Article = {
      ...ARTICLE,
      id: 2,
      url: "text://00000000-0000-4000-8000-000000000000",
      title: "テキスト記事",
      sourceType: "text",
    };

    it("正しいコマンド名と引数で呼ばれ ok 結果を返す (タイトルあり)", async () => {
      setupInvokeMap({ register_text_article: TEXT_ARTICLE });

      const result = await registerTextArticle("本文です。", "テキスト記事");

      expect(result).toEqual({ ok: true, value: TEXT_ARTICLE });
      expect(invoke).toHaveBeenCalledWith("register_text_article", {
        title: "テキスト記事",
        content: "本文です。",
      });
    });

    it("タイトル省略時は title: null で送る", async () => {
      setupInvokeMap({ register_text_article: TEXT_ARTICLE });

      await registerTextArticle("本文です。");

      expect(invoke).toHaveBeenCalledWith("register_text_article", {
        title: null,
        content: "本文です。",
      });
    });

    it("invoke が拒否されたとき error 結果を返す (empty_content)", async () => {
      const err = { type: "empty_content" };
      setupInvokeMap(
        { register_text_article: err },
        { throws: ["register_text_article"] }
      );

      const result = await registerTextArticle("   ");

      expect(result).toEqual({ ok: false, error: err });
    });
  });

  describe("updateTextArticle", () => {
    const TEXT_ARTICLE: Article = {
      ...ARTICLE,
      id: 7,
      url: "text://00000000-0000-4000-8000-000000000001",
      sourceType: "text",
    };

    it("正しいコマンド名と引数で呼ばれ ok 結果を返す", async () => {
      setupInvokeMap({ update_text_article: TEXT_ARTICLE });

      const result = await updateTextArticle(7, "新しい本文", "新タイトル");

      expect(result).toEqual({ ok: true, value: TEXT_ARTICLE });
      expect(invoke).toHaveBeenCalledWith("update_text_article", {
        id: 7,
        title: "新タイトル",
        content: "新しい本文",
      });
    });

    it("invoke が拒否されたとき error 結果を返す (not_text_article)", async () => {
      const err = { type: "not_text_article" };
      setupInvokeMap(
        { update_text_article: err },
        { throws: ["update_text_article"] }
      );

      const result = await updateTextArticle(1, "本文");

      expect(result).toEqual({ ok: false, error: err });
      expect(invoke).toHaveBeenCalledWith("update_text_article", {
        id: 1,
        title: null,
        content: "本文",
      });
    });
  });

  describe("getArticles", () => {
    it("フィルタなしで記事一覧を返す", async () => {
      setupInvokeMap({ get_articles: [ARTICLE] });

      const articles = await getArticles();

      expect(articles).toEqual([ARTICLE]);
      expect(invoke).toHaveBeenCalledWith("get_articles", { filter: null });
    });

    it("フィルタあり", async () => {
      setupInvokeMap({ get_articles: [ARTICLE] });

      await getArticles({ status: "ready" });

      expect(invoke).toHaveBeenCalledWith("get_articles", {
        filter: { status: "ready" },
      });
    });
  });

  describe("getQueue", () => {
    it("キュー一覧を返す", async () => {
      const item: QueueItem = {
        id: 1,
        articleId: 1,
        position: 0,
        addedAt: "2024-01-01T00:00:00Z",
        article: {
          id: 1,
          url: "https://example.com",
          title: "t",
          content: null,
          contentHtml: null,
          status: "ready",
          errorMessage: null,
          registeredAt: "2024-01-01T00:00:00Z",
          extractedAt: null,
          isFavorite: false,
          language: "ja" as const,
          sourceType: "web" as const,
        },
      };
      setupInvokeMap({ get_queue: [item] });

      const queue = await getQueue();

      expect(queue).toEqual([item]);
    });
  });

  describe("getSettings", () => {
    it("設定値を返す", async () => {
      const settings: Settings = {
        voicevoxSpeakerId: 3,
        voicevoxPort: 50021,
        playbackSpeed: 1.0,
        mp3Bitrate: 128,
      };
      setupInvokeMap({ get_settings: settings });

      const result = await getSettings();

      expect(result).toEqual(settings);
    });
  });
});

describe("tauriCommands — イベントリスナーヘルパー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("onVoicevoxStatusChanged が正しいイベント名でリスナーを登録し、UnlistenFn を返す", async () => {
    const unlistenFn = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlistenFn);

    const cb = vi.fn();
    const unlisten = await onVoicevoxStatusChanged(cb);

    expect(listen).toHaveBeenCalledWith(
      "voicevox:status-changed",
      expect.any(Function)
    );

    // Tauri の event.payload をシミュレートしてコールバックが呼ばれることを確認
    const registeredHandler = vi.mocked(listen).mock.calls[0][1] as (
      e: { payload: VoicevoxStatus }
    ) => void;
    const status: VoicevoxStatus = { state: "ready", port: 50021 };
    registeredHandler({ payload: status });

    expect(cb).toHaveBeenCalledWith(status);
    expect(unlisten).toBe(unlistenFn);
  });
});

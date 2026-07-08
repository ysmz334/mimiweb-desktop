// テキスト記事ライフサイクルの統合テスト (8.1)
// 登録 → 混在再生（文ごとのルーティング）→ 中断 → 編集 → 差分再合成 →
// レジューム位置の無効化、の一連をモック統合テストで検証する。
// バックエンドはタスク 1.x の Rust 実装の契約（即時 ready・言語判定・
// レジューム位置のみ無効化）を忠実に再現したフェイクで置き換える。

import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const {
  mockGetQueue,
  mockGetArticles,
  mockRemoveFromQueue,
  mockRecordPlayback,
  mockUpdatePlaybackProgress,
  mockGetLastPlayback,
  mockGetArticleKeywords,
  mockCheckPiperInstalled,
  mockRegisterTextArticle,
  mockUpdateTextArticle,
  mockSynthesize,
  mockPiperSynthesize,
  mockGetAudioEntry,
  mockPutAudioV2,
  mockComputeWavDuration,
  mockNormalize,
} = vi.hoisted(() => ({
  mockGetQueue: vi.fn(),
  mockGetArticles: vi.fn(),
  mockRemoveFromQueue: vi.fn(),
  mockRecordPlayback: vi.fn(),
  mockUpdatePlaybackProgress: vi.fn(),
  mockGetLastPlayback: vi.fn(),
  mockGetArticleKeywords: vi.fn(),
  mockCheckPiperInstalled: vi.fn(),
  mockRegisterTextArticle: vi.fn(),
  mockUpdateTextArticle: vi.fn(),
  mockSynthesize: vi.fn(),
  mockPiperSynthesize: vi.fn(),
  mockGetAudioEntry: vi.fn(),
  mockPutAudioV2: vi.fn(),
  mockComputeWavDuration: vi.fn(),
  mockNormalize: vi.fn(),
}));

vi.mock("@/lib/tauriCommands", () => ({
  getQueue: mockGetQueue,
  getArticles: mockGetArticles,
  removeFromQueue: mockRemoveFromQueue,
  recordPlayback: mockRecordPlayback,
  updatePlaybackProgress: mockUpdatePlaybackProgress,
  getLastPlayback: mockGetLastPlayback,
  getArticleKeywords: mockGetArticleKeywords,
  checkPiperInstalled: mockCheckPiperInstalled,
  registerTextArticle: mockRegisterTextArticle,
  updateTextArticle: mockUpdateTextArticle,
}));

vi.mock("@/lib/audioCache", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audioCache")>("@/lib/audioCache");
  return {
    ...actual,
    getAudioEntry: mockGetAudioEntry,
    putAudioV2: mockPutAudioV2,
    computeWavDuration: mockComputeWavDuration,
  };
});

vi.mock("@/lib/audioNormalizer", () => ({
  NORMALIZER_VERSION: 1,
  TARGET_RMS_DB: -20,
  PEAK_CEILING_DB: -1,
  SILENCE_FLOOR_DB: -45,
  normalizeWavLoudness: mockNormalize,
}));

vi.mock("@/lib/voicevoxClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voicevoxClient")>("@/lib/voicevoxClient");
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    VoicevoxClient: vi.fn(function (this: any) {
      this.synthesize = mockSynthesize;
    }),
    VoicevoxClientError: class VoicevoxClientError extends Error {
      constructor(public readonly apiError: unknown) {
        super(String(apiError));
        this.name = "VoicevoxClientError";
      }
    },
    splitSentences: actual.splitSentences,
  };
});

vi.mock("@/lib/piperClient", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PiperClient: vi.fn(function (this: any) {
    this.synthesize = mockPiperSynthesize;
  }),
}));

import { usePlayback } from "@/features/playback/usePlayback";
import { registerTextArticle, updateTextArticle, getArticles } from "@/lib/tauriCommands";
import { isV2Entry, type AnyCacheEntry, type CacheEntryV2 } from "@/lib/audioCache";
import type { Article, QueueItem } from "@/shared/types";

// ─── MockAudio ─────────────────────────────────────────────────────────────

let lastMockAudio: MockAudio | null = null;

class MockAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  volume = 1;
  private _handlers: Record<string, Array<() => void>> = {};

  constructor(_url?: string) {
    lastMockAudio = this;
  }

  addEventListener(event: string, handler: () => void) {
    (this._handlers[event] ??= []).push(handler);
  }
  play() { return Promise.resolve(); }
  pause() {}

  _emit(event: "ended" | "error") {
    this._handlers[event]?.forEach((h) => h());
  }
}

// ─── フェイクバックエンド（Rust 実装の契約を再現） ─────────────────────────

interface HistoryRec {
  id: number;
  articleId: number;
  lastSentenceIndex: number | null;
  sentenceCount: number | null;
}

const articlesStore: Article[] = [];
const queueStore: QueueItem[] = [];
const historyStore: HistoryRec[] = [];
const cacheStore = new Map<number, AnyCacheEntry>();

function filledCount(entry: AnyCacheEntry | undefined): number {
  if (!entry || !isV2Entry(entry)) return 0;
  return entry.sentences.filter((s) => s.blob !== null).length;
}

/** 合成呼び出しの記録（エンジン呼び分け順序の検証用） */
const callLog: string[] = [];

beforeEach(() => {
  vi.stubGlobal("Audio", MockAudio);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined as unknown as void);

  lastMockAudio = null;
  articlesStore.length = 0;
  queueStore.length = 0;
  historyStore.length = 0;
  cacheStore.clear();
  callLog.length = 0;

  // ── 記事コマンド ──
  mockRegisterTextArticle.mockImplementation(async (content: string, title?: string) => {
    if (!content.trim()) return { ok: false, error: { type: "empty_content" } };
    const article: Article = {
      id: 1,
      url: "text://lifecycle-integration-test",
      title: title ?? content.split("\n")[0],
      content,
      contentHtml: null,
      status: "ready", // 抽出工程なしで即時 ready
      errorMessage: null,
      registeredAt: "2026-07-07T00:00:00Z",
      extractedAt: "2026-07-07T00:00:00Z",
      isFavorite: false,
      language: "mixed", // 対訳形式は mixed 判定（Rust detect_article_language の契約）
      sourceType: "text",
    };
    articlesStore.push(article);
    return { ok: true, value: { ...article } };
  });

  mockUpdateTextArticle.mockImplementation(async (id: number, content: string, title?: string) => {
    const a = articlesStore.find((x) => x.id === id);
    if (!a) return { ok: false, error: { type: "not_found" } };
    if (a.sourceType !== "text") return { ok: false, error: { type: "not_text_article" } };
    if (!content.trim()) return { ok: false, error: { type: "empty_content" } };
    a.content = content;
    if (title !== undefined) a.title = title;
    // 契約: 対象記事のレジューム位置のみを無効化する（統計・レコード自体は保持）
    for (const h of historyStore) {
      if (h.articleId === id) h.lastSentenceIndex = null;
    }
    return { ok: true, value: { ...a } };
  });

  mockGetArticles.mockImplementation(async () => articlesStore.map((a) => ({ ...a })));
  mockGetQueue.mockImplementation(async () => [...queueStore]);
  mockRemoveFromQueue.mockImplementation(async (queueId: number) => {
    const idx = queueStore.findIndex((q) => q.id === queueId);
    if (idx >= 0) queueStore.splice(idx, 1);
  });

  // ── 履歴コマンド ──
  mockRecordPlayback.mockImplementation(
    async (articleId: number, _dur: number, _startedAt: string, lastIdx: number | null, count: number) => {
      const id = historyStore.length + 1;
      historyStore.push({ id, articleId, lastSentenceIndex: lastIdx, sentenceCount: count });
      return id;
    }
  );
  mockUpdatePlaybackProgress.mockImplementation(
    async (playbackId: number, lastIdx: number | null) => {
      const h = historyStore.find((x) => x.id === playbackId);
      if (h) h.lastSentenceIndex = lastIdx;
    }
  );
  mockGetLastPlayback.mockImplementation(async (articleId: number) => {
    const recs = historyStore.filter((h) => h.articleId === articleId);
    const last = recs[recs.length - 1];
    return last ? { ...last } : null;
  });

  mockGetArticleKeywords.mockResolvedValue([]);
  mockCheckPiperInstalled.mockResolvedValue(true);

  // ── 合成・キャッシュ ──
  mockSynthesize.mockImplementation(async ({ text }: { text: string }) => {
    callLog.push(`vv:${text}`);
    return new Blob(["wav"], { type: "audio/wav" });
  });
  mockPiperSynthesize.mockImplementation(async (text: string) => {
    callLog.push(`piper:${text}`);
    return new Blob(["wav"], { type: "audio/wav" });
  });
  mockNormalize.mockImplementation(async (b: Blob) => b);
  mockComputeWavDuration.mockResolvedValue(1);
  mockPutAudioV2.mockImplementation(async (entry: CacheEntryV2) => {
    cacheStore.set(entry.articleId, { ...entry, sentences: [...entry.sentences] });
  });
  mockGetAudioEntry.mockImplementation(async (articleId: number) => {
    return cacheStore.get(articleId) ?? null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ─── 統合シナリオ ──────────────────────────────────────────────────────────

const CONTENT_V1 = "こんにちは。\nHello world.\nさようなら。";
// 「こんにちは。」→「こんばんは。」の一文だけ書き換え
const CONTENT_V2 = "こんばんは。\nHello world.\nさようなら。";

// buildFullText によりタイトルが先頭セグメントになる:
// ["対訳スクリプト。"(ja), 本文3文...] の計4セグメント

describe("テキスト記事ライフサイクル統合 (8.1)", () => {
  it("登録 → 混在再生 → 中断 → 編集 → 差分再合成 → レジューム無効化が一連で機能する", async () => {
    // ── 1. 登録: 抽出工程なしで即時 ready・一覧から取得できる (R1.6) ──
    const reg = await registerTextArticle(CONTENT_V1, "対訳スクリプト");
    expect(reg.ok).toBe(true);
    const listed = await getArticles();
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("ready");
    expect(listed[0].language).toBe("mixed");
    expect(listed[0].sourceType).toBe("text");

    // 既存記事と同様にキューへ追加できる
    queueStore.push({
      id: 10,
      articleId: 1,
      position: 1,
      addedAt: "2026-07-07T00:00:00Z",
      article: articlesStore[0],
    });

    const { result } = renderHook(() =>
      usePlayback({ port: 50021, speakerId: 3, piperInstalled: true })
    );

    // ── 2. 混在再生: 文ごとに VOICEVOX / Piper がルーティングされる (R4.1) ──
    act(() => { result.current.start(); });
    await waitFor(() => expect(result.current.state.phase).toBe("playing"));
    await waitFor(() => expect(result.current.segmentIndex).toBe(0));

    // 全4文の合成完了（タイトル文 + 本文3文）とエンジン呼び分け順序
    await waitFor(() => expect(filledCount(cacheStore.get(1))).toBe(4));
    expect(callLog).toEqual([
      "vv:対訳スクリプト。",
      "vv:こんにちは。",
      "piper:Hello world.",
      "vv:さようなら。",
    ]);

    // ── 3. 2文だけ再生して中断 → レジューム位置（文1）が履歴に残る ──
    const audio0 = lastMockAudio!;
    act(() => { audio0._emit("ended"); });
    await waitFor(() => expect(result.current.segmentIndex).toBe(1));
    act(() => { lastMockAudio!._emit("ended"); });
    await waitFor(() => expect(result.current.segmentIndex).toBe(2));

    act(() => { result.current.skip(); });
    await waitFor(() => expect(result.current.state.phase).toBe("idle"));
    expect(historyStore).toHaveLength(1);
    expect(historyStore[0].lastSentenceIndex).toBe(1); // 文1 まで再生済み = 次回は文2 から

    // ── 4. 編集: App の直列実行順（①合成キャンセル → ②更新 → ③反映）を模擬 (R8.2, 8.5) ──
    act(() => { result.current.cancelArticleSynth(1); });
    const upd = await updateTextArticle(1, CONTENT_V2, "対訳スクリプト");
    expect(upd.ok).toBe(true);
    // レジューム位置のみ無効化される（履歴レコード自体は保持 = 統計に影響しない）
    expect(historyStore).toHaveLength(1);
    expect(historyStore[0].lastSentenceIndex).toBeNull();

    // ── 5. 再生し直し: 変更文のみ再合成され、旧レジューム位置は適用されない (R8.3, 8.5) ──
    callLog.length = 0;
    queueStore.push({
      id: 11,
      articleId: 1,
      position: 1,
      addedAt: "2026-07-07T00:01:00Z",
      article: articlesStore[0],
    });

    act(() => { result.current.restart(); });
    await waitFor(() => expect(result.current.state.phase).toBe("playing"));
    // レジューム無効化により（文2 からではなく）先頭文から再生される
    await waitFor(() => expect(result.current.segmentIndex).toBe(0));

    await waitFor(() => expect(filledCount(cacheStore.get(1))).toBe(4));
    // 変更した一文のみが再合成され、残り3文はキー一致でキャッシュ再利用される
    expect(callLog).toEqual(["vv:こんばんは。"]);

    // ── 6. 最後まで完走できる ──
    for (let i = 0; i < 4; i++) {
      const a = lastMockAudio!;
      act(() => { a._emit("ended"); });
      if (i < 3) {
        await waitFor(() => expect(lastMockAudio).not.toBe(a));
      }
    }
    await waitFor(() => expect(result.current.state.phase).toBe("idle"));
    expect(queueStore).toHaveLength(0); // 正常完了でキューから削除される
  });
});

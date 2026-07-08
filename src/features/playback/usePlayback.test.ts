import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── 共有モック関数 (vi.hoisted で巻き上げ) ────────────────────────────────

const {
  mockGetQueue,
  mockGetArticles,
  mockRemoveFromQueue,
  mockRecordPlayback,
  mockUpdatePlaybackProgress,
  mockGetLastPlayback,
  mockGetArticleKeywords,
  mockCheckPiperInstalled,
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
  mockUpdatePlaybackProgress: vi.fn().mockResolvedValue(undefined),
  mockGetLastPlayback: vi.fn(),
  mockGetArticleKeywords: vi.fn(),
  mockCheckPiperInstalled: vi.fn(),
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
}));

// 純関数 (sentenceCacheKey / reuseSentences / deriveMeta / isV2Entry) は実物を使い、
// IndexedDB を触る関数のみモックする
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

import {
  isV2Entry,
  sentenceCacheKey,
  type AnyCacheEntry,
  type CacheEntryV2,
} from "@/lib/audioCache";

// ─── MockAudio (ended イベントを手動でトリガー可能) ───────────────────────

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

// ─── テスト共通データ ──────────────────────────────────────────────────────

const ARTICLE = {
  id: 1,
  url: "https://example.com",
  title: "テスト記事",
  content: "第一文。第二文。",
  status: "ready" as const,
  errorMessage: null,
  registeredAt: "2026-01-01T00:00:00Z",
  extractedAt: null,
};

const QUEUE_ITEM = {
  id: 10,
  articleId: 1,
  position: 1,
  addedAt: "2026-01-01T00:00:00Z",
  article: ARTICLE,
};

const DEFAULT_PROPS = { port: 50021, speakerId: 3, initialSpeedScale: 1.0 };

/** v2 エントリの合成済み文数を数えるヘルパー */
function filledCount(entry: AnyCacheEntry | undefined): number {
  if (!entry || !isV2Entry(entry)) return 0;
  return entry.sentences.filter((s) => s.blob !== null).length;
}

// ─── 動的キャッシュストア (putAudioV2 → getAudioEntry を連動させる) ───────

const cacheStore = new Map<number, AnyCacheEntry>();

// ─── セットアップ ──────────────────────────────────────────────────────────

import { usePlayback } from "./usePlayback";

beforeEach(() => {
  vi.stubGlobal("Audio", MockAudio);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined as unknown as void);

  lastMockAudio = null;
  cacheStore.clear();

  mockGetQueue.mockResolvedValue([]);
  mockGetArticles.mockResolvedValue([ARTICLE]);
  mockRemoveFromQueue.mockResolvedValue(undefined);
  mockRecordPlayback.mockResolvedValue(undefined);
  mockGetLastPlayback.mockResolvedValue(null);
  mockGetArticleKeywords.mockResolvedValue([]);
  mockCheckPiperInstalled.mockResolvedValue(false);
  mockSynthesize.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
  mockPiperSynthesize.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
  mockComputeWavDuration.mockResolvedValue(0);
  mockNormalize.mockImplementation(async (b: Blob) => b);

  // putAudioV2 でキャッシュストアを更新し、getAudioEntry がそれを返すよう連動
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

// ─── テスト ────────────────────────────────────────────────────────────────

describe("usePlayback", () => {
  describe("初期状態", () => {
    it("idle で始まる", () => {
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));
      expect(result.current.state.phase).toBe("idle");
    });

    it("initialSpeedScale が speedScale に反映される", () => {
      const { result } = renderHook(() =>
        usePlayback({ ...DEFAULT_PROPS, initialSpeedScale: 1.5 })
      );
      expect(result.current.speedScale).toBe(1.5);
    });
  });

  describe("start()", () => {
    it("キューが空の場合は idle を維持する", async () => {
      mockGetQueue.mockResolvedValue([]);
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });

      await waitFor(() => {
        expect(result.current.state.phase).toBe("idle");
      });
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it("idle でない場合は start() を無視する (getQueue は1回だけ呼ばれる)", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => {
        result.current.start();
        result.current.start(); // idle でないため無視
      });

      await waitFor(() => {
        expect(result.current.state.phase).toBe("playing");
      });
      // start() の2回目は state が idle でないためループを開始しない
      expect(mockGetQueue).toHaveBeenCalledTimes(1);
    });

    it("キューに記事がある場合 playing 状態に遷移し synthesize を呼ぶ", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });

      await waitFor(() => {
        expect(result.current.state.phase).toBe("playing");
      });

      // バックグラウンド合成が第1文から開始されることを確認
      expect(mockSynthesize).toHaveBeenCalledWith({
        text: "テスト記事。",
        speakerId: 3,
        speedScale: 1.0,
      });
    });

    it("全文再生完了後に recordPlayback と removeFromQueue を呼ぶ", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });

      // playing 状態まで待つ (第1文の合成完了後)
      await waitFor(() => {
        expect(result.current.state.phase).toBe("playing");
      });

      // 文1 (テスト記事。) の再生完了
      const audio0 = lastMockAudio!;
      act(() => { audio0._emit("ended"); });

      // 文2 (第一文。) の再生開始を待つ
      await waitFor(() => expect(lastMockAudio).not.toBe(audio0));

      // 文2 の再生完了
      const audio1 = lastMockAudio!;
      act(() => { audio1._emit("ended"); });

      // 文3 (第二文。) の再生開始を待つ
      await waitFor(() => expect(lastMockAudio).not.toBe(audio1));

      // 文3 の再生完了
      act(() => { lastMockAudio!._emit("ended"); });

      await waitFor(() => {
        expect(result.current.state.phase).toBe("idle");
      });

      expect(mockRecordPlayback).toHaveBeenCalledWith(
        ARTICLE.id,
        expect.any(Number),   // durationSeconds
        expect.any(String),   // startedAt (ISO datetime)
        null,                  // lastSentenceIndex (全文完了時は null)
        expect.any(Number),   // sentenceCount
      );
      expect(mockRemoveFromQueue).toHaveBeenCalledWith(QUEUE_ITEM.id);
    });
  });

  describe("pause() / resume()", () => {
    async function startAndWaitPlaying() {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      const hook = renderHook(() => usePlayback(DEFAULT_PROPS));
      act(() => { hook.result.current.start(); });
      await waitFor(() => expect(hook.result.current.state.phase).toBe("playing"));
      return hook;
    }

    it("playing 中に pause() で paused 状態になる", async () => {
      const { result } = await startAndWaitPlaying();

      act(() => { result.current.pause(); });

      expect(result.current.state.phase).toBe("paused");
    });

    it("paused 中に resume() で playing 状態に戻る", async () => {
      const { result } = await startAndWaitPlaying();

      act(() => { result.current.pause(); });
      expect(result.current.state.phase).toBe("paused");

      act(() => { result.current.resume(); });
      expect(result.current.state.phase).toBe("playing");
    });

    it("idle 中に pause() を呼んでも状態が変わらない", () => {
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));
      act(() => { result.current.pause(); });
      expect(result.current.state.phase).toBe("idle");
    });

    it("pause 中もバックグラウンド合成が継続する", async () => {
      // 合成を一時的にブロックするモック
      let resolveSecondSynth: ((b: Blob) => void) | null = null;
      mockSynthesize
        .mockResolvedValueOnce(new Blob(["wav"], { type: "audio/wav" })) // 第1文: 即解決
        .mockImplementationOnce(
          () => new Promise<Blob>(resolve => { resolveSecondSynth = resolve; }) // 第2文: ブロック
        )
        .mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));

      const { result } = await startAndWaitPlaying();

      // 一時停止
      act(() => { result.current.pause(); });
      expect(result.current.state.phase).toBe("paused");

      // pause 中に第2文の合成を完了させる
      expect(resolveSecondSynth).not.toBeNull();
      act(() => { resolveSecondSynth!(new Blob(["wav"], { type: "audio/wav" })); });

      // 第2文のキャッシュが保存される (pause 中でも合成が続いている)
      await waitFor(() => {
        expect(filledCount(cacheStore.get(ARTICLE.id))).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe("skip()", () => {
    it("playing 中に skip() すると idle に戻り次の記事へ進む", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM]) // 1周目 start
        .mockResolvedValueOnce([QUEUE_ITEM]) // skip 時の getQueue
        .mockResolvedValue([]); // 2周目 runLoop
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));
      act(() => { result.current.start(); });
      await waitFor(() => expect(result.current.state.phase).toBe("playing"));

      act(() => { result.current.skip(); });

      await waitFor(() => expect(result.current.state.phase).toBe("idle"));
      expect(mockRemoveFromQueue).toHaveBeenCalled();
    });

    it("スキップ後に segmentIndex が null に戻る", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });
      await waitFor(() => expect(result.current.state.phase).toBe("playing"));

      act(() => { result.current.skip(); });

      await waitFor(() => {
        expect(result.current.segmentIndex).toBeNull();
      });
    });

    it("スキップ時にバックグラウンド合成がキャンセルされる", async () => {
      // 第1文: 即解決しない (スキップのタイミング制御)
      let resolveFirstSynth: ((b: Blob) => void) | null = null;
      mockSynthesize.mockImplementation(
        () => new Promise<Blob>(resolve => { resolveFirstSynth = resolve; })
      );
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);

      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));
      act(() => { result.current.start(); });

      // 合成が pending の状態でスキップ
      await waitFor(() => expect(resolveFirstSynth).not.toBeNull());
      act(() => { result.current.skip(); });
      await waitFor(() => expect(result.current.state.phase).toBe("idle"));

      // スキップ後は putAudioV2 は呼ばれていない
      expect(mockPutAudioV2).not.toHaveBeenCalled();

      // 遅延した合成結果が届いてもキャンセル済みのため putAudioV2 は呼ばれない
      act(() => { resolveFirstSynth!(new Blob(["wav"], { type: "audio/wav" })); });
      await new Promise(r => setTimeout(r, 50));
      expect(mockPutAudioV2).not.toHaveBeenCalled();
    });

    it("error 状態から skip() で次記事へ進める", async () => {
      mockSynthesize.mockRejectedValueOnce(new Error("connection refused"));
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM]) // 1周目
        .mockResolvedValueOnce([QUEUE_ITEM]) // skip の getQueue
        .mockResolvedValue([]); // 2周目
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });
      await waitFor(() => expect(result.current.state.phase).toBe("error"));

      act(() => { result.current.skip(); });
      await waitFor(() => expect(result.current.state.phase).toBe("idle"));
    });
  });

  describe("エラーハンドリング", () => {
    it("synthesize が失敗すると error 状態に遷移する", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      mockSynthesize.mockRejectedValueOnce(new Error("unreachable"));
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });

      await waitFor(() => {
        expect(result.current.state.phase).toBe("error");
      });

      if (result.current.state.phase === "error") {
        expect(result.current.state.articleId).toBe(ARTICLE.id);
      }
    });
  });

  describe("setSpeedScale()", () => {
    it("speedScale が更新される", () => {
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.setSpeedScale(1.5); });

      expect(result.current.speedScale).toBe(1.5);
    });
  });

  describe("バックグラウンド合成とキャッシュ", () => {
    it("第1文の blob 取得後に playing 状態に遷移し segmentIndex が 0 になる", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });

      await waitFor(() => {
        expect(result.current.state.phase).toBe("playing");
        expect(result.current.segmentIndex).toBe(0);
      });
    });

    it("合成結果を文ごとに v2 エントリとしてキャッシュへ保存する", async () => {
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.start(); });
      await waitFor(() => expect(result.current.state.phase).toBe("playing"));

      // 3文を順次完了
      const audio0 = lastMockAudio!;
      act(() => { audio0._emit("ended"); });
      await waitFor(() => expect(lastMockAudio).not.toBe(audio0));

      const audio1 = lastMockAudio!;
      act(() => { audio1._emit("ended"); });
      await waitFor(() => expect(lastMockAudio).not.toBe(audio1));

      act(() => { lastMockAudio!._emit("ended"); });
      await waitFor(() => expect(result.current.state.phase).toBe("idle"));

      // 文ごとに putAudioV2 が呼ばれ、最終的に全文が合成済みで保存される
      expect(mockPutAudioV2).toHaveBeenCalledTimes(3);
      const calls = mockPutAudioV2.mock.calls;
      const lastEntry = calls[calls.length - 1][0] as CacheEntryV2;
      expect(lastEntry.articleId).toBe(ARTICLE.id);
      expect(lastEntry.version).toBe(2);
      expect(lastEntry.sentences).toHaveLength(3);
      expect(lastEntry.sentences.every((s) => s.blob !== null)).toBe(true);
    });

    it("完全キャッシュ済み (旧形式) の記事は synthesize を呼ばずに再生する", async () => {
      const blobs = [
        new Blob(["b0"], { type: "audio/wav" }),
        new Blob(["b1"], { type: "audio/wav" }),
        new Blob(["b2"], { type: "audio/wav" }),
      ];
      cacheStore.set(ARTICLE.id, {
        articleId: ARTICLE.id,
        blobs,
        isComplete: true,
        sentenceCount: 3,
        totalDurationSeconds: 0,
        totalSizeBytes: 0,
        cachedAt: new Date().toISOString(),
      });
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);

      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));
      act(() => { result.current.start(); });

      await waitFor(() => expect(result.current.state.phase).toBe("playing"));

      // キャッシュから再生するので synthesize は呼ばれない
      expect(mockSynthesize).not.toHaveBeenCalled();
    });
  });

  describe("preSynthesize()", () => {
    it("再生なしにバックグラウンド合成を開始できる", async () => {
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      await act(async () => {
        await result.current.preSynthesize(ARTICLE.id);
      });

      // 合成が完了してキャッシュに保存される (全文合成済みの v2 エントリ)
      await waitFor(() => {
        expect(mockPutAudioV2).toHaveBeenCalled();
        const calls = mockPutAudioV2.mock.calls;
        const entry = calls[calls.length - 1][0] as CacheEntryV2;
        expect(entry.articleId).toBe(ARTICLE.id);
        expect(entry.sentences.every((s) => s.blob !== null)).toBe(true);
      });

      // 再生状態は変わらない
      expect(result.current.state.phase).toBe("idle");
    });

    it("完全キャッシュ済み (旧形式) の記事は preSynthesize を無視する", async () => {
      cacheStore.set(ARTICLE.id, {
        articleId: ARTICLE.id,
        blobs: [new Blob(["b0"]), new Blob(["b1"]), new Blob(["b2"])],
        isComplete: true,
        sentenceCount: 3,
        totalDurationSeconds: 0,
        totalSizeBytes: 0,
        cachedAt: new Date().toISOString(),
      });

      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      await act(async () => {
        await result.current.preSynthesize(ARTICLE.id);
      });

      expect(mockSynthesize).not.toHaveBeenCalled();
    });
  });

  // ─── ここから 3.1: 文単位ルーティング・正規化・キー再利用・キャンセル ───

  describe("文単位ルーティング (3.1)", () => {
    const MIXED_CONTENT = "こんにちは。\nHello world.\nさようなら。";
    const MIXED_ARTICLE = {
      ...ARTICLE,
      id: 2,
      title: null as string | null,
      content: MIXED_CONTENT,
      language: "mixed",
      sourceType: "text",
    };
    const MIXED_QUEUE_ITEM = {
      id: 20,
      articleId: 2,
      position: 1,
      addedAt: "2026-01-01T00:00:00Z",
      article: MIXED_ARTICLE,
    };
    const callLog: string[] = [];

    beforeEach(() => {
      callLog.length = 0;
      mockGetArticles.mockResolvedValue([ARTICLE, MIXED_ARTICLE]);
      mockSynthesize.mockImplementation(async ({ text }: { text: string }) => {
        callLog.push(`vv:${text}`);
        return new Blob(["wav"], { type: "audio/wav" });
      });
      mockPiperSynthesize.mockImplementation(async (text: string) => {
        callLog.push(`piper:${text}`);
        return new Blob(["wav"], { type: "audio/wav" });
      });
    });

    it("Piper 導入済みの混在記事は文ごとに VOICEVOX / Piper を昇順で呼び分ける", async () => {
      const { result } = renderHook(() =>
        usePlayback({ ...DEFAULT_PROPS, piperInstalled: true })
      );

      await act(async () => { await result.current.preSynthesize(2); });

      await waitFor(() => {
        expect(filledCount(cacheStore.get(2))).toBe(3);
      });
      expect(callLog).toEqual([
        "vv:こんにちは。",
        "piper:Hello world.",
        "vv:さようなら。",
      ]);
      // 実際に使ったエンジンがキーに刻まれる
      const stored = cacheStore.get(2) as CacheEntryV2;
      expect(stored.sentences[0].key).toContain(":vv:");
      expect(stored.sentences[1].key).toContain(":piper:");
      expect(stored.sentences[2].key).toContain(":vv:");
      // 可用性が明示されているため checkPiperInstalled は呼ばれない
      expect(mockCheckPiperInstalled).not.toHaveBeenCalled();
    });

    it("Piper 未導入時は英語文も VOICEVOX へフォールバックし実エンジン vv をキーに刻む", async () => {
      const { result } = renderHook(() =>
        usePlayback({ ...DEFAULT_PROPS, piperInstalled: false })
      );

      await act(async () => { await result.current.preSynthesize(2); });

      await waitFor(() => {
        expect(filledCount(cacheStore.get(2))).toBe(3);
      });
      expect(mockPiperSynthesize).not.toHaveBeenCalled();
      expect(callLog).toEqual([
        "vv:こんにちは。",
        "vv:Hello world.",
        "vv:さようなら。",
      ]);
      // フォールバックで実際に使った vv がキーに刻まれる (Piper 導入後にキー不一致で再合成される)
      const stored = cacheStore.get(2) as CacheEntryV2;
      expect(stored.sentences[1].key).toContain(":vv:");
    });

    it("Piper 可用性が未解決 (null) の間は checkPiperInstalled の解決を待ってから合成する", async () => {
      let resolveCheck: ((installed: boolean) => void) | null = null;
      mockCheckPiperInstalled.mockImplementation(
        () => new Promise<boolean>((resolve) => { resolveCheck = resolve; })
      );
      // piperInstalled 省略 = null (未解決)
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { void result.current.preSynthesize(2); });

      await waitFor(() => expect(mockCheckPiperInstalled).toHaveBeenCalled());
      // 解決前は合成が始まらない
      expect(mockSynthesize).not.toHaveBeenCalled();
      expect(mockPiperSynthesize).not.toHaveBeenCalled();

      act(() => { resolveCheck!(true); });

      await waitFor(() => {
        expect(mockPiperSynthesize).toHaveBeenCalledWith("Hello world.");
      });
    });

    it("キー一致文の合成をスキップし未充足文のみ合成する", async () => {
      const bitrate = 128;
      const keys = [
        sentenceCacheKey("こんにちは。", { engine: "vv", voice: "3", bitrate }),
        sentenceCacheKey("Hello world.", { engine: "piper", voice: "en_US-ryan-high", bitrate }),
        sentenceCacheKey("さようなら。", { engine: "vv", voice: "3", bitrate }),
      ];
      // 文0・文2 は再利用可能、文1 は旧キー (stale) で再合成対象
      cacheStore.set(2, {
        articleId: 2,
        version: 2,
        sentences: [
          { key: keys[0], blob: new Blob(["a"]), durationSeconds: 1 },
          { key: "stale-key", blob: new Blob(["b"]), durationSeconds: 1 },
          { key: keys[2], blob: new Blob(["c"]), durationSeconds: 1 },
        ],
        cachedAt: "2026-01-01T00:00:00Z",
      });

      const { result } = renderHook(() =>
        usePlayback({ ...DEFAULT_PROPS, piperInstalled: true })
      );

      await act(async () => { await result.current.preSynthesize(2); });

      await waitFor(() => {
        expect(mockPiperSynthesize).toHaveBeenCalledWith("Hello world.");
      });
      await waitFor(() => {
        expect(filledCount(cacheStore.get(2))).toBe(3);
      });
      // 再利用文 (0, 2) は合成されない
      expect(mockPiperSynthesize).toHaveBeenCalledTimes(1);
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it("全文がキー一致で再利用可能なら合成を一切行わない", async () => {
      const bitrate = 128;
      const keys = [
        sentenceCacheKey("こんにちは。", { engine: "vv", voice: "3", bitrate }),
        sentenceCacheKey("Hello world.", { engine: "piper", voice: "en_US-ryan-high", bitrate }),
        sentenceCacheKey("さようなら。", { engine: "vv", voice: "3", bitrate }),
      ];
      cacheStore.set(2, {
        articleId: 2,
        version: 2,
        sentences: keys.map((key) => ({
          key,
          blob: new Blob(["x"]),
          durationSeconds: 1,
        })),
        cachedAt: "2026-01-01T00:00:00Z",
      });

      const { result } = renderHook(() =>
        usePlayback({ ...DEFAULT_PROPS, piperInstalled: true })
      );

      await act(async () => { await result.current.preSynthesize(2); });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSynthesize).not.toHaveBeenCalled();
      expect(mockPiperSynthesize).not.toHaveBeenCalled();
    });

    it("再生ループでも混在記事が文ごとにルーティングされ最後まで再生できる", async () => {
      mockGetQueue
        .mockResolvedValueOnce([MIXED_QUEUE_ITEM])
        .mockResolvedValue([]);
      const { result } = renderHook(() =>
        usePlayback({ ...DEFAULT_PROPS, piperInstalled: true })
      );

      act(() => { result.current.start(); });
      await waitFor(() => expect(result.current.state.phase).toBe("playing"));

      const audio0 = lastMockAudio!;
      act(() => { audio0._emit("ended"); });
      await waitFor(() => expect(lastMockAudio).not.toBe(audio0));

      const audio1 = lastMockAudio!;
      act(() => { audio1._emit("ended"); });
      await waitFor(() => expect(lastMockAudio).not.toBe(audio1));

      act(() => { lastMockAudio!._emit("ended"); });
      await waitFor(() => expect(result.current.state.phase).toBe("idle"));

      expect(callLog).toEqual([
        "vv:こんにちは。",
        "piper:Hello world.",
        "vv:さようなら。",
      ]);
    });
  });

  describe("再生待機の歯抜け対応 (3.2)", () => {
    it("歯抜け v2 エントリでは未充足文のみ合成し、再利用文と合わせて最後まで再生できる", async () => {
      // 文0・文2 はキー一致で再利用可能、文1 のみ未合成（編集後の歯抜けを模擬）
      const keys = ["テスト記事。", "第一文。", "第二文。"].map((t) =>
        sentenceCacheKey(t, { engine: "vv", voice: "3", bitrate: 128 })
      );
      cacheStore.set(ARTICLE.id, {
        articleId: ARTICLE.id,
        version: 2,
        sentences: [
          { key: keys[0], blob: new Blob(["m0"]), durationSeconds: 1 },
          { key: keys[1], blob: null, durationSeconds: 0 },
          { key: keys[2], blob: new Blob(["m2"]), durationSeconds: 1 },
        ],
        cachedAt: "2026-01-01T00:00:00Z",
      });
      mockGetQueue
        .mockResolvedValueOnce([QUEUE_ITEM])
        .mockResolvedValue([]);

      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));
      act(() => { result.current.start(); });

      // 文0 は再利用済みキャッシュから即再生される
      await waitFor(() => expect(result.current.state.phase).toBe("playing"));

      // 3文を順次完了（文1 は合成完了を待って再生される）
      const audio0 = lastMockAudio!;
      act(() => { audio0._emit("ended"); });
      await waitFor(() => expect(lastMockAudio).not.toBe(audio0));

      const audio1 = lastMockAudio!;
      act(() => { audio1._emit("ended"); });
      await waitFor(() => expect(lastMockAudio).not.toBe(audio1));

      act(() => { lastMockAudio!._emit("ended"); });
      await waitFor(() => expect(result.current.state.phase).toBe("idle"));

      // 合成されたのは未充足の文1 だけ
      expect(mockSynthesize).toHaveBeenCalledTimes(1);
      expect(mockSynthesize).toHaveBeenCalledWith({
        text: "第一文。",
        speakerId: 3,
        speedScale: 1.0,
      });
    });
  });

  describe("ラウドネス正規化 (3.1)", () => {
    it("各文の合成直後に normalizeWavLoudness が適用される", async () => {
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      await act(async () => {
        await result.current.preSynthesize(ARTICLE.id);
      });

      await waitFor(() => {
        expect(filledCount(cacheStore.get(ARTICLE.id))).toBe(3);
      });
      // 3文それぞれに正規化が適用される
      expect(mockNormalize).toHaveBeenCalledTimes(3);
    });
  });

  describe("編集フロー: 差分再合成 (4.2)", () => {
    it("一文だけ書き換えた後の合成では変更文のみ再合成され、残りはキャッシュ再利用される", async () => {
      // 元本文 (テスト記事。第一文。第二文。) は全文合成済み
      const spec = { engine: "vv" as const, voice: "3", bitrate: 128 };
      const originalBlobs = new Map<string, Blob>();
      cacheStore.set(ARTICLE.id, {
        articleId: ARTICLE.id,
        version: 2,
        sentences: ["テスト記事。", "第一文。", "第二文。"].map((t) => {
          const blob = new Blob([t]);
          originalBlobs.set(t, blob);
          return { key: sentenceCacheKey(t, spec), blob, durationSeconds: 1 };
        }),
        cachedAt: "2026-01-01T00:00:00Z",
      });

      // 編集: 「第一文。」→「書き換えた文。」（App は ①cancelArticleSynth ②update ③反映 の順で直列実行する）
      const edited = { ...ARTICLE, content: "書き換えた文。第二文。" };
      mockGetArticles.mockResolvedValue([edited]);

      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { result.current.cancelArticleSynth(ARTICLE.id); });
      await act(async () => { await result.current.preSynthesize(ARTICLE.id); });

      await waitFor(() => {
        expect(filledCount(cacheStore.get(ARTICLE.id))).toBe(3);
      });

      // 変更された文のみ合成される（合成呼び出し回数で検証）
      expect(mockSynthesize).toHaveBeenCalledTimes(1);
      expect(mockSynthesize).toHaveBeenCalledWith({
        text: "書き換えた文。",
        speakerId: 3,
        speedScale: 1.0,
      });

      // 変更されていない文は元の blob がそのまま再利用される
      const stored = cacheStore.get(ARTICLE.id);
      if (!stored || !isV2Entry(stored)) throw new Error("v2 エントリが保存されているべき");
      expect(stored.sentences[0].blob).toBe(originalBlobs.get("テスト記事。"));
      expect(stored.sentences[2].blob).toBe(originalBlobs.get("第二文。"));
    });
  });

  describe("cancelArticleSynth() (3.1)", () => {
    it("進行中の合成をキャンセルし以降キャッシュへ保存されない", async () => {
      let resolveSynth: ((b: Blob) => void) | null = null;
      mockSynthesize.mockImplementation(
        () => new Promise<Blob>((resolve) => { resolveSynth = resolve; })
      );
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { void result.current.preSynthesize(ARTICLE.id); });
      await waitFor(() => expect(resolveSynth).not.toBeNull());

      act(() => { result.current.cancelArticleSynth(ARTICLE.id); });

      // 遅延した合成結果が届いてもキャンセル済みのため保存されない
      act(() => { resolveSynth!(new Blob(["wav"], { type: "audio/wav" })); });
      await new Promise((r) => setTimeout(r, 50));
      expect(mockPutAudioV2).not.toHaveBeenCalled();
    });

    it("別記事の合成はキャンセルしない", async () => {
      let resolveSynth: ((b: Blob) => void) | null = null;
      mockSynthesize.mockImplementation(
        () => new Promise<Blob>((resolve) => { resolveSynth = resolve; })
      );
      const { result } = renderHook(() => usePlayback(DEFAULT_PROPS));

      act(() => { void result.current.preSynthesize(ARTICLE.id); });
      await waitFor(() => expect(resolveSynth).not.toBeNull());

      // 無関係な記事 ID のキャンセルは影響しない
      act(() => { result.current.cancelArticleSynth(999); });

      act(() => { resolveSynth!(new Blob(["wav"], { type: "audio/wav" })); });
      await waitFor(() => expect(mockPutAudioV2).toHaveBeenCalled());
    });
  });
});

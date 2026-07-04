import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CacheEntry } from "@/lib/audioCache";

// ─── 共有モック関数 (vi.hoisted で巻き上げ) ────────────────────────────────

const {
  mockGetQueue,
  mockGetArticles,
  mockRemoveFromQueue,
  mockRecordPlayback,
  mockUpdatePlaybackProgress,
  mockSynthesize,
  mockGetAudio,
  mockPutAudio,
  mockComputeWavDuration,
} = vi.hoisted(() => ({
  mockGetQueue: vi.fn(),
  mockGetArticles: vi.fn(),
  mockRemoveFromQueue: vi.fn(),
  mockRecordPlayback: vi.fn(),
  mockUpdatePlaybackProgress: vi.fn().mockResolvedValue(undefined),
  mockSynthesize: vi.fn(),
  mockGetAudio: vi.fn(),
  mockPutAudio: vi.fn(),
  mockComputeWavDuration: vi.fn(),
}));

vi.mock("@/lib/tauriCommands", () => ({
  getQueue: mockGetQueue,
  getArticles: mockGetArticles,
  removeFromQueue: mockRemoveFromQueue,
  recordPlayback: mockRecordPlayback,
  updatePlaybackProgress: mockUpdatePlaybackProgress,
}));

vi.mock("@/lib/audioCache", () => ({
  getAudio: mockGetAudio,
  putAudio: mockPutAudio,
  computeWavDuration: mockComputeWavDuration,
  CACHE_UPDATED_EVENT: "audio-cache-updated",
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

// ─── 動的キャッシュストア (putAudio → getAudio を連動させる) ─────────────

const cacheStore = new Map<number, CacheEntry>();

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
  mockSynthesize.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
  mockComputeWavDuration.mockResolvedValue(0);

  // putAudio でキャッシュストアを更新し、getAudio がそれを返すよう連動
  mockPutAudio.mockImplementation(async (entry: CacheEntry) => {
    cacheStore.set(entry.articleId, { ...entry, blobs: [...entry.blobs] });
  });
  mockGetAudio.mockImplementation(async (articleId: number) => {
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
        const stored = cacheStore.get(ARTICLE.id);
        expect(stored?.blobs.length).toBeGreaterThanOrEqual(2);
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

      // スキップ後は putAudio は呼ばれていない
      expect(mockPutAudio).not.toHaveBeenCalled();

      // 遅延した合成結果が届いてもキャンセル済みのため putAudio は呼ばれない
      act(() => { resolveFirstSynth!(new Blob(["wav"], { type: "audio/wav" })); });
      await new Promise(r => setTimeout(r, 50));
      expect(mockPutAudio).not.toHaveBeenCalled();
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

    it("合成結果を文ごとにキャッシュへ保存する (全文完了後は isComplete: true)", async () => {
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

      // 文ごとに putAudio が呼ばれ、最終的に isComplete: true で保存される
      expect(mockPutAudio).toHaveBeenCalledTimes(3);
      expect(mockPutAudio).toHaveBeenLastCalledWith(
        expect.objectContaining({ articleId: ARTICLE.id, isComplete: true, sentenceCount: 3 })
      );
    });

    it("完全キャッシュ済みの記事は synthesize を呼ばずに再生する", async () => {
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

      // 合成が完了してキャッシュに保存される
      await waitFor(() => {
        expect(mockPutAudio).toHaveBeenCalledWith(
          expect.objectContaining({ articleId: ARTICLE.id, isComplete: true })
        );
      });

      // 再生状態は変わらない
      expect(result.current.state.phase).toBe("idle");
    });

    it("完全キャッシュ済みの記事は preSynthesize を無視する", async () => {
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
});

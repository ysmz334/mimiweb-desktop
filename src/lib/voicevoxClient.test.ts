import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VoicevoxClient, VoicevoxClientError, splitSentences } from "./voicevoxClient";

// ─── テスト用ヘルパー ───────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

function makeJsonResponse(body: unknown, status = 200): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob()),
  } as unknown as Response;
}

function makeWavResponse(): Response {
  const wavBlob = new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve({}),
    blob: () => Promise.resolve(wavBlob),
  } as unknown as Response;
}

// ─── splitSentences ────────────────────────────────────────────────────────

describe("splitSentences", () => {
  it("全角句点で文を分割する", () => {
    expect(splitSentences("これはテスト。次の文です。")).toEqual([
      "これはテスト。",
      "次の文です。",
    ]);
  });

  it("全角感嘆符・疑問符で分割する", () => {
    expect(splitSentences("本当？それはすごい！")).toEqual([
      "本当？",
      "それはすごい！",
    ]);
  });

  it("半角 ! ? . でも分割する", () => {
    expect(splitSentences("Hello! World? OK.")).toEqual([
      "Hello!",
      "World?",
      "OK.",
    ]);
  });

  it("句読点のないテキストはそのまま返す", () => {
    expect(splitSentences("句読点なし")).toEqual(["句読点なし"]);
  });

  it("空文字列は空配列を返す", () => {
    expect(splitSentences("")).toEqual([]);
  });

  it("各文の前後の空白をトリムする", () => {
    expect(splitSentences("  テスト。  次の文。  ")).toEqual([
      "テスト。",
      "次の文。",
    ]);
  });
});

// ─── splitSentences (英語モード) ───────────────────────────────────────────

describe("splitSentences (language=en)", () => {
  it("ピリオドで文を分割する", () => {
    expect(splitSentences("Hello world. This is a test.", "en")).toEqual([
      "Hello world.",
      "This is a test.",
    ]);
  });

  it("感嘆符で分割する", () => {
    expect(splitSentences("Great job! Well done!", "en")).toEqual([
      "Great job!",
      "Well done!",
    ]);
  });

  it("疑問符で分割する", () => {
    expect(splitSentences("How are you? I am fine.", "en")).toEqual([
      "How are you?",
      "I am fine.",
    ]);
  });

  it("改行で行を分け、さらに句点で分割する", () => {
    expect(splitSentences("First line.\nSecond sentence! Third?", "en")).toEqual([
      "First line.",
      "Second sentence!",
      "Third?",
    ]);
  });

  it("空文字列は空配列を返す", () => {
    expect(splitSentences("", "en")).toEqual([]);
  });

  it("language 省略時は日本語モードを維持する", () => {
    expect(splitSentences("これはテスト。次の文です。")).toEqual([
      "これはテスト。",
      "次の文です。",
    ]);
  });

  it("language='ja' は日本語モードを使う", () => {
    expect(splitSentences("これはテスト。次の文です。", "ja")).toEqual([
      "これはテスト。",
      "次の文です。",
    ]);
  });
});

// ─── VoicevoxClient ────────────────────────────────────────────────────────

describe("VoicevoxClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  describe("synthesize()", () => {
    it("AudioQuery に speedScale を上書きして WAV Blob を返す", async () => {
      const client = new VoicevoxClient(50021);
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({ speedScale: 1.0, pitchScale: 0.0 }))
        .mockResolvedValueOnce(makeWavResponse());

      const result = await client.synthesize({ text: "テスト", speakerId: 3, speedScale: 1.5 });

      expect(result).toBeInstanceOf(Blob);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // 1 回目: /audio_query?text=...&speaker=3
      const [queryUrl, queryInit] = mockFetch.mock.calls[0];
      expect(queryUrl as string).toContain("/audio_query");
      expect(queryUrl as string).toContain("speaker=3");
      expect(queryUrl as string).toContain(encodeURIComponent("テスト"));
      expect((queryInit as RequestInit).method).toBe("POST");

      // 2 回目: /synthesis?speaker=3 (speedScale が 1.5 に書き換えられている)
      const [synthUrl, synthInit] = mockFetch.mock.calls[1];
      expect(synthUrl as string).toContain("/synthesis");
      expect(synthUrl as string).toContain("speaker=3");
      const body = JSON.parse((synthInit as RequestInit).body as string);
      expect(body.speedScale).toBe(1.5);
    });

    it("fetch が投げた場合 unreachable エラーを返す", async () => {
      const client = new VoicevoxClient(50021);
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const err = await client
        .synthesize({ text: "test", speakerId: 1, speedScale: 1.0 })
        .catch((e) => e);

      expect(err).toBeInstanceOf(VoicevoxClientError);
      expect(err.apiError.kind).toBe("unreachable");
      expect((err.apiError as { kind: "unreachable"; port: number }).port).toBe(50021);
    });

    it("サーバーが 4xx を返した場合 synthesis_failed エラーを返す", async () => {
      const client = new VoicevoxClient(50021);
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ detail: "音声合成エラー" }, 422)
      );

      const err = await client
        .synthesize({ text: "test", speakerId: 1, speedScale: 1.0 })
        .catch((e) => e);

      expect(err).toBeInstanceOf(VoicevoxClientError);
      expect(err.apiError.kind).toBe("synthesis_failed");
      const apiErr = err.apiError as { kind: "synthesis_failed"; statusCode: number; detail: string };
      expect(apiErr.statusCode).toBe(422);
      expect(apiErr.detail).toBe("音声合成エラー");
    });

    it("レスポンスボディが JSON でない場合も synthesis_failed を返す", async () => {
      const client = new VoicevoxClient(50021);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new SyntaxError("not json")),
        blob: () => Promise.resolve(new Blob()),
      } as unknown as Response);

      const err = await client
        .synthesize({ text: "test", speakerId: 1, speedScale: 1.0 })
        .catch((e) => e);

      expect(err).toBeInstanceOf(VoicevoxClientError);
      expect(err.apiError.kind).toBe("synthesis_failed");
      expect((err.apiError as { kind: "synthesis_failed"; statusCode: number; detail: string }).detail).toBe(
        "Internal Server Error"
      );
    });
  });

  describe("getSpeakers()", () => {
    it("GET /speakers から話者一覧を返す", async () => {
      const client = new VoicevoxClient(50021);
      const speakers = [
        { name: "四国めたん", speakerUuid: "uuid-1", styles: [{ name: "ノーマル", id: 2 }] },
        { name: "ずんだもん", speakerUuid: "uuid-2", styles: [{ name: "ノーマル", id: 3 }] },
      ];
      mockFetch.mockResolvedValueOnce(makeJsonResponse(speakers));

      const result = await client.getSpeakers();

      expect(result).toEqual(speakers);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url as string).toContain("/speakers");
      expect((init as RequestInit).method).toBe("GET");
    });
  });

  describe("ポート設定", () => {
    it("コンストラクタのポートで URL を構築する", async () => {
      const client = new VoicevoxClient(50099);
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({ speedScale: 1.0 }))
        .mockResolvedValueOnce(makeWavResponse());

      await client.synthesize({ text: "test", speakerId: 1, speedScale: 1.0 });

      expect(mockFetch.mock.calls[0][0] as string).toContain("http://127.0.0.1:50099");
    });

    it("異なるポートで複数のクライアントを同時に作成できる", () => {
      const clientA = new VoicevoxClient(50021);
      const clientB = new VoicevoxClient(50099);
      expect(clientA).toBeInstanceOf(VoicevoxClient);
      expect(clientB).toBeInstanceOf(VoicevoxClient);
    });
  });
});

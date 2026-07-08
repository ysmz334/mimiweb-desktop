import { describe, it, expect } from "vitest";
import {
  NORM_VERSION,
  fnv1a64,
  sentenceCacheKey,
  reuseSentences,
  deriveMeta,
  normalizeStoredEntry,
  isV2Entry,
  type CacheEntry,
  type CacheEntryV2,
  type SentenceAudio,
  type SynthesisSpec,
} from "./audioCache";
import { NORMALIZER_VERSION } from "./audioNormalizer";

const VV_SPEC: SynthesisSpec = { engine: "vv", voice: "3", bitrate: 64 };
const PIPER_SPEC: SynthesisSpec = { engine: "piper", voice: "en_US-ryan-high", bitrate: 64 };

function makeBlob(content: string): Blob {
  return new Blob([content], { type: "audio/mp3" });
}

function sentence(key: string, blobContent: string | null, duration = 1): SentenceAudio {
  return {
    key,
    blob: blobContent === null ? null : makeBlob(blobContent),
    durationSeconds: blobContent === null ? 0 : duration,
  };
}

function v2Entry(articleId: number, sentences: SentenceAudio[]): CacheEntryV2 {
  return { articleId, version: 2, sentences, cachedAt: "2024-01-01T00:00:00Z" };
}

// ─── fnv1a64 ───────────────────────────────────────────────────────────────

describe("fnv1a64", () => {
  it("FNV-1a 64bit の既知ベクトルと一致する", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });

  it("UTF-8 バイト列でハッシュする（日本語テキスト）", () => {
    expect(fnv1a64("こんにちは")).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64("こんにちは")).toBe(fnv1a64("こんにちは"));
    expect(fnv1a64("こんにちは")).not.toBe(fnv1a64("こんばんは"));
  });
});

// ─── sentenceCacheKey ──────────────────────────────────────────────────────

describe("sentenceCacheKey", () => {
  it("ハッシュ:エンジン:話者:ビットレート:正規化バージョン の形式", () => {
    const key = sentenceCacheKey("こんにちは。", VV_SPEC);
    expect(key).toBe(`${fnv1a64("こんにちは。")}:vv:3:64:${NORM_VERSION}`);
  });

  it("正規化バージョンは audioNormalizer と同期している", () => {
    expect(NORM_VERSION).toBe(NORMALIZER_VERSION);
  });

  it("同一の文・条件では同一のキーを返す", () => {
    expect(sentenceCacheKey("同じ文。", VV_SPEC)).toBe(sentenceCacheKey("同じ文。", VV_SPEC));
  });

  it("文・エンジン・話者・ビットレートのいずれかが違えば別キーになる", () => {
    const base = sentenceCacheKey("こんにちは。", VV_SPEC);
    expect(sentenceCacheKey("こんばんは。", VV_SPEC)).not.toBe(base);
    expect(sentenceCacheKey("こんにちは。", PIPER_SPEC)).not.toBe(base);
    expect(sentenceCacheKey("こんにちは。", { ...VV_SPEC, voice: "8" })).not.toBe(base);
    expect(sentenceCacheKey("こんにちは。", { ...VV_SPEC, bitrate: 128 })).not.toBe(base);
  });
});

// ─── reuseSentences（編集シナリオのテーブルテスト） ────────────────────────

describe("reuseSentences", () => {
  const kA = sentenceCacheKey("文A。", VV_SPEC);
  const kB = sentenceCacheKey("文B。", VV_SPEC);
  const kC = sentenceCacheKey("文C。", VV_SPEC);
  const kX = sentenceCacheKey("新しい文X。", VV_SPEC);

  const prev = v2Entry(1, [
    sentence(kA, "audio-A", 1.5),
    sentence(kB, "audio-B", 2.0),
    sentence(kC, "audio-C", 2.5),
  ]);

  const scenarios: {
    name: string;
    targetKeys: string[];
    expectReused: (string | null)[]; // 再利用元の key（null = 再合成対象）
  }[] = [
    { name: "先頭挿入", targetKeys: [kX, kA, kB, kC], expectReused: [null, kA, kB, kC] },
    { name: "中間変更", targetKeys: [kA, kX, kC], expectReused: [kA, null, kC] },
    { name: "削除", targetKeys: [kA, kC], expectReused: [kA, kC] },
    { name: "並び替え", targetKeys: [kC, kA, kB], expectReused: [kC, kA, kB] },
    { name: "重複文", targetKeys: [kA, kB, kA], expectReused: [kA, kB, kA] },
  ];

  for (const { name, targetKeys, expectReused } of scenarios) {
    it(`${name}: 一致する文を位置に依存せず再利用する`, () => {
      const result = reuseSentences(targetKeys, prev);

      expect(result).toHaveLength(targetKeys.length);
      expect(result.map((s) => s.key)).toEqual(targetKeys);

      result.forEach((s, i) => {
        const reusedFrom = expectReused[i];
        if (reusedFrom === null) {
          expect(s.blob, `${name}[${i}] は未合成（歯抜け）のはず`).toBeNull();
          expect(s.durationSeconds).toBe(0);
        } else {
          const original = prev.sentences.find((p) => p.key === reusedFrom)!;
          expect(s.blob, `${name}[${i}] は再利用されるはず`).toBe(original.blob);
          expect(s.durationSeconds).toBe(original.durationSeconds);
        }
      });
    });
  }

  it("重複文は同一の blob を共有する", () => {
    const result = reuseSentences([kA, kA], prev);
    expect(result[0].blob).toBe(result[1].blob);
    expect(result[0].blob).not.toBeNull();
  });

  it("既存エントリが null なら全文が再合成対象になる", () => {
    const result = reuseSentences([kA, kB], null);
    expect(result.every((s) => s.blob === null && s.durationSeconds === 0)).toBe(true);
    expect(result.map((s) => s.key)).toEqual([kA, kB]);
  });

  it("既存エントリの未合成（歯抜け）文は再利用しない", () => {
    const gappy = v2Entry(1, [sentence(kA, "audio-A"), sentence(kB, null)]);
    const result = reuseSentences([kA, kB], gappy);
    expect(result[0].blob).not.toBeNull();
    expect(result[1].blob).toBeNull();
  });

  it("旧形式（位置ベース）エントリからはキー照合再利用しない", () => {
    const legacy: CacheEntry = {
      articleId: 1,
      blobs: [makeBlob("old-0"), makeBlob("old-1")],
      totalDurationSeconds: 3,
      totalSizeBytes: 10,
      cachedAt: "2024-01-01T00:00:00Z",
      isComplete: true,
      sentenceCount: 2,
    };
    const result = reuseSentences([kA, kB], legacy as unknown as CacheEntryV2 | null);
    expect(result.every((s) => s.blob === null)).toBe(true);
  });
});

// ─── deriveMeta（既存契約の維持） ──────────────────────────────────────────

describe("deriveMeta", () => {
  it("v2 完全エントリ: isComplete=true・文数・合計サイズ/時間を導出する", () => {
    const entry = v2Entry(7, [
      sentence(sentenceCacheKey("あ。", VV_SPEC), "12345", 1.5),
      sentence(sentenceCacheKey("い。", VV_SPEC), "1234567890", 2.5),
    ]);
    const meta = deriveMeta(entry);

    expect(meta.articleId).toBe(7);
    expect(meta.isComplete).toBe(true);
    expect(meta.sentenceCount).toBe(2);
    expect(meta.totalDurationSeconds).toBe(4);
    expect(meta.totalSizeBytes).toBe(15);
    expect(meta.cachedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("v2 歯抜けエントリ: isComplete=false・未合成分はサイズ/時間に含めない", () => {
    const entry = v2Entry(8, [
      sentence(sentenceCacheKey("あ。", VV_SPEC), "12345", 1.5),
      sentence(sentenceCacheKey("い。", VV_SPEC), null),
    ]);
    const meta = deriveMeta(entry);

    expect(meta.isComplete).toBe(false);
    expect(meta.sentenceCount).toBe(2);
    expect(meta.totalDurationSeconds).toBe(1.5);
    expect(meta.totalSizeBytes).toBe(5);
  });

  it("旧形式エントリ: 保存済みフィールドをそのまま返す", () => {
    const legacy: CacheEntry = {
      articleId: 9,
      blobs: [makeBlob("x")],
      totalDurationSeconds: 12,
      totalSizeBytes: 34,
      cachedAt: "2023-06-01T00:00:00Z",
      isComplete: false,
      sentenceCount: 5,
    };
    const meta = deriveMeta(legacy);

    expect(meta).toEqual({
      articleId: 9,
      totalDurationSeconds: 12,
      totalSizeBytes: 34,
      cachedAt: "2023-06-01T00:00:00Z",
      isComplete: false,
      sentenceCount: 5,
    });
  });
});

// ─── normalizeStoredEntry（読み取り互換） ──────────────────────────────────

describe("normalizeStoredEntry / isV2Entry", () => {
  it("v2 エントリはそのまま v2 と判定される", () => {
    const entry = v2Entry(1, [sentence(sentenceCacheKey("あ。", VV_SPEC), "x")]);
    const normalized = normalizeStoredEntry(entry);
    expect(isV2Entry(normalized)).toBe(true);
  });

  it("旧形式エントリは isComplete / sentenceCount を補完して返す（既存動作の維持）", () => {
    const raw = {
      articleId: 2,
      blobs: [makeBlob("a"), makeBlob("b")],
      totalDurationSeconds: 3,
      totalSizeBytes: 2,
      cachedAt: "2023-01-01T00:00:00Z",
    } as CacheEntry;
    const normalized = normalizeStoredEntry(raw);

    expect(isV2Entry(normalized)).toBe(false);
    if (!isV2Entry(normalized)) {
      expect(normalized.isComplete).toBe(true);
      expect(normalized.sentenceCount).toBe(2);
    }
  });
});

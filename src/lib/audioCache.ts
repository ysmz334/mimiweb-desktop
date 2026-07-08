import { NORMALIZER_VERSION } from "./audioNormalizer";

const DB_NAME = "mimiweb-audio-cache";
const STORE_NAME = "audio";

export interface CacheEntry {
  articleId: number;
  blobs: Blob[];
  totalDurationSeconds: number;
  totalSizeBytes: number;
  cachedAt: string;
  isComplete: boolean;
  sentenceCount: number; // = blobs.length (blobs は CacheMeta に含まれないため)
}

export type CacheMeta = Omit<CacheEntry, "blobs">;

// ─── v2: 文単位コンテンツアドレスキャッシュ ────────────────────────────────

export interface SynthesisSpec {
  engine: "vv" | "piper";
  voice: string; // VOICEVOX: speakerId 文字列 / Piper: モデル名
  bitrate: number; // MP3 kbps
}

/** キャッシュキーに刻む正規化バージョン（audioNormalizer と同期） */
export const NORM_VERSION = NORMALIZER_VERSION;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64bit ハッシュ（UTF-8 バイト列）を 16 桁の16進文字列で返す */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * 文とその合成条件からキャッシュキーを生成する（純関数・同期）。
 * キー不一致 = 再合成対象（編集・話者変更・Piper 後入れ・正規化改版を同一機構で扱う）
 */
export function sentenceCacheKey(text: string, spec: SynthesisSpec): string {
  return `${fnv1a64(text)}:${spec.engine}:${spec.voice}:${spec.bitrate}:${NORM_VERSION}`;
}

export interface SentenceAudio {
  key: string;
  blob: Blob | null; // null = 未合成（歯抜け許容）
  durationSeconds: number; // blob が null のとき 0
}

export interface CacheEntryV2 {
  articleId: number;
  version: 2;
  sentences: SentenceAudio[];
  cachedAt: string;
}

/** 旧形式（位置ベース）または v2 の格納エントリ */
export type AnyCacheEntry = CacheEntry | CacheEntryV2;

export function isV2Entry(entry: AnyCacheEntry): entry is CacheEntryV2 {
  return (entry as CacheEntryV2).version === 2;
}

/**
 * 目標キー列に対して既存エントリから再利用可能な文を移送した新配列を作る。
 * 結果は targetKeys と同じ長さ・同じ順序。一致キーの blob/duration を位置に依存せず
 * 引き継ぎ、不一致は blob: null（再合成対象）。旧形式エントリからは再利用しない。
 */
export function reuseSentences(
  targetKeys: string[],
  previous: AnyCacheEntry | null
): SentenceAudio[] {
  const byKey = new Map<string, SentenceAudio>();
  if (previous && isV2Entry(previous)) {
    for (const s of previous.sentences) {
      if (s.blob !== null && !byKey.has(s.key)) byKey.set(s.key, s);
    }
  }
  return targetKeys.map((key) => {
    const match = byKey.get(key);
    return match
      ? { key, blob: match.blob, durationSeconds: match.durationSeconds }
      : { key, blob: null, durationSeconds: 0 };
  });
}

/** v1/v2 どちらのエントリからも既存契約の CacheMeta を導出する */
export function deriveMeta(entry: AnyCacheEntry): CacheMeta {
  if (!isV2Entry(entry)) {
    const { blobs: _blobs, ...meta } = entry;
    return meta;
  }
  const synthesized = entry.sentences.filter((s) => s.blob !== null);
  return {
    articleId: entry.articleId,
    totalDurationSeconds: synthesized.reduce((sum, s) => sum + s.durationSeconds, 0),
    totalSizeBytes: synthesized.reduce((sum, s) => sum + (s.blob?.size ?? 0), 0),
    cachedAt: entry.cachedAt,
    isComplete: entry.sentences.length > 0 && synthesized.length === entry.sentences.length,
    sentenceCount: entry.sentences.length,
  };
}

/** 格納された生エントリを正規化する（旧形式は isComplete / sentenceCount を補完） */
export function normalizeStoredEntry(raw: AnyCacheEntry): AnyCacheEntry {
  if (isV2Entry(raw)) return raw;
  if (raw.isComplete === undefined) raw.isComplete = true;
  if (raw.sentenceCount === undefined) raw.sentenceCount = raw.blobs.length;
  return raw;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "articleId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalizeEntry(raw: CacheEntry): CacheEntry {
  return normalizeStoredEntry(raw) as CacheEntry;
}

/** v2 対応の読み取り。旧形式は補完した位置ベースエントリのまま返す（読み取り互換） */
export async function getAudioEntry(articleId: number): Promise<AnyCacheEntry | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(articleId);
    req.onsuccess = () => {
      const raw = req.result as AnyCacheEntry | undefined;
      resolve(raw ? normalizeStoredEntry(raw) : null);
    };
    req.onerror = () => reject(req.error);
  });
}

/** v2 エントリを保存する。sentences 配列全体を保持した完全なエントリを渡すこと */
export async function putAudioV2(entry: CacheEntryV2): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAudio(articleId: number): Promise<CacheEntry | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(articleId);
    req.onsuccess = () => {
      const raw = req.result as CacheEntry | undefined;
      resolve(raw ? normalizeEntry(raw) : null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putAudio(entry: CacheEntry): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAudio(articleId: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .delete(articleId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAllMeta(): Promise<CacheMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      resolve(
        (req.result as AnyCacheEntry[]).map((raw) => deriveMeta(normalizeStoredEntry(raw)))
      );
    };
    req.onerror = () => reject(req.error);
  });
}

/** WAV ヘッダ（PCM 44 バイト固定長）からサンプリングレートとデータサイズを読み取り再生時間を算出する */
export async function computeWavDuration(blob: Blob): Promise<number> {
  try {
    const buf = await blob.arrayBuffer();
    if (buf.byteLength < 44) return 0;
    const view = new DataView(buf);
    const sampleRate = view.getUint32(24, true);
    const numChannels = view.getUint16(22, true);
    const bitsPerSample = view.getUint16(34, true);
    const dataSize = view.getUint32(40, true);
    if (!sampleRate || !numChannels || !bitsPerSample) return 0;
    return dataSize / (sampleRate * numChannels * (bitsPerSample / 8));
  } catch {
    return 0;
  }
}

export async function clearAllAudio(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export const CACHE_UPDATED_EVENT = "audio-cache-updated";

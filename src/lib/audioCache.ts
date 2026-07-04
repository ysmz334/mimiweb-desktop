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
  if (raw.isComplete === undefined) raw.isComplete = true;
  if (raw.sentenceCount === undefined) raw.sentenceCount = raw.blobs.length;
  return raw;
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
        (req.result as CacheEntry[]).map((raw) => {
          normalizeEntry(raw);
          const { blobs: _blobs, ...meta } = raw;
          return meta;
        })
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

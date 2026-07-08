// WAV PCM ラウドネス正規化（純関数）。
// 合成直後・MP3 エンコード前に適用し、エンジン・話者に依存しない一貫した音量にする。
// キャッシュには正規化済み音声のみが入るため、再生のたびに同じ音量が保証される。

/** 目標 RMS（dBFS）。全文がこのラウドネスに揃う */
export const TARGET_RMS_DB = -20;
/** ピーク上限（dBFS）。ゲイン適用後のピークがこれを超えないよう制限する */
export const PEAK_CEILING_DB = -1;
/** 無音フロア（dBFS）。RMS がこれ未満の文は増幅しない（ノイズ増幅防止） */
export const SILENCE_FLOOR_DB = -45;

/** 正規化アルゴリズムの世代。キャッシュキーに刻んで世代交代を自動化する */
export const NORMALIZER_VERSION = 1;

const FULL_SCALE = 32768; // 16bit PCM のフルスケール
const HEADER_SIZE = 44;

function dbToLinear(db: number): number {
  return FULL_SCALE * Math.pow(10, db / 20);
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * WAV(16bit PCM) を解析し、目標 RMS へのゲイン適用済みの新しい WAV Blob を返す。
 * - ピークが上限を超えないようゲインを制限する
 * - 無音・極小音量（SILENCE_FLOOR_DB 未満）は原音のまま返す
 * - 非対応形式（非 RIFF・非 16bit PCM）は原音のままパススルーする（fail-safe）
 */
export async function normalizeWavLoudness(wav: Blob): Promise<Blob> {
  try {
    const buf = await wav.arrayBuffer();
    if (buf.byteLength < HEADER_SIZE) return wav;

    const view = new DataView(buf);
    if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") return wav;
    const audioFormat = view.getUint16(20, true);
    const bitsPerSample = view.getUint16(34, true);
    if (audioFormat !== 1 || bitsPerSample !== 16) return wav;

    const dataSize = view.getUint32(40, true);
    const sampleCount = Math.min(
      Math.floor((buf.byteLength - HEADER_SIZE) / 2),
      Math.floor(dataSize / 2)
    );
    if (sampleCount === 0) return wav;

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = view.getInt16(HEADER_SIZE + i * 2, true);
      sumSquares += s * s;
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    if (rms < dbToLinear(SILENCE_FLOOR_DB)) return wav;

    let gain = dbToLinear(TARGET_RMS_DB) / rms;
    const peakCeiling = dbToLinear(PEAK_CEILING_DB);
    if (peak * gain > peakCeiling) {
      gain = peakCeiling / peak;
    }

    const out = buf.slice(0);
    const outView = new DataView(out);
    for (let i = 0; i < sampleCount; i++) {
      const scaled = Math.round(view.getInt16(HEADER_SIZE + i * 2, true) * gain);
      outView.setInt16(HEADER_SIZE + i * 2, Math.max(-32768, Math.min(32767, scaled)), true);
    }
    return new Blob([out], { type: wav.type || "audio/wav" });
  } catch {
    return wav;
  }
}

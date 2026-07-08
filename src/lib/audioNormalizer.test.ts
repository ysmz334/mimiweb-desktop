import { describe, it, expect } from "vitest";
import {
  TARGET_RMS_DB,
  PEAK_CEILING_DB,
  SILENCE_FLOOR_DB,
  normalizeWavLoudness,
} from "./audioNormalizer";
import { computeWavDuration } from "./audioCache";

const FULL_SCALE = 32768;

// ─── PCM フィクスチャ生成 ──────────────────────────────────────────────────

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** 16bit mono PCM WAV（44 バイトヘッダー）を生成する */
function makeWav(samples: Int16Array, sampleRate = 24000): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return new Blob([buf], { type: "audio/wav" });
}

/** 振幅 amplitude の正弦波サンプル列（1 秒分） */
function sineSamples(amplitude: number, n = 24000, freq = 440, sampleRate = 24000): Int16Array {
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  }
  return samples;
}

async function readSamples(blob: Blob): Promise<Int16Array> {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  const n = (buf.byteLength - 44) / 2;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = view.getInt16(44 + i * 2, true);
  return samples;
}

function rmsOf(samples: Int16Array): number {
  let sumSq = 0;
  for (const s of samples) sumSq += s * s;
  return Math.sqrt(sumSq / samples.length);
}

function peakOf(samples: Int16Array): number {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return peak;
}

function dbToLinear(db: number): number {
  return FULL_SCALE * Math.pow(10, db / 20);
}

async function blobBytesEqual(a: Blob, b: Blob): Promise<boolean> {
  const [ba, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (ba.byteLength !== bb.byteLength) return false;
  const va = new Uint8Array(ba);
  const vb = new Uint8Array(bb);
  return va.every((v, i) => v === vb[i]);
}

// ─── テスト ────────────────────────────────────────────────────────────────

describe("normalizeWavLoudness", () => {
  it("定数が設計値と一致する", () => {
    expect(TARGET_RMS_DB).toBe(-20);
    expect(PEAK_CEILING_DB).toBe(-1);
    expect(SILENCE_FLOOR_DB).toBe(-45);
  });

  it("小さい音を目標 RMS（−20 dBFS）まで増幅する", async () => {
    // 振幅 1000 の正弦波: RMS ≈ 707 ≈ −33.3 dBFS（無音フロアより上）
    const wav = makeWav(sineSamples(1000));
    const normalized = await normalizeWavLoudness(wav);
    const samples = await readSamples(normalized);

    const targetRms = dbToLinear(TARGET_RMS_DB); // ≈ 3276.8
    expect(rmsOf(samples)).toBeGreaterThan(targetRms * 0.99);
    expect(rmsOf(samples)).toBeLessThan(targetRms * 1.01);
  });

  it("大きい音を目標 RMS まで減衰する", async () => {
    // 振幅 20000 の正弦波: RMS ≈ 14142 ≈ −7.3 dBFS（目標より大きい）
    const wav = makeWav(sineSamples(20000));
    const normalized = await normalizeWavLoudness(wav);
    const samples = await readSamples(normalized);

    const targetRms = dbToLinear(TARGET_RMS_DB);
    expect(rmsOf(samples)).toBeGreaterThan(targetRms * 0.99);
    expect(rmsOf(samples)).toBeLessThan(targetRms * 1.01);
  });

  it("ピークが上限（−1 dBFS）を超えないようゲインを制限する", async () => {
    // クレストファクタの大きい信号: 小さい正弦波 + 単発スパイク
    // RMS ≈ 354（−39.3 dBFS）なので目標到達にはゲイン約 9.3 倍が必要だが、
    // スパイク 20000 が上限 ≈29205 を超えるためゲインは約 1.46 倍に制限される
    const samples = sineSamples(500);
    samples[100] = 20000;
    const wav = makeWav(samples);
    const normalized = await normalizeWavLoudness(wav);
    const out = await readSamples(normalized);

    const peakCeiling = dbToLinear(PEAK_CEILING_DB);
    expect(peakOf(out)).toBeLessThanOrEqual(peakCeiling + 1);
    // ゲイン制限により目標 RMS には届かないが、増幅自体は行われている
    expect(rmsOf(out)).toBeLessThan(dbToLinear(TARGET_RMS_DB));
    expect(rmsOf(out)).toBeGreaterThan(rmsOf(samples) * 1.3);
  });

  it("無音（全ゼロ）は増幅せず原音のまま返す", async () => {
    const wav = makeWav(new Int16Array(24000));
    const normalized = await normalizeWavLoudness(wav);
    expect(await blobBytesEqual(wav, normalized)).toBe(true);
  });

  it("極小音量（−45 dBFS 未満）は増幅しない", async () => {
    // 振幅 100 の正弦波: RMS ≈ 70.7 ≈ −53.3 dBFS < −45 dBFS
    const wav = makeWav(sineSamples(100));
    const normalized = await normalizeWavLoudness(wav);
    expect(await blobBytesEqual(wav, normalized)).toBe(true);
  });

  it("非対応形式（8bit PCM）は原音のままパススルーする", async () => {
    const wav16 = makeWav(sineSamples(1000));
    const buf = await wav16.arrayBuffer();
    const view = new DataView(buf.slice(0));
    view.setUint16(34, 8, true); // bitsPerSample を 8 に偽装
    const wav8 = new Blob([view.buffer], { type: "audio/wav" });

    const normalized = await normalizeWavLoudness(wav8);
    expect(await blobBytesEqual(wav8, normalized)).toBe(true);
  });

  it("WAV ヘッダーを持たないデータは原音のままパススルーする", async () => {
    const junk = new Blob([new Uint8Array(100).fill(65)]);
    const normalized = await normalizeWavLoudness(junk);
    expect(await blobBytesEqual(junk, normalized)).toBe(true);

    const tiny = new Blob([new Uint8Array(10)]);
    expect(await blobBytesEqual(tiny, await normalizeWavLoudness(tiny))).toBe(true);
  });

  it("サンプル数・サンプルレートが不変（computeWavDuration が変わらない）", async () => {
    const wav = makeWav(sineSamples(1000), 44100);
    const normalized = await normalizeWavLoudness(wav);
    expect(await computeWavDuration(normalized)).toBe(await computeWavDuration(wav));
    expect(normalized.size).toBe(wav.size);
  });
});

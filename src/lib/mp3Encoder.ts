// lamejs は CJS モジュール間でスコープを共有する構造（Lame.js が MPEGMode を require せず参照）のため、
// ESM バンドラーでは ReferenceError になる。lame.all.js は全モジュールを1スコープに収めた
// ブラウザバンドル版で、new Function() 実行によりスコープを保ったまま利用できる。
import lameAllJs from "lamejs/lame.all.js?raw";

interface LameEncoder {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}
interface LamejsBundle {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameEncoder;
}

// lame.all.js: function lamejs() { ...; lamejs.Mp3Encoder = Mp3Encoder; }; lamejs();
// new Function 実行で1スコープにまとめ、lamejs.Mp3Encoder を取り出す。
const { Mp3Encoder } = new Function(`${lameAllJs}; return lamejs;`)() as LamejsBundle;

/** WAV PCM blob を MP3 blob に変換する。変換できない場合は元の blob を返す。 */
export async function wavToMp3(wavBlob: Blob, bitrate: number): Promise<Blob> {
  const buf = await wavBlob.arrayBuffer();
  if (buf.byteLength < 44) return wavBlob;

  const view = new DataView(buf);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  if (bitsPerSample !== 16 || !sampleRate || !numChannels) return wavBlob;

  const pcmByteLength = buf.byteLength - 44;
  const samples = new Int16Array(buf, 44, Math.floor(pcmByteLength / 2));

  const encoder = new Mp3Encoder(numChannels, sampleRate, bitrate);
  const mp3Chunks: Int8Array[] = [];
  const BLOCK = 1152;

  if (numChannels === 1) {
    for (let i = 0; i < samples.length; i += BLOCK) {
      const chunk = samples.subarray(i, Math.min(i + BLOCK, samples.length));
      const encoded = encoder.encodeBuffer(chunk);
      if (encoded.length > 0) mp3Chunks.push(encoded);
    }
  } else {
    const half = Math.ceil(samples.length / 2);
    const left = new Int16Array(half);
    const right = new Int16Array(half);
    for (let i = 0; i < samples.length; i += 2) {
      left[i >> 1] = samples[i];
      right[i >> 1] = samples[i + 1];
    }
    for (let i = 0; i < left.length; i += BLOCK) {
      const l = left.subarray(i, Math.min(i + BLOCK, left.length));
      const r = right.subarray(i, Math.min(i + BLOCK, right.length));
      const encoded = encoder.encodeBuffer(l, r);
      if (encoded.length > 0) mp3Chunks.push(encoded);
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) mp3Chunks.push(flushed);

  return new Blob(mp3Chunks, { type: "audio/mpeg" });
}

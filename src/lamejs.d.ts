// lamejs の CJS 版（"lamejs"）は ESM バンドラーでのスコープ問題があるため直接 import しない。
// mp3Encoder.ts が "lamejs/lame.all.js?raw" を使用するので、このファイルは参照のみ。
declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}

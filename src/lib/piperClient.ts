import { synthesizeEnglish } from "@/lib/tauriCommands";

// ─── PiperClient ───────────────────────────────────────────────────────────

export class PiperClient {
  /** 英語テキストを Piper で合成し WAV Blob を返す。VoicevoxClient.synthesize() と同一の戻り値型。 */
  async synthesize(text: string): Promise<Blob> {
    const base64 = await synthesizeEnglish(text);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: "audio/wav" });
  }
}

import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PiperClient } from "./piperClient";
import { setupInvokeMap } from "@/test-utils/tauriMocks";

// base64 エンコードされた WAV ヘッダー（"RIFF" から始まる最小のバイト列）
// 実際のWAVは44バイトのヘッダー+PCMデータだが、テストでは小さなバイト列で十分
function makeBase64Wav(): string {
  // "RIFF" = [82, 73, 70, 70]
  const bytes = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0]);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe("PiperClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("synthesize()", () => {
    it("base64 WAV 文字列を Blob に変換して返す", async () => {
      const b64 = makeBase64Wav();
      setupInvokeMap({ synthesize_english: b64 });

      const client = new PiperClient();
      const result = await client.synthesize("Hello world.");

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe("audio/wav");
    });

    it("synthesize_english コマンドにテキストを渡す", async () => {
      setupInvokeMap({ synthesize_english: makeBase64Wav() });

      const client = new PiperClient();
      await client.synthesize("Test sentence.");

      expect(vi.mocked(invoke)).toHaveBeenCalledWith("synthesize_english", {
        text: "Test sentence.",
      });
    });

    it("invoke が失敗した場合はエラーを throw する", async () => {
      setupInvokeMap({ synthesize_english: "error" }, { throws: ["synthesize_english"] });

      const client = new PiperClient();
      await expect(client.synthesize("fail")).rejects.toBeDefined();
    });

    it("空文字列でも Blob を返す（バックエンドが処理する）", async () => {
      setupInvokeMap({ synthesize_english: makeBase64Wav() });

      const client = new PiperClient();
      const result = await client.synthesize("");

      expect(result).toBeInstanceOf(Blob);
    });
  });
});

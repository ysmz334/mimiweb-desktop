import type { Speaker, SynthesisParams, VoicevoxApiError } from "@/shared/types";

// ─── エラー型 ──────────────────────────────────────────────────────────────

export class VoicevoxClientError extends Error {
  constructor(public readonly apiError: VoicevoxApiError) {
    super(apiError.kind);
    this.name = "VoicevoxClientError";
  }
}

// ─── VoicevoxClient ────────────────────────────────────────────────────────

export class VoicevoxClient {
  private readonly baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /** 1 文を音声合成して WAV Blob を返す。 */
  async synthesize(params: SynthesisParams): Promise<Blob> {
    const { text, speakerId, speedScale } = params;

    const queryRes = await this.request(
      `/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: "POST" }
    );
    const audioQuery = (await queryRes.json()) as Record<string, unknown>;
    audioQuery.speedScale = speedScale;

    const wavRes = await this.request(`/synthesis?speaker=${speakerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(audioQuery),
    });

    return wavRes.blob();
  }

  /** 利用可能な話者一覧を取得する。 */
  async getSpeakers(): Promise<Speaker[]> {
    const res = await this.request("/speakers", { method: "GET" });
    return res.json() as Promise<Speaker[]>;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await globalThis.fetch(`${this.baseUrl}${path}`, init);
    } catch {
      throw new VoicevoxClientError({ kind: "unreachable", port: this.port });
    }

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        /* ignore parse errors */
      }
      throw new VoicevoxClientError({
        kind: "synthesis_failed",
        statusCode: res.status,
        detail,
      });
    }

    return res;
  }

  private get port(): number {
    const m = this.baseUrl.match(/:(\d+)$/);
    return m ? parseInt(m[1]) : 50021;
  }
}

// ─── テキスト分割ユーティリティ（テスト対象） ──────────────────────────────

/**
 * テキストを文単位に分割する。
 * まず改行で行を分け、次に句点・感嘆符・疑問符（全角・半角）で分割する。
 * これにより見出し行が独立した合成単位になる。
 */
export function splitSentences(text: string, language: "ja" | "en" = "ja"): string[] {
  if (language === "en") {
    const result: string[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // ピリオド・感嘆符・疑問符の後で分割（後続スペースまたは行末）
      const parts = trimmed.split(/(?<=[.!?]+)(?=\s|$)/).map((s) => s.trim()).filter((s) => s.length > 0);
      result.push(...parts);
    }
    return result;
  }

  const result: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matches = trimmed.match(/[^。！？!?]+[。！？!?]|[^。！？!?]+$/g);
    result.push(...(matches ?? [trimmed]).map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return result;
}

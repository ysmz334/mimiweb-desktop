// ドメイン型定義

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// --- 記事 ---

export type ArticleStatus =
  | "pending"
  | "extracting"
  | "ready"
  | "error"
  | "queued"
  | "played";

export interface Article {
  id: number;
  url: string;
  title: string | null;
  content: string | null;
  contentHtml: string | null;
  status: ArticleStatus;
  errorMessage: string | null;
  registeredAt: string; // ISO 8601
  extractedAt: string | null; // ISO 8601
  isFavorite: boolean;
  language: "ja" | "en";
}

export type ArticleSearchTarget = "title" | "content" | "url" | "all";

export interface ArticleFilter {
  status?: ArticleStatus;
  search?: string;
  searchTarget?: ArticleSearchTarget;
  sortBy?: "registeredAt" | "title";
  sortOrder?: "asc" | "desc";
  isFavorite?: boolean;
}

export type ArticleError =
  | { kind: "duplicate_url" }
  | { kind: "invalid_url" }
  | { kind: "db_error"; message: string };

// --- キュー ---

export interface QueueItem {
  id: number;
  articleId: number;
  position: number;
  addedAt: string; // ISO 8601
  article: Article;
}

// --- 再生履歴 ---

export interface PlaybackHistory {
  id: number;
  articleId: number | null;
  startedAt: string | null;    // ISO 8601、再生開始日時
  completedAt: string;         // ISO 8601、再生完了日時
  durationSeconds: number;
  lastSentenceIndex: number | null; // 最後に再生した文のインデックス (0始まり)
  sentenceCount: number | null;     // 記事の総文数
  article: Article | null;
}

export type HistorySearchTarget = "title" | "content" | "url" | "all";

export interface HistoryFilter {
  search?: string;
  searchTarget?: HistorySearchTarget;
  fromDate?: string;
  toDate?: string;
}

export interface Stats {
  totalPlayed: number;
  totalSeconds: number;
  dailyBreakdown: Array<{
    date: string;
    count: number;
    totalSeconds: number;
  }>;
}

export type StatsPeriod =
  | { type: "week" }
  | { type: "month" }
  | { type: "custom"; from: string; to: string };

// --- 設定 ---

export interface Settings {
  voicevoxSpeakerId: number;
  voicevoxPort: number;
  playbackSpeed: number;
  mp3Bitrate: number;
}

// --- Voicevox ---

export type VoicevoxStatus =
  | { state: "starting" }
  | { state: "ready"; port: number }
  | { state: "restarting"; attempt: number }
  | { state: "failed"; reason: string };

export interface Speaker {
  name: string;
  speakerUuid: string;
  styles: Array<{ name: string; id: number }>;
}

export type VoicevoxApiError =
  | { kind: "unreachable"; port: number }
  | { kind: "synthesis_failed"; statusCode: number; detail: string };

// --- 再生状態 ---

export type PlaybackState =
  | { phase: "idle" }
  | { phase: "synthesizing"; articleId: number; progress: number }
  | { phase: "playing"; articleId: number; currentTime: number; duration: number }
  | { phase: "paused"; articleId: number; currentTime: number }
  | { phase: "error"; articleId: number; error: VoicevoxApiError };

// --- コンテンツ抽出 ---

export type ExtractionResult =
  | { success: true; title: string; textContent: string; contentHtml: string | null; isLikelyArticle: boolean; nextPageUrl?: string }
  | { success: false; fallbackText: string; reason: string };

// --- キーワード ---

export interface KeywordScore {
  word: string;
  score: number; // TF-IDF 正規化済み 0.0–1.0
}

// --- Voicevox 合成パラメータ ---

export interface SynthesisParams {
  text: string;
  speakerId: number;
  speedScale: number; // 0.5–2.0
}

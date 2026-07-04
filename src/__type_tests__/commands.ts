// 型検査専用ファイル: 全エクスポートが正しいシグネチャを持つことを tsc --noEmit で検証する

import type {
  Article,
  ArticleError,
  ArticleFilter,
  ArticleStatus,
  ExtractionResult,
  HistoryFilter,
  PlaybackHistory,
  PlaybackState,
  QueueItem,
  Result,
  Settings,
  Speaker,
  StatsPeriod,
  Stats,
  VoicevoxApiError,
  VoicevoxStatus,
} from "@/shared/types";

import {
  addToQueue,
  deleteArticle,
  getArticles,
  getHistory,
  getQueue,
  getSettings,
  getStats,
  getVoicevoxStatus,
  markExtractionError,
  onExtractionCompleted,
  onExtractionFailed,
  onExtractionStarted,
  onVoicevoxStatusChanged,
  recordPlayback,
  updatePlaybackProgress,
  registerArticle,
  removeFromQueue,
  reorderQueue,
  retryExtract,
  retryVoicevoxConnection,
  saveExtractedContent,
  updateSettings,
} from "@/lib/tauriCommands";

// assertType<T>(value) は value が T に代入可能なら型エラーなし
function assertType<T>(_value: T): void {}

// --- 静的な型形状チェック ---

function checkDomainTypes() {
  const status: ArticleStatus = "pending";

  const article: Article = {
    id: 1,
    url: "https://example.com",
    title: null,
    content: null,
    contentHtml: null,
    status,
    errorMessage: null,
    registeredAt: "2024-01-01T00:00:00Z",
    extractedAt: null,
    isFavorite: false,
    language: "ja",
  };

  const filter: ArticleFilter = {
    status: "ready",
    search: "keyword",
    sortBy: "registeredAt",
    sortOrder: "desc",
  };

  const err1: ArticleError = { kind: "duplicate_url" };
  const err2: ArticleError = { kind: "invalid_url" };
  const err3: ArticleError = { kind: "db_error", message: "err" };

  const ok: Result<Article, ArticleError> = { ok: true, value: article };
  const ng: Result<Article, ArticleError> = { ok: false, error: err1 };

  const qi: QueueItem = {
    id: 1,
    articleId: 1,
    position: 0,
    addedAt: "2024-01-01T00:00:00Z",
    article: {
      id: 1,
      url: "https://example.com",
      title: "t",
      content: null,
      contentHtml: null,
      status: "ready",
      errorMessage: null,
      registeredAt: "2024-01-01T00:00:00Z",
      extractedAt: null,
      isFavorite: false,
      language: "ja",
    },
  };

  const ph: PlaybackHistory = {
    id: 1,
    articleId: 1,
    startedAt: "2024-01-01T00:00:00Z",
    completedAt: "2024-01-01T00:00:01Z",
    durationSeconds: 120,
    lastSentenceIndex: 9,
    sentenceCount: 10,
    article: {
      id: 1,
      url: "https://example.com",
      title: "t",
      content: null,
      contentHtml: null,
      status: "ready",
      errorMessage: null,
      registeredAt: "2024-01-01T00:00:00Z",
      extractedAt: null,
      isFavorite: false,
      language: "ja",
    },
  };

  const hf: HistoryFilter = { search: "k", fromDate: "2024-01-01", toDate: "2024-12-31" };

  const pw: StatsPeriod = { type: "week" };
  const pm: StatsPeriod = { type: "month" };
  const pc: StatsPeriod = { type: "custom", from: "2024-01-01", to: "2024-01-07" };

  const st: Stats = {
    totalPlayed: 5,
    totalSeconds: 600,
    dailyBreakdown: [{ date: "2024-01-01", count: 1, totalSeconds: 120 }],
  };

  const settings: Settings = { voicevoxSpeakerId: 3, voicevoxPort: 50021, playbackSpeed: 1.0, mp3Bitrate: 128 };

  const vs1: VoicevoxStatus = { state: "starting" };
  const vs2: VoicevoxStatus = { state: "ready", port: 50021 };
  const vs3: VoicevoxStatus = { state: "restarting", attempt: 1 };
  const vs4: VoicevoxStatus = { state: "failed", reason: "timeout" };

  const sp: Speaker = {
    name: "四国めたん",
    speakerUuid: "uuid",
    styles: [{ name: "ノーマル", id: 2 }],
  };

  const ve1: VoicevoxApiError = { kind: "unreachable", port: 50021 };
  const ve2: VoicevoxApiError = { kind: "synthesis_failed", statusCode: 500, detail: "err" };

  const pb1: PlaybackState = { phase: "idle" };
  const pb2: PlaybackState = { phase: "synthesizing", articleId: 1, progress: 0.5 };
  const pb3: PlaybackState = { phase: "playing", articleId: 1, currentTime: 5.0, duration: 120.0 };
  const pb4: PlaybackState = { phase: "paused", articleId: 1, currentTime: 5.0 };
  const pb5: PlaybackState = { phase: "error", articleId: 1, error: ve1 };

  const ex1: ExtractionResult = { success: true, title: "t", textContent: "c", contentHtml: null, isLikelyArticle: true };
  const ex2: ExtractionResult = { success: false, fallbackText: "c", reason: "no article" };

  // 全型を assertType で消費して noUnusedLocals を回避
  assertType(article); assertType(filter); assertType(err2); assertType(err3);
  assertType(ok); assertType(ng); assertType(qi); assertType(ph); assertType(hf);
  assertType(pw); assertType(pm); assertType(pc); assertType(st); assertType(settings);
  assertType(vs1); assertType(vs2); assertType(vs3); assertType(vs4); assertType(sp);
  assertType(ve2); assertType(pb1); assertType(pb2); assertType(pb3); assertType(pb4);
  assertType(pb5); assertType(ex1); assertType(ex2);
}

// --- コマンド関数の戻り値型チェック ---

async function checkCommandSignatures() {
  assertType<Promise<Result<Article, ArticleError>>>(
    registerArticle("https://example.com")
  );
  assertType<Promise<Article[]>>(getArticles());
  assertType<Promise<Article[]>>(getArticles({ status: "ready" }));
  assertType<Promise<void>>(deleteArticle(1));
  assertType<Promise<void>>(saveExtractedContent(1, "title", "content"));
  assertType<Promise<void>>(markExtractionError(1, "error"));
  assertType<Promise<void>>(retryExtract(1));

  assertType<Promise<QueueItem[]>>(getQueue());
  assertType<Promise<void>>(addToQueue(1));
  assertType<Promise<void>>(removeFromQueue(1));
  assertType<Promise<void>>(reorderQueue([3, 1, 2]));

  assertType<Promise<number>>(recordPlayback(1, 120));
  assertType<Promise<void>>(updatePlaybackProgress(1, 5, 120));
  assertType<Promise<void>>(updatePlaybackProgress(1, null, 0));
  assertType<Promise<PlaybackHistory[]>>(getHistory());
  assertType<Promise<PlaybackHistory[]>>(getHistory({ search: "kw" }));
  assertType<Promise<Stats>>(getStats());
  assertType<Promise<Stats>>(getStats({ type: "week" }));

  assertType<Promise<Settings>>(getSettings());
  assertType<Promise<void>>(updateSettings({ playbackSpeed: 1.5 }));
  assertType<Promise<VoicevoxStatus>>(getVoicevoxStatus());
  assertType<Promise<VoicevoxStatus>>(retryVoicevoxConnection());

  // イベントリスナー戻り値は Promise<UnlistenFn = () => void>
  const u1 = await onVoicevoxStatusChanged((_: VoicevoxStatus) => {});
  const u2 = await onExtractionCompleted((_: Article) => {});
  const u3 = await onExtractionFailed((_: { id: number; error: string }) => {});
  const u4 = await onExtractionStarted((_: { id: number; html: string }) => {});
  assertType<() => void>(u1);
  assertType<() => void>(u2);
  assertType<() => void>(u3);
  assertType<() => void>(u4);
}

void checkDomainTypes;
void checkCommandSignatures;

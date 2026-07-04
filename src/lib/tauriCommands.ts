import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Article,
  ArticleError,
  ArticleFilter,
  HistoryFilter,
  KeywordScore,
  PlaybackHistory,
  QueueItem,
  Result,
  Settings,
  Stats,
  StatsPeriod,
  VoicevoxStatus,
} from "@/shared/types";

// --- 記事コマンド ---

export async function registerArticle(
  url: string
): Promise<Result<Article, ArticleError>> {
  try {
    const value = await invoke<Article>("register_article", { url });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error as ArticleError };
  }
}

export async function getArticles(filter?: ArticleFilter): Promise<Article[]> {
  return invoke<Article[]>("get_articles", { filter: filter ?? null });
}

export async function deleteArticle(id: number): Promise<void> {
  return invoke("delete_article", { id });
}

export async function saveExtractedContent(
  id: number,
  title: string,
  content: string,
  contentHtml?: string | null
): Promise<void> {
  return invoke("save_extracted_content", { id, title, content, contentHtml: contentHtml ?? null });
}

export async function markExtractionError(
  id: number,
  errorMessage: string
): Promise<void> {
  return invoke("mark_extraction_error", { id, errorMessage });
}

export async function retryExtract(id: number): Promise<void> {
  return invoke("retry_extract", { id });
}

export async function fetchPageHtml(url: string): Promise<string> {
  return invoke<string>("fetch_page_html", { url });
}

export async function toggleFavorite(id: number): Promise<Article> {
  return invoke<Article>("toggle_favorite", { id });
}

export async function getArticleKeywords(id: number): Promise<KeywordScore[]> {
  return invoke<KeywordScore[]>("get_article_keywords", { id });
}

// --- キューコマンド ---

export async function getQueue(): Promise<QueueItem[]> {
  return invoke<QueueItem[]>("get_queue");
}

export async function addToQueue(articleId: number): Promise<void> {
  try {
    await invoke("add_to_queue", { articleId });
  } catch (e: unknown) {
    // 同一記事が既にキューに存在する場合は成功扱いにする
    if (isAlreadyQueued(e)) return;
    throw e;
  }
}

function isAlreadyQueued(e: unknown): boolean {
  return typeof e === "object" && e !== null && "type" in e &&
    (e as { type: string }).type === "already_queued";
}

export async function removeFromQueue(id: number): Promise<void> {
  return invoke("remove_from_queue", { id });
}

export async function reorderQueue(orderedIds: number[]): Promise<void> {
  return invoke("reorder_queue", { orderedIds });
}

// --- 履歴コマンド ---

export async function recordPlayback(
  articleId: number,
  durationSeconds: number,
  startedAt?: string | null,
  lastSentenceIndex?: number | null,
  sentenceCount?: number | null,
): Promise<number> {
  return invoke<number>("record_playback", {
    articleId,
    durationSeconds,
    startedAt: startedAt ?? null,
    lastSentenceIndex: lastSentenceIndex ?? null,
    sentenceCount: sentenceCount ?? null,
  });
}

export async function updatePlaybackProgress(
  id: number,
  lastSentenceIndex: number | null,
  durationSeconds: number,
): Promise<void> {
  return invoke("update_playback_progress", { id, lastSentenceIndex, durationSeconds });
}

export async function getHistory(
  filter?: HistoryFilter
): Promise<PlaybackHistory[]> {
  return invoke<PlaybackHistory[]>("get_history", { filter: filter ?? null });
}

export async function getLastPlayback(articleId: number): Promise<PlaybackHistory | null> {
  return invoke<PlaybackHistory | null>("get_last_playback", { articleId });
}

export async function getStats(period?: StatsPeriod): Promise<Stats> {
  return invoke<Stats>("get_stats", { period: period ?? null });
}

export async function deleteHistoryItem(id: number): Promise<void> {
  return invoke("delete_history_item", { id });
}

export async function deleteAllHistory(): Promise<void> {
  return invoke("delete_all_history");
}

// --- 設定コマンド ---

export async function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export async function updateSettings(
  settings: Partial<Settings>
): Promise<void> {
  return invoke("update_settings", { settings });
}

export async function getVoicevoxStatus(): Promise<VoicevoxStatus> {
  return invoke<VoicevoxStatus>("get_voicevox_status");
}

export async function retryVoicevoxConnection(): Promise<VoicevoxStatus> {
  return invoke<VoicevoxStatus>("retry_voicevox_connection");
}

// --- エンジンセットアップコマンド ---

export async function checkEngineInstalled(): Promise<boolean> {
  return invoke<boolean>("check_engine_installed");
}

export async function downloadEngine(): Promise<void> {
  return invoke("download_engine");
}

// --- Tauri イベントリスナーヘルパー ---

export async function onVoicevoxStatusChanged(
  callback: (status: VoicevoxStatus) => void
): Promise<UnlistenFn> {
  return listen<VoicevoxStatus>("voicevox:status-changed", (event) => {
    callback(event.payload);
  });
}

export async function onExtractionCompleted(
  callback: (article: Article) => void
): Promise<UnlistenFn> {
  return listen<Article>("article:extraction-completed", (event) => {
    callback(event.payload);
  });
}

export async function onExtractionFailed(
  callback: (payload: { id: number; error: string }) => void
): Promise<UnlistenFn> {
  return listen<{ id: number; error: string }>(
    "article:extraction-failed",
    (event) => {
      callback(event.payload);
    }
  );
}

export async function onExtractionStarted(
  callback: (payload: { id: number; html: string; url: string }) => void
): Promise<UnlistenFn> {
  return listen<{ id: number; html: string; url: string }>(
    "article:extraction-started",
    (event) => {
      callback(event.payload);
    }
  );
}

// --- ログインウィンドウ ---

export async function openLoginWindow(url: string): Promise<void> {
  await invoke("open_login_window", { url });
}

// --- Piper TTS コマンド ---

export async function checkPiperInstalled(): Promise<boolean> {
  return invoke<boolean>("check_piper_installed");
}

export async function downloadPiper(): Promise<void> {
  return invoke("download_piper");
}

export async function synthesizeEnglish(text: string): Promise<string> {
  return invoke<string>("synthesize_english", { text });
}

export async function onPiperSetupProgress(
  callback: (payload: { downloaded: number; total: number }) => void
): Promise<UnlistenFn> {
  return listen<{ downloaded: number; total: number }>(
    "piper-setup:progress",
    (event) => {
      callback(event.payload);
    }
  );
}

// --- アップデート確認 ---

export type UpdateInfo = {
  hasUpdate: boolean;
  latestVersion: string;
  releaseUrl: string;
};

export async function checkForUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_update");
}

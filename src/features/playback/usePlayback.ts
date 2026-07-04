import { useReducer, useRef, useState, useCallback, useEffect } from "react";
import { VoicevoxClient, VoicevoxClientError, splitSentences } from "@/lib/voicevoxClient";
import { PiperClient } from "@/lib/piperClient";
import {
  getQueue,
  getArticles,
  removeFromQueue,
  recordPlayback,
  updatePlaybackProgress,
  getLastPlayback,
  getArticleKeywords,
} from "@/lib/tauriCommands";
import { selectKeySentenceIndices } from "@/lib/summarize";
import { QUEUE_CHANGED_EVENT } from "@/features/queue/useQueue";
import {
  getAudio,
  putAudio,
  computeWavDuration,
  CACHE_UPDATED_EVENT,
  type CacheEntry,
} from "@/lib/audioCache";
import { wavToMp3 } from "@/lib/mp3Encoder";
import { buildFullText } from "@/features/viewer/viewerUtils";
import type { PlaybackState, VoicevoxApiError } from "@/shared/types";

// ─── Reducer ─────────────────────────────────────────────────────────────────

type Action =
  | { type: "SYNTHESIZING"; articleId: number }
  | { type: "PLAYING"; articleId: number }
  | { type: "PAUSE"; currentTime: number }
  | { type: "RESUME" }
  | { type: "ERROR"; articleId: number; error: VoicevoxApiError }
  | { type: "IDLE" };

function reducer(state: PlaybackState, action: Action): PlaybackState {
  switch (action.type) {
    case "SYNTHESIZING":
      return { phase: "synthesizing", articleId: action.articleId, progress: 0 };
    case "PLAYING":
      return { phase: "playing", articleId: action.articleId, currentTime: 0, duration: 0 };
    case "PAUSE":
      if (state.phase === "playing") {
        return { phase: "paused", articleId: state.articleId, currentTime: action.currentTime };
      }
      return state;
    case "RESUME":
      if (state.phase === "paused") {
        return { phase: "playing", articleId: state.articleId, currentTime: state.currentTime, duration: 0 };
      }
      return state;
    case "ERROR":
      return { phase: "error", articleId: action.articleId, error: action.error };
    case "IDLE":
      return { phase: "idle" };
    default:
      return state;
  }
}

function toApiError(e: unknown): VoicevoxApiError {
  if (e instanceof VoicevoxClientError) return e.apiError;
  return { kind: "synthesis_failed", statusCode: 0, detail: String(e) };
}

// ─── 公開インターフェース ──────────────────────────────────────────────────

export interface UsePlaybackResult {
  state: PlaybackState;
  speedScale: number;
  volume: number;
  segmentIndex: number | null;
  segmentCount: number;
  /** バックグラウンド合成の進捗。合成中の記事 ID と文数を含む */
  synthProgress: { articleId: number; done: number; total: number } | null;
  /** バッチ合成が実行中かどうか */
  batchSynthRunning: boolean;
  /** 経過再生時間（秒）。再生中のセグメントを含む累積値 */
  elapsedSeconds: number;
  /** 合計再生時間情報。null = 未取得。isComplete = false の場合は暫定値 */
  totalDurationInfo: { seconds: number; isComplete: boolean } | null;
  /** 要点抽出読み上げモード（重要文のみ再生）が有効かどうか */
  summaryMode: boolean;
  /** 要点モードの ON/OFF を切り替える */
  setSummaryMode: (on: boolean) => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  seekForward: (seconds: number) => void;
  seekBackward: (seconds: number) => void;
  jumpToSegment: (idx: number, offsetSec?: number) => void;
  setSpeedScale: (scale: number) => void;
  setVolume: (volume: number) => void;
  /** 指定記事を再生なしでバックグラウンド合成する */
  preSynthesize: (articleId: number) => void;
  /** 指定順（省略時: キュー先頭→未合成記事）でバッチ合成を開始する */
  startBatchSynth: (orderedIds?: number[]) => Promise<void>;
  /** バッチ合成を中断する */
  stopBatchSynth: () => void;
  /** 現在の再生を中断してキュー先頭から再起動する（queue[0] は削除しない） */
  restart: () => void;
}

// ─── フック ───────────────────────────────────────────────────────────────

export function usePlayback({
  port,
  speakerId,
  initialSpeedScale = 1.0,
  mp3Bitrate = 128,
}: {
  port: number;
  speakerId: number;
  initialSpeedScale?: number;
  mp3Bitrate?: number;
}): UsePlaybackResult {
  const [state, dispatch] = useReducer(reducer, { phase: "idle" });
  const [speedScale, setSpeedScaleState] = useState(() => {
    const saved = localStorage.getItem("mimiweb.speed");
    return saved ? parseFloat(saved) : initialSpeedScale;
  });
  const [volume, setVolumeState] = useState(() => {
    const saved = localStorage.getItem("mimiweb.volume");
    return saved ? parseFloat(saved) : 1.0;
  });
  const [segmentIndex, setSegmentIndex] = useState<number | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [synthProgress, setSynthProgress] = useState<{ articleId: number; done: number; total: number } | null>(null);

  const stateRef = useRef<PlaybackState>({ phase: "idle" });
  stateRef.current = state;

  const speedScaleRef = useRef(initialSpeedScale);
  speedScaleRef.current = speedScale;

  const volumeRef = useRef(1.0);
  volumeRef.current = volume;

  const speakerIdRef = useRef(speakerId);
  speakerIdRef.current = speakerId;

  const mp3BitrateRef = useRef(mp3Bitrate);
  mp3BitrateRef.current = mp3Bitrate;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(0);
  const isRunningRef = useRef(false);
  const clientRef = useRef(new VoicevoxClient(port));
  const piperClientRef = useRef(new PiperClient());
  const articleLanguageRef = useRef<"ja" | "en">("ja");

  const segmentIndexRef = useRef<number | null>(null);
  const segmentCountRef = useRef(0);
  const jumpStartRef = useRef<{ idx: number; offset: number } | null>(null);

  // バックグラウンド合成制御
  const bgSynthRef = useRef<{ articleId: number; cancelled: boolean } | null>(null);
  // 合成エラーを再生ループへ伝達するための ref
  const synthErrorRef = useRef<{ articleId: number; error: VoicevoxApiError } | null>(null);
  // バッチ合成制御
  const batchSynthControllerRef = useRef<{ cancelled: boolean } | null>(null);
  const [batchSynthRunning, setBatchSynthRunning] = useState(false);

  // 要点抽出読み上げモード（localStorage 永続化）
  const [summaryMode, setSummaryModeState] = useState(() => localStorage.getItem("mimiweb.summaryMode") === "true");
  const summaryModeRef = useRef(summaryMode);
  summaryModeRef.current = summaryMode;
  const setSummaryMode = useCallback((on: boolean) => {
    setSummaryModeState(on);
    localStorage.setItem("mimiweb.summaryMode", String(on));
  }, []);
  // 現在再生中の記事の要点文インデックス集合
  const keySegmentsRef = useRef<Set<number> | null>(null);

  // 再生時間表示
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [totalDurationInfo, setTotalDurationInfo] = useState<{ seconds: number; isComplete: boolean } | null>(null);
  const completedDurationRef = useRef(0); // 再生完了した文の累積時間（秒）
  const playingArticleIdRef = useRef<number | null>(null); // 現在再生中の記事 ID

  useEffect(() => {
    clientRef.current = new VoicevoxClient(port);
  }, [port]);

  // playing 中は 300ms ごとに経過時間を更新する
  useEffect(() => {
    if (state.phase !== "playing") return;
    const interval = setInterval(() => {
      setElapsedSeconds(completedDurationRef.current + (audioRef.current?.currentTime ?? 0));
    }, 300);
    return () => clearInterval(interval);
  }, [state.phase]);

  // idle / error 遷移時にカウンターをリセットする
  useEffect(() => {
    if (state.phase === "idle" || state.phase === "error") {
      completedDurationRef.current = 0;
      playingArticleIdRef.current = null;
      setElapsedSeconds(0);
      setTotalDurationInfo(null);
    }
  }, [state.phase]);

  // CACHE_UPDATED_EVENT で合計再生時間を随時更新する
  useEffect(() => {
    function handleCacheUpdate() {
      const articleId = playingArticleIdRef.current;
      if (!articleId) return;
      getAudio(articleId)
        .then((cached) => {
          if (cached && cached.totalDurationSeconds > 0) {
            setTotalDurationInfo({
              seconds: cached.totalDurationSeconds,
              isComplete: cached.isComplete ?? false,
            });
          }
        })
        .catch(() => {});
    }
    window.addEventListener(CACHE_UPDATED_EVENT, handleCacheUpdate);
    return () => window.removeEventListener(CACHE_UPDATED_EVENT, handleCacheUpdate);
  }, []);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      audioRef.current?.pause();
      audioRef.current = null;
      resolveRef.current?.();
      resolveRef.current = null;
      if (bgSynthRef.current) {
        bgSynthRef.current.cancelled = true;
        bgSynthRef.current = null;
      }
    };
  }, []);

  /** blob を再生する共通ヘルパー。startSec > 0 のときは loadedmetadata 後にシークする */
  async function playBlob(blob: Blob, startSec = 0): Promise<void> {
    const url = URL.createObjectURL(blob);
    await new Promise<void>((resolve) => {
      resolveRef.current = resolve;
      const audio = new Audio(url);
      audio.playbackRate = speedScaleRef.current;
      audio.volume = volumeRef.current;
      audioRef.current = audio;
      const done = () => {
        URL.revokeObjectURL(url);
        resolveRef.current = null;
        resolve();
      };
      audio.addEventListener("ended", done, { once: true });
      audio.addEventListener("error", done, { once: true });
      if (startSec > 0) {
        audio.addEventListener("loadedmetadata", () => {
          if (isFinite(audio.duration) && startSec < audio.duration) {
            audio.currentTime = startSec;
          }
        }, { once: true });
      }
      audio.play().catch(done);
    });
  }

  /**
   * バックグラウンドで記事の未合成部分を順次合成しキャッシュへ保存する。
   * 再生の一時停止中も中断せず全文合成を目指す。
   * 別の記事が対象の場合は既存合成をキャンセルして切り替える。
   */
  const launchBackgroundSynth = useCallback((
    articleId: number,
    sentences: string[],
    fromIdx: number,
    existingEntry: CacheEntry | null,
    language: "ja" | "en" = "ja",
  ) => {
    if (bgSynthRef.current) {
      if (bgSynthRef.current.articleId === articleId && !bgSynthRef.current.cancelled) return;
      bgSynthRef.current.cancelled = true;
      setSynthProgress(null);
    }
    if (fromIdx >= sentences.length) return;

    const ctrl = { articleId, cancelled: false };
    bgSynthRef.current = ctrl;

    const accBlobs: Blob[] = existingEntry ? [...existingEntry.blobs] : [];
    let totalDuration = existingEntry?.totalDurationSeconds ?? 0;
    let totalSize = existingEntry?.totalSizeBytes ?? 0;
    const cachedAt = existingEntry?.cachedAt ?? new Date().toISOString();

    (async () => {
      for (let i = fromIdx; i < sentences.length; i++) {
        if (ctrl.cancelled || bgSynthRef.current !== ctrl) break;

        let blob: Blob;
        try {
          if (language === "en") {
            blob = await piperClientRef.current.synthesize(sentences[i]);
          } else {
            blob = await clientRef.current.synthesize({
              text: sentences[i],
              speakerId: speakerIdRef.current,
              speedScale: 1.0,
            });
          }
        } catch (e) {
          if (!ctrl.cancelled && bgSynthRef.current === ctrl) {
            synthErrorRef.current = { articleId, error: toApiError(e) };
            window.dispatchEvent(new CustomEvent(CACHE_UPDATED_EVENT));
          }
          break;
        }

        if (ctrl.cancelled || bgSynthRef.current !== ctrl) break;

        const dur = await computeWavDuration(blob);
        const mp3Blob = await wavToMp3(blob, mp3BitrateRef.current);
        accBlobs.push(mp3Blob);
        totalDuration += dur;
        totalSize += mp3Blob.size;

        try {
          await putAudio({
            articleId,
            blobs: [...accBlobs],
            totalDurationSeconds: totalDuration,
            totalSizeBytes: totalSize,
            cachedAt,
            isComplete: accBlobs.length >= sentences.length,
            sentenceCount: accBlobs.length,
          });
          window.dispatchEvent(new CustomEvent(CACHE_UPDATED_EVENT));
          setSynthProgress({ articleId, done: i + 1, total: sentences.length });
        } catch { /* ignore */ }
      }

      if (bgSynthRef.current === ctrl) {
        bgSynthRef.current = null;
        setSynthProgress(null);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 再生ループ: キューが空になるまで記事を順次再生する */
  const runLoop = useCallback(async (session: number) => {
    isRunningRef.current = true;
    try {
      while (session === sessionRef.current) {
        let queue: Awaited<ReturnType<typeof getQueue>>;
        try {
          queue = await getQueue();
        } catch {
          if (session === sessionRef.current) dispatch({ type: "IDLE" });
          break;
        }
        if (queue.length === 0 || session !== sessionRef.current) {
          if (session === sessionRef.current) dispatch({ type: "IDLE" });
          break;
        }

        const queueItem = queue[0];

        // 記事が切り替わったときに経過時間カウンターをリセットする
        if (queueItem.articleId !== playingArticleIdRef.current) {
          playingArticleIdRef.current = queueItem.articleId;
          completedDurationRef.current = 0;
          setElapsedSeconds(0);
          setTotalDurationInfo(null);
        }

        let fullText = "";
        try {
          const articles = await getArticles();
          if (session !== sessionRef.current) break;
          const article = articles.find((a) => a.id === queueItem.articleId);
          fullText = buildFullText(article?.title ?? null, article?.content ?? null, article?.contentHtml ?? null);
          articleLanguageRef.current = (article?.language ?? "ja") as "ja" | "en";
        } catch {
          if (session === sessionRef.current) dispatch({ type: "IDLE" });
          break;
        }

        const articleLanguage = articleLanguageRef.current;

        if (!fullText) {
          try { await removeFromQueue(queueItem.id); } catch { /* ignore */ }
          continue;
        }

        const sentences = splitSentences(fullText, articleLanguage);
        if (sentences.length === 0) {
          try { await removeFromQueue(queueItem.id); } catch { /* ignore */ }
          continue;
        }

        // 要点モード用に重要文インデックスを計算する（失敗時は null = 全文再生）。
        // モードの ON/OFF に関わらず計算しておき、再生中のトグルにも即対応できるようにする。
        try {
          const kws = await getArticleKeywords(queueItem.articleId);
          if (session !== sessionRef.current) break;
          keySegmentsRef.current = selectKeySentenceIndices(sentences, kws);
        } catch {
          keySegmentsRef.current = null;
        }

        const cached = await getAudio(queueItem.articleId);
        const numCached = cached ? Math.min(cached.blobs.length, sentences.length) : 0;
        const isFullyCached = !!(cached?.isComplete && numCached >= sentences.length);

        // 合計再生時間をキャッシュから取得（合成完了なら確定値、未完了なら暫定）
        if (cached && cached.totalDurationSeconds > 0) {
          setTotalDurationInfo({
            seconds: cached.totalDurationSeconds,
            isComplete: cached.isComplete ?? false,
          });
        }

        // 未合成の文があればバックグラウンドで合成を開始する (一時停止中も継続)
        if (!isFullyCached) {
          launchBackgroundSynth(queueItem.articleId, sentences, numCached, cached, articleLanguage);
        }

        // jumpToSegment から開始位置を取得してクリア
        const jumpStart = jumpStartRef.current;
        if (jumpStart !== null) jumpStartRef.current = null;

        // jumpStart がない場合、直近履歴からレジューム位置を決定する。
        // ※ 新しい履歴レコードを INSERT する前に呼ぶことで、前回セッションのデータを参照する。
        let resumeFrom = 0;
        if (!jumpStart) {
          try {
            const lastPlay = await getLastPlayback(queueItem.articleId);
            if (session !== sessionRef.current) break;
            if (
              lastPlay !== null &&
              lastPlay.lastSentenceIndex !== null &&
              lastPlay.sentenceCount !== null &&
              lastPlay.lastSentenceIndex + 1 < lastPlay.sentenceCount && // 未完了だった
              lastPlay.lastSentenceIndex + 1 < sentences.length          // 現在の文数内に収まる
            ) {
              resumeFrom = lastPlay.lastSentenceIndex + 1;
            }
          } catch { /* 履歴取得失敗時は先頭から再生 */ }
        }

        const playFrom = jumpStart && jumpStart.idx < sentences.length ? jumpStart.idx : resumeFrom;
        const playFromOffset = jumpStart ? jumpStart.offset : 0;

        setSegmentCount(sentences.length);
        segmentCountRef.current = sentences.length;

        // 再生開始文がキャッシュ済みなら即 PLAYING、未合成なら SYNTHESIZING で待機
        if (numCached > playFrom) {
          dispatch({ type: "PLAYING", articleId: queueItem.articleId });
        } else {
          dispatch({ type: "SYNTHESIZING", articleId: queueItem.articleId });
          setSynthProgress({ articleId: queueItem.articleId, done: numCached, total: sentences.length });
        }

        const startTime = Date.now();
        const startedAt = new Date().toISOString();

        // 再生開始時点で履歴レコードを INSERT する。duration と lastSentenceIndex は後から UPDATE する。
        let playbackId: number | null = null;
        try {
          playbackId = await recordPlayback(queueItem.articleId, 0, startedAt, null, sentences.length);
        } catch { /* 進捗保存なしで続行 */ }
        if (session !== sessionRef.current) break;

        let sessionBroken = false;
        let synthError = false;
        let playingDispatched = numCached > playFrom;
        let lastCompletedIdx: number | null = null; // 完全に再生し終えた最後の文インデックス

        for (let i = playFrom; i < sentences.length; i++) {
          if (session !== sessionRef.current) { sessionBroken = true; break; }

          // 要点モード: 重要文以外は読み上げをスキップする（キャッシュ・合成は通常通り進む）
          if (summaryModeRef.current && keySegmentsRef.current && !keySegmentsRef.current.has(i)) {
            continue;
          }

          // キャッシュに blob[i] が現れるまで待機 (バックグラウンド合成が保存するのを待つ)
          let blob: Blob | null = null;
          while (session === sessionRef.current) {
            const entry = await getAudio(queueItem.articleId);
            if (entry && entry.blobs.length > i) {
              blob = entry.blobs[i];
              break;
            }
            if (synthErrorRef.current?.articleId === queueItem.articleId) {
              const err = synthErrorRef.current.error;
              synthErrorRef.current = null;
              dispatch({ type: "ERROR", articleId: queueItem.articleId, error: err });
              synthError = true;
              break;
            }
            // CACHE_UPDATED_EVENT または 1s タイムアウトで再チェック
            await new Promise<void>(resolve => {
              let fired = false;
              function wake() { if (!fired) { fired = true; resolve(); } }
              window.addEventListener(CACHE_UPDATED_EVENT, wake, { once: true });
              setTimeout(wake, 1000);
            });
          }

          if (synthError) break;
          if (!blob || session !== sessionRef.current) { sessionBroken = true; break; }

          // 初めて blob が得られた瞬間に SYNTHESIZING → PLAYING へ遷移
          if (!playingDispatched) {
            dispatch({ type: "PLAYING", articleId: queueItem.articleId });
            playingDispatched = true;
          }

          setSegmentIndex(i);
          segmentIndexRef.current = i;
          await playBlob(blob, i === playFrom ? playFromOffset : 0);

          // playBlob 後にセッションが切り替わっていれば skip/restart による中断
          if (session !== sessionRef.current) {
            sessionBroken = true;
            break;
          }

          // 文 i が正常に完了 → 再生時間を累積して進捗を保存 (fire-and-forget)
          lastCompletedIdx = i;
          const segDuration = audioRef.current?.duration ?? 0;
          completedDurationRef.current += (i === playFrom && playFromOffset > 0)
            ? Math.max(0, segDuration - playFromOffset)
            : segDuration;
          setElapsedSeconds(completedDurationRef.current);
          if (playbackId !== null) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            updatePlaybackProgress(playbackId, i, elapsed).catch(() => {});
          }
        }

        setSegmentIndex(null);
        segmentIndexRef.current = null;

        // 中断・完了いずれの場合も最終状態を確実に保存する
        if (playbackId !== null) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          try {
            await updatePlaybackProgress(playbackId, lastCompletedIdx, elapsed);
          } catch { /* ignore */ }
        }

        if (sessionBroken || synthError) break;

        // 正常完了 → キューから削除
        try {
          await removeFromQueue(queueItem.id);
          window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
        } catch { /* ignore */ }
      }
    } finally {
      if (session === sessionRef.current) {
        isRunningRef.current = false;
      }
    }
  }, [launchBackgroundSynth]);

  const start = useCallback(() => {
    if (isRunningRef.current) return;
    if (stateRef.current.phase !== "idle") return;
    sessionRef.current += 1;
    runLoop(sessionRef.current);
  }, [runLoop]);

  const pause = useCallback(() => {
    const phase = stateRef.current.phase;
    if (phase === "playing") {
      audioRef.current?.pause();
      dispatch({ type: "PAUSE", currentTime: audioRef.current?.currentTime ?? 0 });
    } else if (phase === "synthesizing") {
      // 合成待機ループを中断して IDLE へ遷移（記事はキューに残る）
      sessionRef.current += 1;
      isRunningRef.current = false; // start() が再度動作できるよう開放
      dispatch({ type: "IDLE" });
    }
  }, []);

  const resume = useCallback(() => {
    if (stateRef.current.phase !== "paused") return;
    audioRef.current?.play();
    dispatch({ type: "RESUME" });
  }, []);

  const skip = useCallback(() => {
    // 現在の記事のバックグラウンド合成をキャンセル
    if (bgSynthRef.current) {
      bgSynthRef.current.cancelled = true;
      bgSynthRef.current = null;
      setSynthProgress(null);
    }

    audioRef.current?.pause();
    audioRef.current = null;
    resolveRef.current?.();
    resolveRef.current = null;

    sessionRef.current += 1;
    const session = sessionRef.current;
    dispatch({ type: "IDLE" });

    (async () => {
      try {
        const queue = await getQueue();
        if (session !== sessionRef.current) return;
        if (queue.length > 0) {
          await removeFromQueue(queue[0].id);
          window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
          if (session !== sessionRef.current) return;
        }
      } catch { /* ignore */ }
      if (session === sessionRef.current) {
        runLoop(session);
      }
    })();
  }, [runLoop]);

  /** 現在の再生を中断してキュー先頭から再起動する。queue[0] は削除しない。 */
  const restart = useCallback(() => {
    if (bgSynthRef.current) {
      bgSynthRef.current.cancelled = true;
      bgSynthRef.current = null;
      setSynthProgress(null);
    }
    audioRef.current?.pause();
    audioRef.current = null;
    resolveRef.current?.();
    resolveRef.current = null;
    sessionRef.current += 1;
    dispatch({ type: "IDLE" });
    runLoop(sessionRef.current);
  }, [runLoop]);

  const setSpeedScale = useCallback((scale: number) => {
    speedScaleRef.current = scale;
    setSpeedScaleState(scale);
    localStorage.setItem("mimiweb.speed", String(scale));
    if (audioRef.current) {
      audioRef.current.playbackRate = scale;
    }
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    volumeRef.current = clamped;
    setVolumeState(clamped);
    localStorage.setItem("mimiweb.volume", String(clamped));
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
  }, []);

  /**
   * 指定セグメント (+ オフセット秒) へジャンプする。
   * 同一セグメントならオーディオの currentTime を直接操作。
   * 別セグメントならセッションを再起動し runLoop の先頭で開始位置を適用する。
   */
  const jumpToSegment = useCallback((idx: number, offsetSec = 0) => {
    const s = stateRef.current;
    // 合成待機中（synthesizing）もジャンプを許可する。
    // セッションをインクリメントすることで待機ループが脱出し、
    // 合成済みセグメントへ即時再生が可能になる。
    if (s.phase !== "playing" && s.phase !== "paused" && s.phase !== "synthesizing") return;

    const currentIdx = segmentIndexRef.current;
    if (currentIdx === idx) {
      const audio = audioRef.current;
      if (audio && isFinite(audio.duration)) {
        audio.currentTime = Math.max(0, Math.min(audio.duration, offsetSec));
      }
      return;
    }

    jumpStartRef.current = { idx, offset: offsetSec };
    audioRef.current?.pause();
    audioRef.current = null;
    resolveRef.current?.();
    resolveRef.current = null;
    sessionRef.current += 1;
    // "playing"/"paused" から runLoop を再起動する際、SYNTHESIZING へ即遷移して
    // state が古い "paused" のまま残らないようにする
    dispatch({ type: "SYNTHESIZING", articleId: s.articleId });
    runLoop(sessionRef.current);
  }, [runLoop]);

  const seekForward = useCallback((seconds: number) => {
    const phase = stateRef.current.phase;
    if (phase !== "playing" && phase !== "paused") return;
    const audio = audioRef.current;
    if (!audio) return;
    const newTime = audio.currentTime + seconds;
    audio.currentTime = isFinite(audio.duration) && newTime >= audio.duration
      ? audio.duration
      : Math.max(0, newTime);
  }, []);

  const seekBackward = useCallback((seconds: number) => {
    const phase = stateRef.current.phase;
    if (phase !== "playing" && phase !== "paused") return;
    const audio = audioRef.current;
    if (!audio) return;
    const newTime = audio.currentTime - seconds;
    if (newTime >= 0) {
      audio.currentTime = newTime;
    } else if (segmentIndexRef.current !== null && segmentIndexRef.current > 0) {
      jumpToSegment(segmentIndexRef.current - 1, 0);
    } else {
      audio.currentTime = 0;
    }
  }, [jumpToSegment]);

  /** 指定記事を再生なしでバックグラウンド合成する (手動一括合成ボタン用) */
  const preSynthesize = useCallback(async (articleId: number) => {
    if (bgSynthRef.current?.articleId === articleId && !bgSynthRef.current.cancelled) return;
    try {
      const [articles, cached] = await Promise.all([getArticles(), getAudio(articleId)]);
      const article = articles.find((a) => a.id === articleId);
      if (!article) return;
      const fullText = buildFullText(article.title ?? null, article.content ?? null, article.contentHtml ?? null);
      if (!fullText) return;
      const lang = (article.language ?? "ja") as "ja" | "en";
      const sentences = splitSentences(fullText, lang);
      if (sentences.length === 0) return;
      const numCached = cached ? Math.min(cached.blobs.length, sentences.length) : 0;
      if (cached?.isComplete && numCached >= sentences.length) return;
      launchBackgroundSynth(articleId, sentences, numCached, cached, lang);
    } catch { /* ignore */ }
  }, [launchBackgroundSynth]);

  const stopBatchSynth = useCallback(() => {
    if (batchSynthControllerRef.current) {
      batchSynthControllerRef.current.cancelled = true;
      batchSynthControllerRef.current = null;
    }
    // 再生が停止中の場合はバックグラウンド合成も停止する
    if (stateRef.current.phase === "idle" || stateRef.current.phase === "error") {
      if (bgSynthRef.current) {
        bgSynthRef.current.cancelled = true;
        bgSynthRef.current = null;
        setSynthProgress(null);
      }
    }
    setBatchSynthRunning(false);
  }, []);

  const startBatchSynth = useCallback(async (orderedIds?: number[]) => {
    if (batchSynthControllerRef.current && !batchSynthControllerRef.current.cancelled) return;

    const ctrl = { cancelled: false };
    batchSynthControllerRef.current = ctrl;
    setBatchSynthRunning(true);

    try {
      let idsToProcess: number[];

      if (orderedIds) {
        idsToProcess = orderedIds;
      } else {
        const [queue, articles] = await Promise.all([getQueue(), getArticles()]);
        if (ctrl.cancelled) return;
        const queueArticleIds = queue.map((q) => q.articleId);
        const queueSet = new Set(queueArticleIds);
        const otherIds = articles
          .filter((a) =>
            (a.status === "ready" || a.status === "queued" || a.status === "played") &&
            !queueSet.has(a.id)
          )
          .map((a) => a.id);
        idsToProcess = [...queueArticleIds, ...otherIds];
      }

      for (const articleId of idsToProcess) {
        if (ctrl.cancelled) break;

        const [arts, cached] = await Promise.all([getArticles(), getAudio(articleId)]);
        if (ctrl.cancelled) break;

        const article = arts.find((a) => a.id === articleId);
        if (!article) continue;

        const fullText = buildFullText(article.title ?? null, article.content ?? null, article.contentHtml ?? null);
        if (!fullText) continue;

        const lang = (article.language ?? "ja") as "ja" | "en";
        const sentences = splitSentences(fullText, lang);
        if (!sentences.length) continue;

        const numCached = cached ? Math.min(cached.blobs.length, sentences.length) : 0;
        if (cached?.isComplete && numCached >= sentences.length) continue;

        launchBackgroundSynth(articleId, sentences, numCached, cached, lang);

        // この記事の合成完了を待つ
        while (!ctrl.cancelled) {
          const bg = bgSynthRef.current;
          if (!bg || bg.articleId !== articleId || bg.cancelled) break;
          await new Promise<void>((resolve) => {
            let done = false;
            function wake() { if (!done) { done = true; resolve(); } }
            window.addEventListener(CACHE_UPDATED_EVENT, wake, { once: true });
            setTimeout(wake, 500);
          });
        }
      }
    } finally {
      if (batchSynthControllerRef.current === ctrl) {
        batchSynthControllerRef.current = null;
        setBatchSynthRunning(false);
      }
    }
  }, [launchBackgroundSynth]);

  return {
    state, speedScale, volume,
    segmentIndex, segmentCount, synthProgress,
    batchSynthRunning,
    elapsedSeconds, totalDurationInfo,
    summaryMode, setSummaryMode,
    start, pause, resume, skip, restart,
    seekForward, seekBackward, jumpToSegment,
    setSpeedScale, setVolume, preSynthesize,
    startBatchSynth, stopBatchSynth,
  };
}

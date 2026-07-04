import { useEffect, useRef } from "react";
import {
  Play, Pause, Rewind, FastForward, SkipBack, SkipForward,
  StepForward, Volume2, Volume1, VolumeX,
} from "lucide-react";
import { getCurrentKeybindings, matchesBinding } from "@/lib/keybindings";
import type { UsePlaybackResult } from "./usePlayback";
import type { Article } from "@/shared/types";

const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

function formatTime(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function SpeakerIcon({ v, size = 16 }: { v: number; size?: number }) {
  if (v === 0) return <VolumeX size={size} />;
  if (v < 0.5) return <Volume1 size={size} />;
  return <Volume2 size={size} />;
}

function isInputFocused(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

// ─── ショートカットヒント付きボタンラッパー ──────────────────────────────

function ShortcutBtn({
  hint,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { hint?: string }) {
  if (!hint) return <button {...props} />;
  return (
    <span className="btn-with-hint">
      <button {...props} />
      <span className="kbd-hint" aria-hidden>{hint}</span>
    </span>
  );
}

// ─── プログレスバー ───────────────────────────────────────────────────────

function ProgressBar({
  segmentIndex,
  segmentCount,
  onSeek,
}: {
  segmentIndex: number | null;
  segmentCount: number;
  onSeek: (idx: number) => void;
}) {
  if (segmentCount === 0 || segmentIndex === null) return null;

  const pct = Math.min(100, ((segmentIndex + 1) / segmentCount) * 100);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const targetIdx = Math.min(segmentCount - 1, Math.max(0, Math.floor(ratio * segmentCount)));
    onSeek(targetIdx);
  }

  return (
    <div
      onClick={handleClick}
      title={`文 ${segmentIndex + 1} / ${segmentCount} — クリックでジャンプ`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 4,
        background: "var(--progress-track)",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: "var(--accent)",
          transition: "width 0.15s linear",
        }}
      />
    </div>
  );
}

// ─── メインコンポーネント ─────────────────────────────────────────────────

export function PlaybackBar({
  playback,
  playingArticle,
}: {
  playback: UsePlaybackResult;
  playingArticle?: Article | null;
}) {
  const {
    state, speedScale, volume,
    segmentIndex, segmentCount,
    elapsedSeconds, totalDurationInfo,
    summaryMode, setSummaryMode,
    start, pause, resume, skip,
    seekForward, seekBackward, jumpToSegment,
    setSpeedScale, setVolume,
  } = playback;

  const prevVolumeRef = useRef(1.0);

  function handleMuteToggle() {
    if (volume === 0) {
      setVolume(prevVolumeRef.current || 1.0);
    } else {
      prevVolumeRef.current = volume;
      setVolume(0);
    }
  }

  const isIdle = state.phase === "idle";
  const isPlaying = state.phase === "playing";
  const isPaused = state.phase === "paused";
  const isSynthesizing = state.phase === "synthesizing";
  const isError = state.phase === "error";
  const isSeekable = isPlaying || isPaused;

  const articleTitle = playingArticle
    ? (playingArticle.title ?? playingArticle.url)
    : null;

  // キーボードショートカット用 ref（stale closure 回避）
  const ctrlRef = useRef({
    volume, setVolume, prevVolume: 1.0,
    speedScale, setSpeedScale,
    seekForward, seekBackward, jumpToSegment,
    segmentIndex, segmentCount,
    isIdle, isPlaying, isPaused, isSynthesizing,
    start, pause, resume,
  });
  ctrlRef.current.volume = volume;
  ctrlRef.current.setVolume = setVolume;
  ctrlRef.current.speedScale = speedScale;
  ctrlRef.current.setSpeedScale = setSpeedScale;
  ctrlRef.current.seekForward = seekForward;
  ctrlRef.current.seekBackward = seekBackward;
  ctrlRef.current.jumpToSegment = jumpToSegment;
  ctrlRef.current.segmentIndex = segmentIndex;
  ctrlRef.current.segmentCount = segmentCount;
  ctrlRef.current.isIdle = isIdle;
  ctrlRef.current.isPlaying = isPlaying;
  ctrlRef.current.isPaused = isPaused;
  ctrlRef.current.isSynthesizing = isSynthesizing;
  ctrlRef.current.start = start;
  ctrlRef.current.pause = pause;
  ctrlRef.current.resume = resume;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isInputFocused(e.target)) return;

      const c = ctrlRef.current;
      const kb = getCurrentKeybindings();

      // ── 再生制御 ──────────────────────────────────────────────────────
      if (matchesBinding(e, kb.playPause)) {
        e.preventDefault();
        if (c.isPlaying) c.pause();
        else if (c.isPaused) c.resume();
        else if (c.isSynthesizing) c.pause();
        else if (c.isIdle) c.start();
        return;
      }

      // ── シーク ────────────────────────────────────────────────────────
      if (matchesBinding(e, kb.seekForward)) {
        e.preventDefault();
        c.seekForward(10);
        return;
      }
      if (matchesBinding(e, kb.seekBackward)) {
        e.preventDefault();
        c.seekBackward(10);
        return;
      }

      // ── 文単位ナビゲーション ──────────────────────────────────────────
      if (matchesBinding(e, kb.prevSentence)) {
        const idx = c.segmentIndex;
        if (idx !== null && idx > 0) c.jumpToSegment(idx - 1, 0);
        return;
      }
      if (matchesBinding(e, kb.nextSentence)) {
        const idx = c.segmentIndex;
        const count = c.segmentCount;
        if (idx !== null && count > 0 && idx < count - 1) c.jumpToSegment(idx + 1, 0);
        else c.seekForward(Infinity);
        return;
      }

      // ── 音量 ─────────────────────────────────────────────────────────
      if (matchesBinding(e, kb.volumeUp)) {
        e.preventDefault();
        c.setVolume(Math.min(1, Math.round((c.volume + 0.1) * 10) / 10));
        return;
      }
      if (matchesBinding(e, kb.volumeDown)) {
        e.preventDefault();
        c.setVolume(Math.max(0, Math.round((c.volume - 0.1) * 10) / 10));
        return;
      }
      if (matchesBinding(e, kb.mute)) {
        if (c.volume === 0) {
          c.setVolume(ctrlRef.current.prevVolume || 1.0);
        } else {
          ctrlRef.current.prevVolume = c.volume;
          c.setVolume(0);
        }
        return;
      }

      // ── 速度 ─────────────────────────────────────────────────────────
      if (matchesBinding(e, kb.speedDown)) {
        const idx = SPEED_OPTIONS.indexOf(c.speedScale);
        if (idx > 0) c.setSpeedScale(SPEED_OPTIONS[idx - 1]);
        return;
      }
      if (matchesBinding(e, kb.speedUp)) {
        const idx = SPEED_OPTIONS.indexOf(c.speedScale);
        if (idx < SPEED_OPTIONS.length - 1) c.setSpeedScale(SPEED_OPTIONS[idx + 1]);
        return;
      }

      // ── 記事内パーセントジャンプ (0〜9, 固定) ────────────────────────
      if (e.key.length === 1 && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        const digit = parseInt(e.key, 10);
        if (!isNaN(digit)) {
          const count = c.segmentCount;
          if (count === 0) return;
          const targetIdx = Math.min(count - 1, Math.floor((digit / 10) * count));
          c.jumpToSegment(targetIdx, 0);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 再生/一時停止/再開/合成中の中断を1つのトグルに統合する
  // （一般的なメディアプレイヤーと同じく「今押せる操作」を中央の1ボタンで表現）
  function handlePlayToggle() {
    if (isPlaying) pause();
    else if (isPaused) resume();
    else if (isSynthesizing) pause();
    else start();
  }
  // メインボタンが ⏸（一時停止アイコン）を表示すべき状態か
  const mainShowsPause = isPlaying || isSynthesizing;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        background: "var(--surface)",
        borderTop: "1px solid var(--border)",
        zIndex: 100,
      }}
    >
      {/* プログレスバー */}
      <ProgressBar
        segmentIndex={segmentIndex}
        segmentCount={segmentCount}
        onSeek={jumpToSegment}
      />

      {/* コントロール行 */}
      <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 12 }}>

        {/* 再生情報 */}
        <div style={{ flex: 1, overflow: "hidden", minWidth: 0 }}>
          {isIdle && (
            <span style={{ color: "var(--text-muted)" }}>
              停止中
              {playback.synthProgress && (
                <span style={{ color: "var(--warning)", marginLeft: 8, fontSize: 12 }}>
                  (合成中 {playback.synthProgress.done}/{playback.synthProgress.total}文)
                </span>
              )}
            </span>
          )}
          {isSynthesizing && (
            <span style={{ color: "var(--warning)", display: "flex", alignItems: "center", gap: 6 }}>
              <span>
                合成中{playback.synthProgress
                  ? ` ${playback.synthProgress.done}/${playback.synthProgress.total}文`
                  : ""}…
              </span>
              {totalDurationInfo && totalDurationInfo.seconds > 0 && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  全体 {formatTime(totalDurationInfo.seconds)}～
                </span>
              )}
            </span>
          )}
          {(isPlaying || isPaused) && (
            <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ flexShrink: 0, display: "inline-flex" }}>
                {isPaused
                  ? <Pause size={14} fill="currentColor" strokeWidth={0} />
                  : <Play size={14} fill="currentColor" strokeWidth={0} />}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {articleTitle ?? "読み込み中…"}
              </span>
              {segmentCount > 0 && segmentIndex !== null && (
                <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
                  {segmentIndex + 1}/{segmentCount}文
                </span>
              )}
              {playback.synthProgress && playback.synthProgress.done < playback.synthProgress.total && (
                <span style={{ fontWeight: 400, fontSize: 12, color: "var(--warning)", flexShrink: 0 }}>
                  (合成 {playback.synthProgress.done}/{playback.synthProgress.total}文)
                </span>
              )}
              <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
                {formatTime(elapsedSeconds)}
                {totalDurationInfo && (
                  <> / {formatTime(totalDurationInfo.seconds)}{!totalDurationInfo.isComplete && "～"}</>
                )}
              </span>
            </span>
          )}
          {isError && (
            <span style={{ color: "var(--danger)" }}>
              エラー: {state.error.kind === "unreachable"
                ? `Voicevox ポート ${state.error.port} に接続できません`
                : `合成失敗 (HTTP ${state.error.statusCode}): ${state.error.detail}`}
            </span>
          )}
        </div>

        {/* ⏪10s / ⏮前の文 / [▶⏸ メイン] / 次の文⏭ / 10s⏩ │ ⏭記事スキップ
            ── ながら聞きの主役。下部バー中央に寄せて操作の主従を明確にする ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {/* 10秒戻る */}
          <ShortcutBtn
            onClick={() => seekBackward(10)}
            disabled={!isSeekable}
            hint="← / J"
            aria-label="10秒戻る"
            title="10秒戻る"
            className="transport-btn"
          >
            <Rewind size={18} />
          </ShortcutBtn>

          {/* 前の文へ */}
          <ShortcutBtn
            onClick={() => segmentIndex !== null && segmentIndex > 0 && jumpToSegment(segmentIndex - 1)}
            disabled={!isSeekable || segmentIndex === null || segmentIndex === 0}
            hint="["
            aria-label="前の文へ"
            title="前の文へ"
            className="transport-btn"
          >
            <SkipBack size={18} />
          </ShortcutBtn>

          {/* メイン: 再生 / 一時停止（状態に応じて1ボタンがトグル） */}
          <span className="btn-with-hint" style={{ margin: "0 4px" }}>
            <button
              onClick={handlePlayToggle}
              disabled={isError}
              aria-label={mainShowsPause ? "一時停止" : "再生"}
              title={mainShowsPause ? "一時停止" : (isPaused ? "再開" : "再生")}
              className="transport-main"
            >
              {mainShowsPause
                ? <Pause size={22} fill="currentColor" strokeWidth={0} />
                : <Play size={22} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />}
            </button>
            <span className="kbd-hint" aria-hidden>Space / K</span>
          </span>

          {/* 次の文へ */}
          <ShortcutBtn
            onClick={() => {
              if (segmentIndex !== null && segmentCount > 0 && segmentIndex < segmentCount - 1) {
                jumpToSegment(segmentIndex + 1);
              } else {
                seekForward(Infinity);
              }
            }}
            disabled={!isSeekable}
            hint="]"
            aria-label="次の文へ"
            title="次の文へ"
            className="transport-btn"
          >
            <SkipForward size={18} />
          </ShortcutBtn>

          {/* 10秒進む */}
          <ShortcutBtn
            onClick={() => seekForward(10)}
            disabled={!isSeekable}
            hint="→ / L"
            aria-label="10秒進む"
            title="10秒進む"
            className="transport-btn"
          >
            <FastForward size={18} />
          </ShortcutBtn>

          {/* 区切り（文ナビ／記事ナビの境界） */}
          <span style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />

          {/* 記事スキップ（次の記事へ）— 文移動の ⏭ と区別するためラベル付きチップ */}
          <button
            onClick={skip}
            disabled={isIdle}
            aria-label="次の記事へ"
            title="現在の記事を終了して次の記事へ"
            className="transport-chip"
          >
            次の記事 <StepForward size={13} style={{ verticalAlign: "middle" }} />
          </button>
        </div>

        {/* 右ゾーン: 副次操作（要点 / 速度 / 音量）。トランスポートを中央に保つため
            左の再生情報と同じ flex:1 で対称に配置する */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12 }}>
          {/* 要点モード（重要文のみ読み上げ） */}
          <button
            onClick={() => setSummaryMode(!summaryMode)}
            title={summaryMode
              ? "要点モード ON: TF-IDF で抽出した重要文だけを読み上げます（クリックで解除）"
              : "要点モード: TF-IDF で抽出した重要文だけを読み上げます"}
            style={{
              fontSize: 12, padding: "3px 10px", borderRadius: 4,
              border: `1px solid ${summaryMode ? "var(--accent)" : "var(--border)"}`,
              background: summaryMode ? "var(--accent)" : "none",
              color: summaryMode ? "#fff" : "var(--text)",
              cursor: "pointer", boxShadow: "none", whiteSpace: "nowrap",
              fontWeight: summaryMode ? 600 : 400,
            }}
          >
            要点{summaryMode ? " ON" : ""}
          </button>

          {/* 速度 (, で減速 / . で加速) */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>速度:</span>
            <select
              value={speedScale}
              onChange={(e) => setSpeedScale(Number(e.target.value))}
              title="再生速度 (, で減速 / . で加速)"
              style={{ padding: "2px 4px", fontSize: 13 }}
            >
              {SPEED_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}x</option>
              ))}
            </select>
          </div>

          {/* 音量 (↑↓ で±10% / M でミュート) */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ShortcutBtn
              onClick={handleMuteToggle}
              hint="M"
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: "0 2px", lineHeight: 1, boxShadow: "none" }}
            >
              <SpeakerIcon v={volume} size={16} />
            </ShortcutBtn>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              title={`音量: ${Math.round(volume * 100)}% (↑↓ で調整)`}
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 28, textAlign: "right" }}>
              {Math.round(volume * 100)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

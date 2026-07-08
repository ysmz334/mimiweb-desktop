import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { downloadEngine, retryVoicevoxConnection, downloadPiper } from "@/lib/tauriCommands";

type Phase =
  | "idle"
  | "downloading"
  | "extracting"
  | "starting"
  | "piper-downloading"
  | "piper-extracting"
  | "piper-failed"
  | "done"
  | "error";

interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export function EngineSetupScreen({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0, total: null });
  const [piperProgress, setPiperProgress] = useState<DownloadProgress>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);
  // VOICEVOX は必須（外すと開始不可）、Piper は任意（外すと従来通り VOICEVOX のみ）
  const [voicevoxChecked, setVoicevoxChecked] = useState(true);
  const [piperChecked, setPiperChecked] = useState(true);

  useEffect(() => {
    const unlistens: Array<() => void> = [];

    listen<DownloadProgress>("engine-setup:progress", (e) => {
      setPhase("downloading");
      setProgress(e.payload);
    }).then((fn) => { unlistens.push(fn); });

    listen("engine-setup:extracting", () => {
      setPhase("extracting");
    }).then((fn) => { unlistens.push(fn); });

    // Piper の進捗も既存イベントで表示する
    listen<DownloadProgress>("piper-setup:progress", (e) => {
      setPhase("piper-downloading");
      setPiperProgress(e.payload);
    }).then((fn) => { unlistens.push(fn); });

    listen("piper-setup:extracting", () => {
      setPhase("piper-extracting");
    }).then((fn) => { unlistens.push(fn); });

    return () => { unlistens.forEach((fn) => fn()); };
  }, []);

  async function handleDownload() {
    setError(null);
    setPhase("downloading");
    try {
      await downloadEngine();
      setPhase("starting");
      await retryVoicevoxConnection();
    } catch (e) {
      // VOICEVOX の失敗は致命（読み上げに必須）→ エラー表示と再試行
      setPhase("error");
      setError(String(e));
      return;
    }

    if (piperChecked) {
      setPhase("piper-downloading");
      try {
        await downloadPiper();
      } catch {
        // Piper の失敗は警告に留め、アプリの利用開始を妨げない（後から設定タブで導入可能）
        setPhase("piper-failed");
        return;
      }
    }

    setPhase("done");
    onDone();
  }

  const isPiperPhase = phase === "piper-downloading" || phase === "piper-extracting";
  const activeProgress = isPiperPhase ? piperProgress : progress;
  const percent =
    activeProgress.total != null && activeProgress.total > 0
      ? Math.round((activeProgress.downloaded / activeProgress.total) * 100)
      : null;

  const isActive =
    phase === "downloading" || phase === "extracting" || phase === "starting" || isPiperPhase;
  const isDownloadingPhase = phase === "downloading" || phase === "piper-downloading";

  const checkboxRowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    padding: "6px 0",
    cursor: "pointer",
  };

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "var(--bg)",
      color: "var(--text)",
      padding: "32px",
      boxSizing: "border-box",
    }}>
      <div style={{
        maxWidth: 520,
        width: "100%",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "36px 40px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
      }}>
        {/* タイトル */}
        <h2 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 700 }}>
          音声エンジンのセットアップ
        </h2>
        <p style={{ margin: "0 0 24px", color: "var(--text-muted)", fontSize: 14, lineHeight: 1.6 }}>
          mimiweb の読み上げ機能には音声エンジンが必要です。
          <br />
          GitHub Releases から自動でダウンロード・展開します。
        </p>

        {/* ライセンス情報 */}
        <div style={{
          background: "var(--surface-alt)",
          border: "1px solid var(--border-light)",
          borderRadius: 8,
          padding: "12px 16px",
          marginBottom: 24,
          fontSize: 13,
          color: "var(--text-muted)",
          lineHeight: 1.6,
        }}>
          VOICEVOX エンジンは{" "}
          <strong style={{ color: "var(--text)" }}>LGPL v3</strong>{" "}
          ライセンスのオープンソースソフトウェアです。
          <br />
          音声合成の利用には別途{" "}
          <a
            href="https://voicevox.hiroshiba.jp/term/"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)" }}
          >
            VOICEVOX 利用規約
          </a>{" "}
          への同意が必要です。
        </div>

        {/* アイドル時: エンジン選択とダウンロードボタン */}
        {phase === "idle" && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <label style={checkboxRowStyle}>
                <input
                  type="checkbox"
                  checked={voicevoxChecked}
                  onChange={(e) => setVoicevoxChecked(e.target.checked)}
                />
                <span>
                  <strong>VOICEVOX</strong>
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                    {" "}— 日本語音声（必須 / 約 1.7 GB）
                  </span>
                </span>
              </label>
              <label style={checkboxRowStyle}>
                <input
                  type="checkbox"
                  checked={piperChecked}
                  onChange={(e) => setPiperChecked(e.target.checked)}
                />
                <span>
                  <strong>Piper TTS</strong>
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                    {" "}— 英語音声（任意 / 約 100 MB。後から設定タブでも導入できます）
                  </span>
                </span>
              </label>
              {!voicevoxChecked && (
                <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--danger, #dc2626)" }}>
                  VOICEVOX は読み上げに必須のため、チェックを外した状態では開始できません
                </p>
              )}
            </div>
            <button
              onClick={handleDownload}
              disabled={!voicevoxChecked}
              style={{
                width: "100%",
                padding: "12px",
                background: voicevoxChecked ? "var(--accent)" : "var(--border)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 600,
                cursor: voicevoxChecked ? "pointer" : "not-allowed",
              }}
            >
              ダウンロードして使用を開始する
            </button>
          </div>
        )}

        {/* ダウンロード進捗 */}
        {isActive && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: "var(--text-muted)" }}>
                {phase === "downloading" && "VOICEVOX をダウンロード中..."}
                {phase === "extracting" && "VOICEVOX を展開中..."}
                {phase === "starting"   && "エンジンを起動中..."}
                {phase === "piper-downloading" && "Piper TTS をダウンロード中..."}
                {phase === "piper-extracting" && "Piper TTS を展開中..."}
              </span>
              {isDownloadingPhase && (
                <span style={{ color: "var(--text-muted)" }}>
                  {formatBytes(activeProgress.downloaded)}
                  {activeProgress.total != null && ` / ${formatBytes(activeProgress.total)}`}
                  {percent != null && `  (${percent}%)`}
                </span>
              )}
            </div>

            {/* プログレスバー */}
            <div style={{
              height: 8,
              borderRadius: 4,
              background: "var(--progress-track)",
              overflow: "hidden",
            }}>
              <div style={{
                height: "100%",
                borderRadius: 4,
                background: "var(--accent)",
                width: isDownloadingPhase && percent != null
                  ? `${percent}%`
                  : !isDownloadingPhase
                    ? "100%"
                    : "0%",
                transition: "width 0.3s ease",
                opacity: !isDownloadingPhase ? 0.6 : 1,
                animation: !isDownloadingPhase
                  ? "pulse 1.5s ease-in-out infinite"
                  : "none",
              }} />
            </div>

            {phase === "extracting" && (
              <p style={{ marginTop: 12, fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>
                展開には数分かかる場合があります
              </p>
            )}
          </div>
        )}

        {/* Piper 失敗: 警告に留めてアプリの利用開始を妨げない */}
        {phase === "piper-failed" && (
          <div>
            <div style={{
              background: "rgba(251,146,60,0.12)",
              border: "1px solid rgba(251,146,60,0.4)",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 16,
              fontSize: 13,
              color: "var(--warning, #b45309)",
              lineHeight: 1.6,
            }}>
              Piper TTS の導入に失敗しました。英語の読み上げは日本語音声で代読されます。
              <br />
              後から設定タブでいつでも導入できます。
            </div>
            <button
              onClick={onDone}
              style={{
                width: "100%",
                padding: "12px",
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              このまま開始する
            </button>
          </div>
        )}

        {/* エラー表示（VOICEVOX 失敗は致命 → 再試行） */}
        {phase === "error" && (
          <div>
            <div style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 16,
              fontSize: 13,
              color: "#dc2626",
              wordBreak: "break-all",
            }}>
              {error}
            </div>
            <button
              onClick={handleDownload}
              style={{
                width: "100%",
                padding: "12px",
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              再試行
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50%       { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

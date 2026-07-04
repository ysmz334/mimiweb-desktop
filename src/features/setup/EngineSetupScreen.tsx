import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { downloadEngine, retryVoicevoxConnection } from "@/lib/tauriCommands";

type Phase =
  | "idle"
  | "downloading"
  | "extracting"
  | "starting"
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenExtracting: (() => void) | null = null;

    listen<DownloadProgress>("engine-setup:progress", (e) => {
      setPhase("downloading");
      setProgress(e.payload);
    }).then((fn) => { unlistenProgress = fn; });

    listen("engine-setup:extracting", () => {
      setPhase("extracting");
    }).then((fn) => { unlistenExtracting = fn; });

    return () => {
      unlistenProgress?.();
      unlistenExtracting?.();
    };
  }, []);

  async function handleDownload() {
    setPhase("downloading");
    setError(null);
    try {
      await downloadEngine();
      setPhase("starting");
      await retryVoicevoxConnection();
      setPhase("done");
      onDone();
    } catch (e) {
      setPhase("error");
      setError(String(e));
    }
  }

  const percent =
    progress.total != null && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  const isActive = phase === "downloading" || phase === "extracting" || phase === "starting";

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
          VOICEVOXエンジンのセットアップ
        </h2>
        <p style={{ margin: "0 0 24px", color: "var(--text-muted)", fontSize: 14, lineHeight: 1.6 }}>
          mimiweb の読み上げ機能には VOICEVOX エンジンが必要です。
          <br />
          GitHub Releases から自動でダウンロード・展開します（約 1.7 GB）。
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

        {/* アイドル時: ダウンロードボタン */}
        {phase === "idle" && (
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
            ダウンロードして使用を開始する
          </button>
        )}

        {/* ダウンロード進捗 */}
        {isActive && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: "var(--text-muted)" }}>
                {phase === "downloading" && "ダウンロード中..."}
                {phase === "extracting" && "展開中..."}
                {phase === "starting"   && "エンジンを起動中..."}
              </span>
              {phase === "downloading" && (
                <span style={{ color: "var(--text-muted)" }}>
                  {formatBytes(progress.downloaded)}
                  {progress.total != null && ` / ${formatBytes(progress.total)}`}
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
                width: phase === "downloading" && percent != null
                  ? `${percent}%`
                  : phase === "extracting" || phase === "starting"
                    ? "100%"
                    : "0%",
                transition: "width 0.3s ease",
                opacity: phase === "extracting" || phase === "starting" ? 0.6 : 1,
                animation: (phase === "extracting" || phase === "starting")
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

        {/* エラー表示 */}
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

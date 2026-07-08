import { useState, useEffect } from "react";
import { useSettings } from "./useSettings";
import {
  deleteAllHistory,
  openLoginWindow,
  checkPiperInstalled,
  downloadPiper,
  onPiperSetupProgress,
} from "@/lib/tauriCommands";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { clearAllAudio, CACHE_UPDATED_EVENT } from "@/lib/audioCache";
import { KeybindingsSection } from "./KeybindingsSection";
import type { VoicevoxStatus } from "@/shared/types";

function statusLabel(s: VoicevoxStatus): { text: string; color: string } {
  switch (s.state) {
    case "starting":    return { text: "起動中…",     color: "var(--warning)" };
    case "ready":       return { text: `接続済み (ポート ${s.port})`, color: "var(--success)" };
    case "restarting":  return { text: `再起動中 (${s.attempt}回目)`, color: "var(--warning)" };
    case "failed":      return { text: `障害: ${s.reason}`, color: "var(--danger)" };
  }
}

type ConfirmTarget = "history" | "cache" | null;

// ─── ログインサイト管理 ──────────────────────────────────────────────────────

function LoginSiteSection() {
  const [loginUrl, setLoginUrl] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOpen() {
    const url = loginUrl.trim();
    if (!url) return;
    setError(null);
    setOpening(true);
    try {
      await openLoginWindow(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  }

  return (
    <fieldset style={{ marginBottom: 16 }}>
      <legend>ログインサイト</legend>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0 10px" }}>
        ログインが必要なサイトの記事を登録するには、先にブラウザウィンドウでログインしてください。
        ログイン情報は次回以降も保持されます。
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="url"
          placeholder="https://example.com/login"
          value={loginUrl}
          onChange={(e) => { setLoginUrl(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && handleOpen()}
          style={{ flex: 1, padding: "4px 8px" }}
          disabled={opening}
        />
        <button
          onClick={handleOpen}
          disabled={opening || !loginUrl.trim()}
          style={{ fontSize: 13, padding: "4px 12px", whiteSpace: "nowrap" }}
        >
          {opening ? "開いています…" : "ログイン画面を開く"}
        </button>
      </div>
      {error && (
        <p style={{ fontSize: 13, color: "var(--danger)", margin: "6px 0 0" }}>{error}</p>
      )}
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0 0" }}>
        ウィンドウでログイン後、そのままウィンドウを閉じてください。以後はURLを登録するだけで記事を取得できます。
      </p>
    </fieldset>
  );
}

// ─── Piper TTS セクション ────────────────────────────────────────────────────

type PiperPhase = "checking" | "not_installed" | "downloading" | "extracting" | "installed" | "error";

export function PiperTtsSection({ onPiperInstalled }: { onPiperInstalled?: () => void } = {}) {
  const [phase, setPhase] = useState<PiperPhase>("checking");
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkPiperInstalled().then((installed) => {
      setPhase(installed ? "installed" : "not_installed");
    });

    let unlistenProgress: (() => void) | null = null;
    let unlistenExtracting: (() => void) | null = null;

    onPiperSetupProgress((payload) => {
      setPhase("downloading");
      setProgress(payload);
    }).then((fn) => { unlistenProgress = fn; });

    listen("piper-setup:extracting", () => {
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
      await downloadPiper();
      setPhase("installed");
      // App の piperInstalled 状態を再取得させる（バッジ・ルーティングが一斉に追従する）
      onPiperInstalled?.();
    } catch (e) {
      setPhase("error");
      setError(String(e));
    }
  }

  const progressPct = progress.total
    ? Math.round((progress.downloaded / progress.total) * 100)
    : null;

  return (
    <fieldset style={{ marginBottom: 16 }}>
      <legend>英語 TTS (Piper)</legend>

      {phase === "checking" && (
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0" }}>確認中…</p>
      )}

      {phase === "not_installed" && (
        <div style={{ padding: "8px 0" }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 10px" }}>
            英語記事の読み上げには Piper TTS エンジンが必要です（約 100 MB）。
          </p>
          <button onClick={handleDownload} style={{ fontSize: 13, padding: "4px 12px" }}>
            ダウンロード
          </button>
        </div>
      )}

      {phase === "downloading" && (
        <div style={{ padding: "8px 0" }}>
          <p style={{ fontSize: 13, margin: "0 0 6px" }}>ダウンロード中…</p>
          <div style={{ background: "var(--progress-track)", borderRadius: 4, height: 8, width: "100%" }}>
            <div style={{
              background: "var(--success)",
              height: 8,
              borderRadius: 4,
              width: progressPct !== null ? `${progressPct}%` : "30%",
              transition: "width 0.3s",
            }} />
          </div>
          {progressPct !== null && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}>
              {progressPct}%
            </p>
          )}
        </div>
      )}

      {phase === "extracting" && (
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0" }}>展開中…</p>
      )}

      {phase === "installed" && (
        <p style={{ fontSize: 13, color: "var(--success)", margin: "8px 0" }}>
          ✓ インストール済み (en_US-ryan-high)
        </p>
      )}

      {phase === "error" && (
        <div style={{ padding: "8px 0" }}>
          <p style={{ fontSize: 13, color: "var(--danger)", margin: "0 0 8px" }}>
            エラー: {error}
          </p>
          <button onClick={handleDownload} style={{ fontSize: 13, padding: "4px 12px" }}>
            再試行
          </button>
        </div>
      )}
    </fieldset>
  );
}

// ─── ライセンス・帰属表示 ─────────────────────────────────────────────────────

type LicenseEntry = {
  name: string;
  license: string;
  url: string;
  note?: string;
};

const LICENSES: LicenseEntry[] = [
  { name: "Piper TTS", license: "MIT License © Rhasspy contributors", url: "https://github.com/rhasspy/piper" },
  { name: "en_US-ryan-high voice", license: "CC BY 4.0 © Rhasspy contributors", url: "https://huggingface.co/rhasspy/piper-voices" },
  { name: "VOICEVOX", license: "MIT License © Hiroshiba Kazuyuki", url: "https://voicevox.hiroshiba.jp/", note: "各キャラクターの音声ライブラリには個別の利用規約があります。使用前にご確認ください。" },
  { name: "@mozilla/readability", license: "Apache License 2.0 © Mozilla Foundation", url: "https://github.com/mozilla/readability" },
  { name: "lamejs", license: "LGPL 3.0 © zhuker", url: "https://github.com/zhuker/lamejs" },
  { name: "Tauri", license: "MIT / Apache 2.0 © Tauri Programme", url: "https://tauri.app/" },
  { name: "lindera", license: "MIT / Apache 2.0", url: "https://github.com/lindera/lindera" },
  { name: "rust-stemmers", license: "MIT / Apache 2.0", url: "https://github.com/CurrySoftware/rust-stemmers" },
  { name: "d3-cloud", license: "MIT © Jason Davies", url: "https://github.com/jasondavies/d3-cloud" },
  { name: "React", license: "MIT © Meta Platforms, Inc.", url: "https://react.dev/" },
];

function LicensesSection() {
  const [open, setOpen] = useState(false);

  return (
    <fieldset style={{ marginBottom: 16 }}>
      <legend
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} ライセンス・帰属表示
      </legend>
      {open && (
        <div style={{ padding: "4px 0 2px" }}>
          {LICENSES.map((entry) => (
            <div key={entry.name} style={{ marginBottom: 10, fontSize: 12, lineHeight: 1.6 }}>
              <div>
                <strong>{entry.name}</strong>
                {" — "}
                <span style={{ color: "var(--text-muted)" }}>{entry.license}</span>
              </div>
              <div>
                <span
                  style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}
                  onClick={() => openUrl(entry.url).catch(() => {})}
                >
                  {entry.url}
                </span>
              </div>
              {entry.note && (
                <div style={{ color: "var(--warning)", fontSize: 11, marginTop: 2 }}>{entry.note}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

// ─── 設定カテゴリ（折りたたみ） ──────────────────────────────────────────────

function SettingsCategory({
  icon, title, defaultOpen = false, children,
}: {
  icon: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "10px 14px", background: "var(--surface)", border: "none",
          borderRadius: 0, cursor: "pointer", textAlign: "left",
          boxShadow: "none", color: "var(--text)", fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: 15, flexShrink: 0 }}>{icon}</span>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{title}</span>
      </button>
      {open && <div style={{ padding: "8px 14px 6px" }}>{children}</div>}
    </section>
  );
}

// ─── バージョン情報 ──────────────────────────────────────────────────────────

function VersionInfo() {
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  return (
    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 12px" }}>
      mimiweb-desktop{version ? ` バージョン ${version}` : ""}
    </p>
  );
}

const BITRATE_OPTIONS = [64, 96, 128, 192, 256, 320];

export function SettingsPanel({
  clipboardEnabled,
  onToggleClipboard,
  onMp3BitrateChange,
  onPiperInstalled,
}: {
  clipboardEnabled: boolean;
  onToggleClipboard: () => void;
  onMp3BitrateChange?: (bitrate: number) => void;
  /** Piper インストール成功時に App が piperInstalled 状態を再取得するためのコールバック */
  onPiperInstalled?: () => void;
}) {
  const { settings, voicevoxStatus, speakers, saving, update, retryConnection } = useSettings();
  const sv = statusLabel(voicevoxStatus);

  const [confirming, setConfirming] = useState<ConfirmTarget>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDeleteHistory() {
    setDeleting(true);
    try {
      await deleteAllHistory();
    } finally {
      setDeleting(false);
      setConfirming(null);
    }
  }

  async function handleClearCache() {
    setDeleting(true);
    try {
      await clearAllAudio();
      window.dispatchEvent(new CustomEvent(CACHE_UPDATED_EVENT));
    } finally {
      setDeleting(false);
      setConfirming(null);
    }
  }

  if (!settings) return <p>読み込み中…</p>;

  return (
    <section>
      <h2 style={{ margin: "0 0 16px" }}>設定</h2>

      {/* ── 🔊 読み上げ ── */}
      <SettingsCategory icon="🔊" title="読み上げ" defaultOpen>
        {/* 話者選択 */}
        <fieldset style={{ marginBottom: 16 }}>
          <legend>話者</legend>
          <select
            value={settings.voicevoxSpeakerId}
            onChange={(e) => update({ voicevoxSpeakerId: Number(e.target.value) })}
            disabled={saving || speakers.length === 0}
            style={{ padding: "4px 8px", minWidth: 200 }}
          >
            {speakers.length === 0 ? (
              <option value={settings.voicevoxSpeakerId}>
                現在の話者 ID: {settings.voicevoxSpeakerId}
              </option>
            ) : (
              speakers.flatMap((sp) =>
                sp.styles.map((style) => (
                  <option key={style.id} value={style.id}>
                    {sp.name} - {style.name}
                  </option>
                ))
              )
            )}
          </select>
        </fieldset>

        {/* 音声品質 */}
        <fieldset style={{ marginBottom: 16 }}>
          <legend>音声品質 (MP3 ビットレート)</legend>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <select
              value={settings.mp3Bitrate}
              onChange={(e) => {
                const v = Number(e.target.value);
                update({ mp3Bitrate: v });
                onMp3BitrateChange?.(v);
              }}
              disabled={saving}
              style={{ padding: "4px 8px" }}
            >
              {BITRATE_OPTIONS.map((b) => (
                <option key={b} value={b}>{b} kbps</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              低いほどファイルサイズが小さく、高いほど音質が良くなります。変更は次回の合成から反映されます。
            </span>
          </div>
        </fieldset>
      </SettingsCategory>

      {/* ── ⚙️ エンジン ── */}
      <SettingsCategory icon="⚙️" title="エンジン">
        {/* Voicevox ステータス */}
        <fieldset style={{ marginBottom: 16 }}>
          <legend>Voicevox エンジン</legend>
          <p style={{ color: sv.color, fontWeight: 600, margin: "8px 0" }}>{sv.text}</p>
          {voicevoxStatus.state !== "ready" && (
            <button onClick={retryConnection}>接続を再試行</button>
          )}
        </fieldset>

        <PiperTtsSection onPiperInstalled={onPiperInstalled} />
      </SettingsCategory>

      {/* ── 📰 記事の取得 ── */}
      <SettingsCategory icon="📰" title="記事の取得">
        {/* クリップボード監視 */}
        <fieldset style={{ marginBottom: 16 }}>
          <legend>クリップボード監視</legend>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <span style={{ fontSize: 14 }}>{clipboardEnabled ? "有効" : "無効"}</span>
            <button onClick={onToggleClipboard} style={{ fontSize: 13, padding: "4px 12px" }}>
              {clipboardEnabled ? "無効にする" : "有効にする"}
            </button>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              URL をコピーすると自動で記事を登録します
            </span>
          </div>
        </fieldset>

        <LoginSiteSection />
      </SettingsCategory>

      {/* ── ⌨️ 操作 ── */}
      <SettingsCategory icon="⌨️" title="操作">
        <KeybindingsSection />
      </SettingsCategory>

      {/* ── 🗑️ データ管理 ── */}
      <SettingsCategory icon="🗑️" title="データ管理">
        {/* 履歴の一括削除 */}
        <fieldset style={{ marginBottom: 16 }}>
          <legend>履歴</legend>
          <div style={{ padding: "8px 0" }}>
            {confirming === "history" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, color: "var(--danger)" }}>
                  すべての履歴を削除します。この操作は取り消せません。
                </span>
                <button
                  onClick={handleDeleteHistory}
                  disabled={deleting}
                  style={{ fontSize: 13, padding: "4px 12px", color: "#fff", background: "var(--danger)", borderColor: "var(--danger)" }}
                >
                  {deleting ? "削除中…" : "削除する"}
                </button>
                <button
                  onClick={() => setConfirming(null)}
                  disabled={deleting}
                  style={{ fontSize: 13, padding: "4px 12px" }}
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming("history")}
                style={{ fontSize: 13, padding: "4px 12px" }}
              >
                履歴をすべて削除
              </button>
            )}
          </div>
        </fieldset>

        {/* 音声キャッシュの一括削除 */}
        <fieldset style={{ marginBottom: 16 }}>
          <legend>音声キャッシュ</legend>
          <div style={{ padding: "8px 0" }}>
            {confirming === "cache" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, color: "var(--danger)" }}>
                  すべての音声キャッシュを削除します。この操作は取り消せません。
                </span>
                <button
                  onClick={handleClearCache}
                  disabled={deleting}
                  style={{ fontSize: 13, padding: "4px 12px", color: "#fff", background: "var(--danger)", borderColor: "var(--danger)" }}
                >
                  {deleting ? "削除中…" : "削除する"}
                </button>
                <button
                  onClick={() => setConfirming(null)}
                  disabled={deleting}
                  style={{ fontSize: 13, padding: "4px 12px" }}
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming("cache")}
                style={{ fontSize: 13, padding: "4px 12px" }}
              >
                音声キャッシュをすべて削除
              </button>
            )}
          </div>
        </fieldset>
      </SettingsCategory>

      {/* ── ℹ️ アプリ情報 ── */}
      <SettingsCategory icon="ℹ️" title="アプリ情報">
        <VersionInfo />
        <LicensesSection />
      </SettingsCategory>

      {saving && <p style={{ color: "var(--text-muted)" }}>保存中…</p>}
    </section>
  );
}

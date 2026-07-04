import { useState, useEffect, useCallback, useRef } from "react";
import { Moon, Sun, Play, ArrowLeft, ArrowRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onVoicevoxStatusChanged, getSettings, getArticles, registerArticle, addToQueue, getQueue, reorderQueue, checkEngineInstalled, toggleFavorite, checkForUpdate, checkPiperInstalled, onExtractionCompleted, type UpdateInfo } from "@/lib/tauriCommands";
import { wordCloudBus } from "@/shared/wordCloudBus";
import { EngineSetupScreen } from "@/features/setup/EngineSetupScreen";
import { usePlayback } from "@/features/playback/usePlayback";
import { PlaybackBar } from "@/features/playback/PlaybackBar";
import { ArticleListPanel } from "@/features/articles/ArticleListPanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { ArticleViewerPanel } from "@/features/viewer/ArticleViewerPanel";
import { SynthesisPanel } from "@/features/synthesis/SynthesisPanel";
import { QueueSidebar, SIDEBAR_EXPANDED_WIDTH, SIDEBAR_COLLAPSED_WIDTH } from "@/features/queue/QueueSidebar";
import { useClipboardMonitor } from "@/features/clipboard/useClipboardMonitor";
import { getCurrentKeybindings, matchesBinding, BINDING_ORDER, BINDING_LABELS, keyLabel } from "@/lib/keybindings";
import { ARTICLES_CHANGED_EVENT } from "@/features/articles/useArticles";
import { useExtractionListener } from "@/features/articles/useExtractionListener";
import { QUEUE_CHANGED_EVENT } from "@/features/queue/useQueue";
import type { Article, VoicevoxStatus } from "@/shared/types";

type Tab = "articles" | "player" | "synthesis" | "history" | "settings";

// ナビゲーション履歴の1地点（タブ + ビューアで表示中の記事）。
// ブラウザの「戻る/進む」と同じく、ユーザーの回遊をスタックに積む。
interface NavEntry {
  tab: Tab;
  viewArticleId: number | null;   // ビューアで表示する記事 id（null = 再生中記事にフォールバック）
  snapshot: Article | null;       // articles 未ロード時のフォールバック用スナップショット
  gen: number;                    // 同一記事の再表示でもビューアのブラウズ状態をリセットするための世代
}

const NAV_STACK_MAX = 50;

// ─── カスタムコンテキストメニュー（テキストコピーのみ） ─────────────────────

function ContextMenu({
  x,
  y,
  selectedText,
  onClose,
}: {
  x: number;
  y: number;
  selectedText: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hasText = selectedText.length > 0;

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    const timer = setTimeout(() => document.addEventListener("mousedown", handleOutside), 0);
    document.addEventListener("keydown", handleKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const MENU_W = 130;
  const MENU_H = 36;
  const adjX = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 4));
  const adjY = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4));

  function handleCopy() {
    if (hasText) navigator.clipboard.writeText(selectedText).catch(() => {});
    onClose();
  }

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: adjY,
        left: adjX,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        padding: "3px 0",
        zIndex: 10000,
        minWidth: MENU_W,
        userSelect: "none",
      }}
    >
      <button
        onClick={handleCopy}
        style={{
          display: "block",
          width: "100%",
          padding: "6px 14px",
          background: "none",
          border: "none",
          borderRadius: 0,
          cursor: hasText ? "pointer" : "default",
          color: hasText ? "var(--text)" : "var(--text-muted)",
          fontSize: 13,
          textAlign: "left",
          boxShadow: "none",
          fontFamily: "inherit",
          opacity: hasText ? 1 : 0.5,
        }}
        onMouseEnter={(e) => {
          if (hasText) (e.currentTarget as HTMLButtonElement).style.background = "var(--border-light)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "";
        }}
      >
        コピー
      </button>
    </div>
  );
}

// ─── 記事アイテム用コンテキストメニュー ────────────────────────────────────

function ArticleContextMenu({
  x,
  y,
  url,
  onClose,
}: {
  x: number;
  y: number;
  url: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function keydown(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    const t = setTimeout(() => document.addEventListener("mousedown", outside), 0);
    document.addEventListener("keydown", keydown);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", keydown); };
  }, [onClose]);

  const MENU_W = 180;
  const MENU_H = 78;
  const adjX = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 4));
  const adjY = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4));

  const btnStyle: React.CSSProperties = {
    display: "block", width: "100%", padding: "6px 14px",
    background: "none", border: "none", borderRadius: 0,
    cursor: "pointer", color: "var(--text)", fontSize: 13,
    textAlign: "left", boxShadow: "none", fontFamily: "inherit",
  };

  function hover(e: React.MouseEvent<HTMLButtonElement>, on: boolean) {
    (e.currentTarget as HTMLButtonElement).style.background = on ? "var(--border-light)" : "";
  }

  return (
    <div
      ref={ref}
      style={{
        position: "fixed", top: adjY, left: adjX,
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        padding: "3px 0", zIndex: 10000, minWidth: MENU_W, userSelect: "none",
      }}
    >
      <button
        style={btnStyle}
        onMouseEnter={(e) => hover(e, true)}
        onMouseLeave={(e) => hover(e, false)}
        onClick={() => { openUrl(url).catch(() => {}); onClose(); }}
      >
        ブラウザで開く
      </button>
      <button
        style={btnStyle}
        onMouseEnter={(e) => hover(e, true)}
        onMouseLeave={(e) => hover(e, false)}
        onClick={() => { navigator.clipboard.writeText(url).catch(() => {}); onClose(); }}
      >
        URLをコピー
      </button>
    </div>
  );
}

export default function App() {
  // null = チェック中, false = 未インストール, true = インストール済み
  const [engineReady, setEngineReady] = useState<boolean | null>(null);

  useEffect(() => {
    checkEngineInstalled()
      .then(setEngineReady)
      .catch(() => setEngineReady(true)); // チェック失敗時はアプリを起動（dev 等）
  }, []);

  if (engineReady === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)", color: "var(--text-muted)", fontSize: 14 }}>
        起動中...
      </div>
    );
  }

  if (!engineReady) {
    return <EngineSetupScreen onDone={() => setEngineReady(true)} />;
  }

  return <AppMain />;
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const kb = getCurrentKeybindings();
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const kbdStyle: React.CSSProperties = {
    background: "var(--border-light)", borderRadius: 4, padding: "2px 7px",
    fontSize: 12, fontFamily: "monospace", color: "var(--text)",
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 11000, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--surface)", color: "var(--text)", borderRadius: 10, padding: "20px 24px", minWidth: 320, maxWidth: 460, maxHeight: "80vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.3)", border: "1px solid var(--border)" }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>キーボードショートカット</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--text-muted)", boxShadow: "none", padding: "0 4px", lineHeight: 1 }} aria-label="閉じる">×</button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {BINDING_ORDER.map((id) => (
              <tr key={id} style={{ borderBottom: "1px solid var(--border-light)" }}>
                <td style={{ padding: "5px 0" }}>{BINDING_LABELS[id]}</td>
                <td style={{ padding: "5px 0", textAlign: "right" }}>
                  <kbd style={kbdStyle}>{keyLabel(kb[id])}</kbd>
                </td>
              </tr>
            ))}
            <tr style={{ borderBottom: "1px solid var(--border-light)" }}>
              <td style={{ padding: "5px 0" }}>記事内の位置へジャンプ (0〜90%)</td>
              <td style={{ padding: "5px 0", textAlign: "right" }}><kbd style={kbdStyle}>0 – 9</kbd></td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "12px 0 0" }}>
          <kbd style={kbdStyle}>?</kbd> でこの一覧を表示／非表示。割り当ては設定タブの「操作」で変更できます。
        </p>
      </div>
    </div>
  );
}

function UpdateBanner({ info, onDismiss }: { info: UpdateInfo; onDismiss: () => void }) {
  return (
    <div style={{
      background: "var(--accent)",
      color: "#fff",
      fontSize: 13,
      padding: "7px 16px",
      display: "flex",
      alignItems: "center",
      gap: 12,
      flexShrink: 0,
    }}>
      <span style={{ flex: 1 }}>
        新しいバージョン <strong>{info.latestVersion}</strong> が公開されています
      </span>
      <button
        onClick={() => openUrl(info.releaseUrl).catch(() => {})}
        style={{
          fontSize: 12,
          padding: "3px 10px",
          background: "rgba(255,255,255,0.25)",
          border: "1px solid rgba(255,255,255,0.5)",
          borderRadius: 4,
          color: "#fff",
          cursor: "pointer",
          boxShadow: "none",
        }}
      >
        ダウンロードページを開く
      </button>
      <button
        onClick={onDismiss}
        style={{
          fontSize: 16,
          background: "none",
          border: "none",
          color: "rgba(255,255,255,0.8)",
          cursor: "pointer",
          padding: "0 4px",
          lineHeight: 1,
          boxShadow: "none",
        }}
        aria-label="閉じる"
      >
        ×
      </button>
    </div>
  );
}

function AppMain() {
  // ─── ナビゲーション履歴（ブラウザ風の戻る/進む） ───────────────────────────
  // tab / playerViewArticle / 世代を単一の履歴スタックに集約する。
  // 「戻る/進む」は表示位置だけを変え、再生には一切干渉しない。
  const [nav, setNav] = useState<{ stack: NavEntry[]; index: number }>(() => ({
    stack: [{ tab: "articles", viewArticleId: null, snapshot: null, gen: 0 }],
    index: 0,
  }));

  // 新しい地点へ移動する。tab だけ / 記事表示だけ / 両方を更新できる。
  // - viewArticle を渡したとき（記事クリック）は gen を進めてビューアのブラウズ状態をリセット。
  // - 同一地点（同 tab・同記事）への移動はスタックを増やさない（連打・自動遷移の重複抑制）。
  // - replace=true は現在地を置換（自動遷移の打ち消し等、履歴に残したくない更新）。
  const navigateTo = useCallback(
    (next: { tab?: Tab; viewArticle?: Article | null }, opts?: { replace?: boolean }) => {
      setNav((s) => {
        const cur = s.stack[s.index];
        const hasView = "viewArticle" in next;
        const nextTab = next.tab ?? cur.tab;
        const nextViewId = hasView ? (next.viewArticle?.id ?? null) : cur.viewArticleId;
        const nextSnap = hasView ? (next.viewArticle ?? null) : cur.snapshot;
        const viewingArticle = hasView && next.viewArticle != null;
        const gen = viewingArticle ? cur.gen + 1 : cur.gen;
        const entry: NavEntry = { tab: nextTab, viewArticleId: nextViewId, snapshot: nextSnap, gen };

        const sameLocation = entry.tab === cur.tab && entry.viewArticleId === cur.viewArticleId;
        // 同一地点で記事の再表示でもない → 何も変わらないので無視
        if (sameLocation && !viewingArticle) return s;
        // 同一記事を再クリック → スタックは増やさず現在地を置換し gen だけ進める（ブラウズ解除）
        if (sameLocation && viewingArticle) {
          const stack = s.stack.slice();
          stack[s.index] = entry;
          return { stack, index: s.index };
        }
        if (opts?.replace) {
          const stack = s.stack.slice(0, s.index + 1);
          stack[s.index] = entry;
          return { stack, index: s.index };
        }
        // 前方履歴を切り捨てて push
        const stack = s.stack.slice(0, s.index + 1);
        stack.push(entry);
        if (stack.length > NAV_STACK_MAX) {
          stack.shift();
          return { stack, index: stack.length - 1 };
        }
        return { stack, index: stack.length - 1 };
      });
    },
    [],
  );

  const goBack = useCallback(() => {
    setNav((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s));
  }, []);
  const goForward = useCallback(() => {
    setNav((s) => (s.index < s.stack.length - 1 ? { ...s, index: s.index + 1 } : s));
  }, []);

  // tab を従来どおりの API で更新するためのシム（履歴に積む）
  const setTab = useCallback((t: Tab) => navigateTo({ tab: t }), [navigateTo]);

  const [voicevoxStatus, setVoicevoxStatus] = useState<VoicevoxStatus>({ state: "starting" });
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showPiperPrompt, setShowPiperPrompt] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // ? キーでショートカット一覧オーバーレイを表示／非表示する
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "?") { e.preventDefault(); setShowShortcuts((v) => !v); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ブラウザ風の戻る/進む: マウスサイドボタン(X1/X2) と キーボード(既定 Alt+←/→)
  // 表示位置だけを移動し、再生には干渉しない
  useEffect(() => {
    function onMouseUp(e: MouseEvent) {
      // 3 = 戻る(X1), 4 = 進む(X2)。WebView2 環境で発火するかは実機依存のため keyboard を確実な軸とする
      if (e.button === 3) { e.preventDefault(); goBack(); }
      else if (e.button === 4) { e.preventDefault(); goForward(); }
    }
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const kb = getCurrentKeybindings();
      if (matchesBinding(e, kb.navBack)) { e.preventDefault(); goBack(); }
      else if (matchesBinding(e, kb.navForward)) { e.preventDefault(); goForward(); }
    }
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [goBack, goForward]);

  // 記事抽出イベントをアプリ全体（常時）で受信する
  useExtractionListener();

  // 英語記事の抽出が完了したとき、Piper TTS 未インストールなら誘導バナーを表示する
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onExtractionCompleted((article) => {
      if (article.language !== "en") return;
      checkPiperInstalled().then((installed) => {
        if (!installed) setShowPiperPrompt(true);
      }).catch(() => {});
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);
  const [port, setPort] = useState(50021);
  const [speakerId, setSpeakerId] = useState(3);
  const [speedScale, setSpeedScale] = useState(1.0);
  const [mp3Bitrate, setMp3Bitrate] = useState(128);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;

  // テーマ (localStorage から初期値を取得、なければシステム設定を参照)
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("mimiweb.theme") as "light" | "dark" | null;
    if (saved) return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  // クリップボード監視
  const [clipboardEnabled, setClipboardEnabled] = useState<boolean>(() =>
    localStorage.getItem("mimiweb.clipboardMonitor") !== "false"
  );

  function toggleClipboard() {
    setClipboardEnabled((v) => {
      const next = !v;
      localStorage.setItem("mimiweb.clipboardMonitor", String(next));
      return next;
    });
  }

  // カスタムコンテキストメニュー
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [articleCtxMenu, setArticleCtxMenu] = useState<{ x: number; y: number; url: string } | null>(null);
  // 記事アイテムの右クリック時に document ハンドラをスキップするフラグ
  const articleCtxMenuFiredRef = useRef(false);

  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      e.preventDefault();
      if (articleCtxMenuFiredRef.current) {
        articleCtxMenuFiredRef.current = false;
        return;
      }
      const text = window.getSelection()?.toString().trim() ?? "";
      setCtxMenu({ x: e.clientX, y: e.clientY, text });
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const handleArticleContextMenu = useCallback((url: string, x: number, y: number) => {
    articleCtxMenuFiredRef.current = true;
    setCtxMenu(null);
    setArticleCtxMenu({ x, y, url });
  }, []);

  // プレイヤータブ用: 全記事一覧 (再生中記事を特定するため)
  const [articles, setArticles] = useState<Article[]>([]);

  // 再生キュー件数（起動時の「続きから再生」導線の表示判定に使用）
  const [queueCount, setQueueCount] = useState(0);
  useEffect(() => {
    function refresh() { getQueue().then((q) => setQueueCount(q.length)).catch(() => {}); }
    refresh();
    window.addEventListener(QUEUE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => {
    getArticles().then(setArticles).catch(() => {});
  }, []);

  useEffect(() => {
    function handleChanged() {
      getArticles().then(setArticles).catch(() => {});
    }
    window.addEventListener(ARTICLES_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(ARTICLES_CHANGED_EVENT, handleChanged);
  }, []);

  // ─── ナビゲーション派生値 ───────────────────────────────────────────────
  const navEntry = nav.stack[nav.index];
  const tab = navEntry.tab;
  const playerViewGeneration = navEntry.gen;
  // ビューア表示記事は id から articles を引いて最新データを使う（お気に入り・再取得が自動反映）。
  // articles 未ロード時はナビゲーション時のスナップショットにフォールバック。
  const playerViewArticle: Article | null =
    navEntry.viewArticleId == null
      ? null
      : (articles.find((a) => a.id === navEntry.viewArticleId) ?? navEntry.snapshot);
  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.stack.length - 1;

  // テーマ切り替え
  function toggleTheme() {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      localStorage.setItem("mimiweb.theme", next);
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }

  // アップデート確認（起動から3秒後に実施）
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdate()
        .then((info) => { if (info.hasUpdate) setUpdateInfo(info); })
        .catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // アプリ起動時に設定を読み込む
  useEffect(() => {
    getSettings().then((s) => {
      setPort(s.voicevoxPort);
      setSpeakerId(s.voicevoxSpeakerId);
      setSpeedScale(s.playbackSpeed);
      setMp3Bitrate(s.mp3Bitrate);
    }).catch(() => {});
  }, []);

  // Voicevox ステータスをグローバルに監視
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onVoicevoxStatusChanged((status) => {
      setVoicevoxStatus(status);
      if (status.state === "ready") setPort(status.port);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const playback = usePlayback({ port, speakerId, initialSpeedScale: speedScale, mp3Bitrate });

  // 再生中の記事を特定
  const playingArticleId =
    playback.state.phase !== "idle" && "articleId" in playback.state
      ? playback.state.articleId
      : null;
  const playingArticle = playingArticleId != null
    ? (articles.find((a) => a.id === playingArticleId) ?? null)
    : null;

  // 再生が開始されたら自動でプレイヤータブへ遷移し、再生中記事を表示（履歴に積む）
  const prevPhaseRef = useRef<string>("idle");
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const curr = playback.state.phase;
    prevPhaseRef.current = curr;
    if ((prev === "idle" || prev === "error") && (curr === "playing" || curr === "synthesizing")) {
      navigateTo({ tab: "player", viewArticle: null });
    }
  }, [playback.state.phase, navigateTo]);

  // 閲覧中記事が再生開始されたら閲覧指定を解除（「すぐ再生」ボタンを隠す。履歴は増やさない）
  useEffect(() => {
    if (playerViewArticle && playingArticleId === playerViewArticle.id) {
      navigateTo({ viewArticle: null }, { replace: true });
    }
  }, [playingArticleId, playerViewArticle, navigateTo]);

  // 記事・履歴・キューから選択 → プレイヤータブで表示（同一記事でもブラウズ状態をリセット）
  const handleViewArticle = useCallback((article: Article) => {
    navigateTo({ tab: "player", viewArticle: article });
  }, [navigateTo]);

  // お気に入りトグル（ビューアから呼ばれる）。articles 更新でビューア表示は自動反映される
  const handleToggleFavorite = useCallback(async (articleId: number) => {
    await toggleFavorite(articleId);
    window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
  }, []);

  // キュー先頭に挿入してすぐ再生（履歴・プレイヤービューアから呼ばれる）
  const handleEnqueueFirstAndPlay = useCallback(async (articleId: number) => {
    let q = await getQueue();
    const existing = q.find((item) => item.articleId === articleId);
    if (!existing) {
      await addToQueue(articleId);
      q = await getQueue();
    }
    const target = q.find((item) => item.articleId === articleId);
    if (target && q[0]?.id !== target.id) {
      const otherIds = q.filter((item) => item.id !== target.id).map((item) => item.id);
      await reorderQueue([target.id, ...otherIds]);
    }
    window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
    window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
    const phase = playback.state.phase;
    if (phase !== "idle" && phase !== "error") {
      playback.restart();
    } else {
      playback.start();
    }
  }, [playback]);

  // プレイヤービューアの記事を最新データで再取得（ビューア表示は articles から自動導出される）
  const handleRefresh = useCallback(async () => {
    const fresh = await getArticles().catch(() => null);
    if (!fresh) return;
    setArticles(fresh);
  }, []);

  // ダブルクリック即時再生: 再生中なら現在の再生を中断してキュー先頭から再起動
  const handlePlayNow = useCallback(() => {
    const phase = playback.state.phase;
    if (phase !== "idle" && phase !== "error") {
      playback.restart();
    } else {
      playback.start();
    }
  }, [playback]);

  const handleClipboardUrl = useCallback(async (url: string) => {
    let articleId: number;
    const result = await registerArticle(url).catch(() => null);
    if (!result) return;
    if (result.ok) {
      articleId = result.value.id;
      window.dispatchEvent(new CustomEvent(ARTICLES_CHANGED_EVENT));
    } else if (result.error.kind === "duplicate_url") {
      const existing = await getArticles().catch(() => [] as Article[]);
      const found = existing.find((a) => a.url === url);
      if (!found) return;
      articleId = found.id;
    } else {
      return;
    }
    try {
      await addToQueue(articleId);
      window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
    } catch { /* already queued */ }
    playback.preSynthesize(articleId);
  }, [playback]);

  useClipboardMonitor({ enabled: clipboardEnabled, onUrlDetected: handleClipboardUrl });

  const [unplayedCount, setUnplayedCount] = useState(0);

  // タブ間共有検索テキスト（記事一覧・ビューア・履歴で同期）
  const [sharedSearch, setSharedSearch] = useState<string | undefined>(undefined);

  const handleSearchChange = useCallback((text: string) => {
    setSharedSearch(text);
  }, []);

  const handleWordClick = useCallback((word: string) => {
    setSharedSearch(word);
  }, []);

  const TAB_LABELS: { key: Tab; label: string }[] = [
    { key: "articles",  label: "記事一覧" },
    { key: "player",    label: "ビューア" },
    { key: "synthesis", label: "音声の準備" },
    { key: "history",   label: "履歴" },
    { key: "settings",  label: "設定" },
  ];

  const isPlayerTab = tab === "player";

  // プレイヤータブに表示する記事と「すぐ再生」ボタン表示判定
  const playerDisplayArticle = playerViewArticle ?? playingArticle;
  const isPlayerDisplayActive = playerDisplayArticle?.id === playingArticleId;
  const showPlayerPlayNow = playerViewArticle !== null && playerViewArticle.id !== playingArticle?.id;

  // ビューアタブ表示中の記事をワードクラウドに即時反映
  const playerDisplayArticleId = playerDisplayArticle?.id ?? null;
  const playerDisplayArticleTitle = playerDisplayArticle?.title ?? null;
  useEffect(() => {
    if (tab === "player" && playerDisplayArticleId !== null) {
      wordCloudBus.showNow(playerDisplayArticleId, playerDisplayArticleTitle, playerDisplayArticle?.url ?? null);
    }
  }, [tab, playerDisplayArticleId, playerDisplayArticleTitle]);

  // 起動時、まだ何も表示していなければ最新記事のワードクラウドを初期表示する
  // （ホバーしないと空欄のままでユーザーが機能に気づかない問題への対処）
  const initialWcShownRef = useRef(false);
  useEffect(() => {
    if (initialWcShownRef.current || articles.length === 0) return;
    if (tab === "player") return; // ビューアタブは専用 effect が表示を担う
    initialWcShownRef.current = true;
    const latest = articles[0];
    wordCloudBus.showNow(latest.id, latest.title ?? null, latest.url ?? null);
  }, [articles, tab]);

  return (
    <div
      data-theme={theme}
      style={{ marginRight: sidebarWidth, transition: "margin-right 0.2s ease", height: "100vh", overflow: "hidden" }}
    >
    <div style={{ fontFamily: "sans-serif", width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", color: "var(--text)" }}>
      {/* ヘッダー */}
      <header style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexShrink: 0, background: "var(--surface)" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>mimiweb</h1>

        {/* ブラウザ風の戻る/進む（表示位置のみ移動・再生に干渉しない） */}
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="前の画面に戻る"
            title={`前の画面に戻る (${keyLabel(getCurrentKeybindings().navBack)})`}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, padding: 0, borderRadius: 6,
              background: "none", border: "none", boxShadow: "none",
              color: "var(--text)", cursor: canGoBack ? "pointer" : "default",
              opacity: canGoBack ? 1 : 0.3,
            }}
          >
            <ArrowLeft size={18} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            aria-label="次の画面に進む"
            title={`次の画面に進む (${keyLabel(getCurrentKeybindings().navForward)})`}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, padding: 0, borderRadius: 6,
              background: "none", border: "none", boxShadow: "none",
              color: "var(--text)", cursor: canGoForward ? "pointer" : "default",
              opacity: canGoForward ? 1 : 0.3,
            }}
          >
            <ArrowRight size={18} />
          </button>
        </div>
        <span
          onClick={voicevoxStatus.state !== "ready" ? () => setTab("settings") : undefined}
          title={voicevoxStatus.state !== "ready" ? "クリックで設定タブを開く" : undefined}
          style={{
            fontSize: 12,
            color: voicevoxStatus.state === "ready" ? "var(--success)" : "var(--warning)",
            cursor: voicevoxStatus.state !== "ready" ? "pointer" : "default",
            textDecoration: voicevoxStatus.state !== "ready" ? "underline" : "none",
          }}
        >
          ● Voicevox {voicevoxStatus.state === "ready" ? "接続済み" : voicevoxStatus.state}
        </span>

        <div style={{ flex: 1 }} />

        {/* 起動時の「続きから再生」導線 */}
        {playback.state.phase === "idle" && queueCount > 0 && (
          <button
            onClick={() => { setTab("player"); playback.start(); }}
            title="再生キューの先頭から再生します（前回の続きがあれば途中から再開）"
            style={{
              fontSize: 13, padding: "4px 12px", borderRadius: 4,
              background: "var(--accent)", color: "#fff", border: "none",
              cursor: "pointer", boxShadow: "none", fontWeight: 600,
            }}
          >
            <Play size={13} fill="currentColor" strokeWidth={0} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            続きから再生
          </button>
        )}

        {/* テーマ切り替え */}
        <button
          onClick={toggleTheme}
          title={theme === "light" ? "ダークテーマに切り替え" : "ライトテーマに切り替え"}
          style={{
            fontSize: 18, background: "none", border: "none", cursor: "pointer",
            padding: "2px 4px", lineHeight: 1, boxShadow: "none",
          }}
        >
          {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
        </button>
      </header>

      {/* アップデート通知バナー */}
      {updateInfo && (
        <UpdateBanner info={updateInfo} onDismiss={() => setUpdateInfo(null)} />
      )}

      {/* Piper TTS 誘導バナー（英語記事登録時・未インストール時） */}
      {showPiperPrompt && (
        <div style={{
          background: "#fff3cd",
          color: "#7a5b00",
          fontSize: 13,
          padding: "7px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
          borderBottom: "1px solid #f0d97a",
        }}>
          <span style={{ flex: 1 }}>
            英語の記事が登録されました。英語の読み上げには <strong>Piper TTS</strong> のインストールが必要です。
          </span>
          <button
            onClick={() => { setTab("settings"); setShowPiperPrompt(false); }}
            style={{
              fontSize: 12, padding: "3px 10px",
              background: "#e0a800", border: "none", borderRadius: 4,
              color: "#fff", cursor: "pointer", boxShadow: "none", fontWeight: 600,
            }}
          >
            設定を開く
          </button>
          <button
            onClick={() => setShowPiperPrompt(false)}
            style={{
              fontSize: 16, background: "none", border: "none",
              color: "#7a5b00", cursor: "pointer", padding: "0 4px",
              lineHeight: 1, boxShadow: "none",
            }}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      )}

      {/* タブナビゲーション */}
      <nav style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0, background: "var(--surface)" }}>
        {TAB_LABELS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              flex: 1,
              padding: "10px",
              border: "none",
              borderBottom: tab === key ? "2px solid var(--accent)" : "2px solid transparent",
              background: "none",
              cursor: "pointer",
              fontWeight: tab === key ? 700 : 400,
              color: tab === key ? "var(--accent)" : "var(--text)",
              boxShadow: "none",
              position: "relative",
            }}
          >
            {label}
            {key === "articles" && unplayedCount > 0 && (
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                marginLeft: 4, minWidth: 16, height: 16, padding: "0 4px",
                borderRadius: 8, background: "var(--accent)", color: "#fff",
                fontSize: 10, fontWeight: 700, lineHeight: 1, verticalAlign: "middle",
              }}>
                {unplayedCount > 99 ? "99+" : unplayedCount}
              </span>
            )}
            {key === "synthesis" && (playback.batchSynthRunning || playback.synthProgress !== null) && (
              <span
                title="音声の準備が進行中です"
                style={{
                  display: "inline-block", marginLeft: 6, width: 8, height: 8,
                  borderRadius: "50%", background: "var(--warning)", verticalAlign: "middle",
                  animation: "synth-pulse 1s ease-in-out infinite",
                }}
              />
            )}
          </button>
        ))}
      </nav>

      {/* コンテンツ */}
      <main style={
        isPlayerTab
          ? { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", padding: "0 16px 64px", minHeight: 0 }
          : { flex: 1, overflowY: "auto", padding: "16px 16px 80px" }
      }>
        {tab === "articles" && (
          <ArticleListPanel
            onViewArticle={handleViewArticle}
            onPlay={handlePlayNow}
            onArticleContextMenu={handleArticleContextMenu}
            onUnplayedCount={setUnplayedCount}
            externalSearch={sharedSearch}
            onSearchChange={handleSearchChange}
            onRequestSynth={(id) => playback.preSynthesize(id)}
            onArticleDeleted={(id) => {
              // 再生中の記事が削除されたら鳴り続けないよう次の記事へ移行する
              // （queue_items は CASCADE 削除済みなので restart で新しい先頭を再生）
              if (id === playingArticleId) {
                const phase = playback.state.phase;
                if (phase !== "idle" && phase !== "error") playback.restart();
              }
            }}
          />
        )}
        {tab === "synthesis" && (
          <SynthesisPanel
            playback={playback}
            onArticleContextMenu={handleArticleContextMenu}
            onSelectArticle={handleViewArticle}
          />
        )}
        {tab === "history"  && (
          <HistoryPanel
            onSelectArticle={handleViewArticle}
            onDoubleClickPlay={(id) => handleEnqueueFirstAndPlay(id).catch(() => {})}
            onArticleContextMenu={handleArticleContextMenu}
            externalSearch={sharedSearch}
            onSearchChange={handleSearchChange}
          />
        )}
        {tab === "settings" && (
          <SettingsPanel
            clipboardEnabled={clipboardEnabled}
            onToggleClipboard={toggleClipboard}
            onMp3BitrateChange={setMp3Bitrate}
          />
        )}
        {tab === "player"   && (
          playerDisplayArticle
            ? (
              <ArticleViewerPanel
                article={playerDisplayArticle}
                playbackState={playback.state}
                segmentIndex={playback.segmentIndex}
                onSegmentClick={isPlayerDisplayActive ? playback.jumpToSegment : undefined}
                showFontSlider
                synthProgress={playback.synthProgress}
                onPlayNow={showPlayerPlayNow
                  ? () => handleEnqueueFirstAndPlay(playerDisplayArticle.id).catch(() => {})
                  : undefined}
                onRefresh={() => handleRefresh().catch(() => {})}
                onToggleFavorite={(id) => handleToggleFavorite(id).catch(() => {})}
                viewGeneration={playerViewGeneration}
                searchWord={sharedSearch}
                onSearchWordChange={handleSearchChange}
                summaryMode={playback.summaryMode}
              />
            )
            : <p style={{ color: "var(--text-muted)" }}>再生中の記事はありません</p>
        )}
      </main>

      {/* 再生バー (固定フッター) */}
      <PlaybackBar playback={playback} playingArticle={playingArticle} />
    </div>

    {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

    {ctxMenu && (
      <ContextMenu
        x={ctxMenu.x}
        y={ctxMenu.y}
        selectedText={ctxMenu.text}
        onClose={() => setCtxMenu(null)}
      />
    )}
    {articleCtxMenu && (
      <ArticleContextMenu
        x={articleCtxMenu.x}
        y={articleCtxMenu.y}
        url={articleCtxMenu.url}
        onClose={() => setArticleCtxMenu(null)}
      />
    )}

    {/* 右サイドバー: 再生キュー */}
    <QueueSidebar
      collapsed={sidebarCollapsed}
      onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
      playbackState={playback.state}
      onSelectArticle={handleViewArticle}
      onSkip={playback.skip}
      onPlayNow={handlePlayNow}
      onArticleContextMenu={handleArticleContextMenu}
      onWordClick={handleWordClick}
    />
    </div>
  );
}

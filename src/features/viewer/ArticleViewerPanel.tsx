import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, X, ChevronLeft, ChevronRight, RotateCw, Star } from "lucide-react";
import DOMPurify from "dompurify";
import { buildFullText, markSkippedElements } from "./viewerUtils";
import { splitSentences } from "@/lib/voicevoxClient";
import { fetchPageHtml, registerArticle, getArticleKeywords } from "@/lib/tauriCommands";
import { selectKeySentenceIndices } from "@/lib/summarize";
import { getCurrentKeybindings, matchesBinding } from "@/lib/keybindings";
import type { Article, PlaybackState } from "@/shared/types";

function clearHighlights(container: HTMLElement) {
  container.querySelectorAll("mark[data-tts]").forEach((m) => {
    m.replaceWith(...Array.from(m.childNodes));
  });
  container.querySelectorAll("span[data-tts-unsynth]").forEach((s) => {
    s.replaceWith(...Array.from(s.childNodes));
  });
  container.querySelectorAll("[data-tts-ruby]").forEach((el) => {
    el.removeAttribute("data-tts-ruby");
    (el as HTMLElement).style.removeProperty("background");
    (el as HTMLElement).style.removeProperty("border-radius");
  });
  container.querySelectorAll("[data-tts-unsynth]").forEach((el) => {
    el.removeAttribute("data-tts-unsynth");
  });
}

function applyHighlight(container: HTMLElement, sentence: string): HTMLElement[] {
  const target = sentence.trim();
  if (!target) return [];

  // htmlToText() と同じルビ処理: <ruby> 基底テキスト・<rp> をスキップし <rt> を採用
  type NodeRange = { node: Text; start: number; end: number; rubyAncestor?: HTMLElement };
  const nodeRanges: NodeRange[] = [];
  let fullText = "";

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    const parentTag = n.parentElement?.tagName.toLowerCase();
    if (parentTag === "ruby" || parentTag === "rb" || parentTag === "rp") {
      n = walker.nextNode() as Text | null;
      continue;
    }
    const start = fullText.length;
    fullText += n.textContent ?? "";
    const rubyAncestor =
      parentTag === "rt"
        ? (n.parentElement?.closest("ruby") as HTMLElement | null) ?? undefined
        : undefined;
    nodeRanges.push({ node: n, start, end: fullText.length, rubyAncestor });
    n = walker.nextNode() as Text | null;
  }

  const idx = fullText.indexOf(target);
  if (idx === -1) return [];

  const sentEnd = idx + target.length;
  const marks: HTMLElement[] = [];

  for (const { node, start, end, rubyAncestor } of nodeRanges) {
    if (end <= idx || start >= sentEnd) continue;

    if (rubyAncestor) {
      // ruby 要素全体をハイライト（漢字＋ルビ両方が強調される）
      rubyAncestor.setAttribute("data-tts-ruby", "");
      rubyAncestor.style.background = "#ffe066";
      rubyAncestor.style.borderRadius = "2px";
      marks.push(rubyAncestor);
    } else {
      const localStart = Math.max(0, idx - start);
      const localEnd = Math.min(end - start, sentEnd - start);
      const text = node.textContent ?? "";

      const mark = document.createElement("mark");
      mark.setAttribute("data-tts", "");
      mark.style.cssText = "background:#ffe066;border-radius:2px;padding:0;";
      mark.textContent = text.slice(localStart, localEnd);

      const frag = document.createDocumentFragment();
      if (localStart > 0) frag.appendChild(document.createTextNode(text.slice(0, localStart)));
      frag.appendChild(mark);
      if (localEnd < text.length) frag.appendChild(document.createTextNode(text.slice(localEnd)));
      node.replaceWith(frag);
      marks.push(mark);
    }
  }

  return marks;
}

/**
 * fromIndex 以降のセグメントに data-tts-unsynth マークを適用する。
 * applyHighlight と同じルビ処理で DOM を走査し、<span data-tts-unsynth> を挿入する。
 * clearHighlights で回収されるため applyHighlight の前に呼ぶこと。
 */
function markUnsynthSegments(
  container: HTMLElement,
  segments: string[],
  fromIndex: number,
): void {
  type NodeRange = { node: Text; start: number; end: number; rubyAncestor?: HTMLElement };
  const nodeRanges: NodeRange[] = [];
  let fullText = "";

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    const parentTag = n.parentElement?.tagName.toLowerCase();
    if (parentTag === "ruby" || parentTag === "rb" || parentTag === "rp") {
      n = walker.nextNode() as Text | null;
      continue;
    }
    const start = fullText.length;
    fullText += n.textContent ?? "";
    const rubyAncestor =
      parentTag === "rt"
        ? (n.parentElement?.closest("ruby") as HTMLElement | null) ?? undefined
        : undefined;
    nodeRanges.push({ node: n, start, end: fullText.length, rubyAncestor });
    n = walker.nextNode() as Text | null;
  }

  // fromIndex 以降のセグメント位置をシーケンシャルに特定
  type TextRange = { start: number; end: number };
  const unsynthRanges: TextRange[] = [];
  let searchStart = 0;
  for (let i = 0; i < segments.length; i++) {
    const target = segments[i].trim();
    if (!target) continue;
    const idx = fullText.indexOf(target, searchStart);
    if (idx === -1) continue;
    if (i >= fromIndex) unsynthRanges.push({ start: idx, end: idx + target.length });
    searchStart = idx + target.length;
  }
  if (unsynthRanges.length === 0) return;

  for (const { node, start, end, rubyAncestor } of nodeRanges) {
    const overlapping = unsynthRanges.filter((r) => r.end > start && r.start < end);
    if (overlapping.length === 0) continue;

    if (rubyAncestor) {
      rubyAncestor.setAttribute("data-tts-unsynth", "");
      continue;
    }

    const text = node.textContent ?? "";
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const r of overlapping) {
      const lStart = Math.max(0, r.start - start);
      const lEnd = Math.min(text.length, r.end - start);
      if (pos < lStart) frag.appendChild(document.createTextNode(text.slice(pos, lStart)));
      const span = document.createElement("span");
      span.setAttribute("data-tts-unsynth", "");
      span.textContent = text.slice(lStart, lEnd);
      frag.appendChild(span);
      pos = lEnd;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.replaceWith(frag);
  }
}

/**
 * HTML コンテンツ内のクリック位置から対応するセグメントインデックスを返す。
 * document.caretRangeFromPoint でクリックされたテキストノードとオフセットを取得し、
 * DOM テキスト全体での文字位置を計算してセグメント境界と照合する。
 */
function getClickedSegmentIndex(
  container: HTMLElement,
  segments: string[],
  clientX: number,
  clientY: number,
): number | null {
  const caretRange = document.caretRangeFromPoint?.(clientX, clientY);
  if (!caretRange || caretRange.startContainer.nodeType !== Node.TEXT_NODE) return null;

  let clickedNode = caretRange.startContainer as Text;
  let clickedOffset = caretRange.startOffset;

  // ruby 基底テキスト（ruby/rb 直下）・rp をクリックした場合、対応する <rt> テキストノードにリダイレクト
  const clickedParentTag = clickedNode.parentElement?.tagName.toLowerCase();
  if (clickedParentTag === "ruby" || clickedParentTag === "rb" || clickedParentTag === "rp") {
    const ruby =
      clickedParentTag === "ruby"
        ? clickedNode.parentElement!
        : clickedNode.parentElement!.closest("ruby");
    const rtFirstChild = ruby?.querySelector("rt")?.firstChild;
    if (rtFirstChild instanceof Text) {
      clickedNode = rtFirstChild;
      clickedOffset = 0;
    } else {
      return null;
    }
  }

  // htmlToText() と同じルビ処理でテキスト全体を構築
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let fullDomText = "";
  let clickDomOffset = -1;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const parentTag = node.parentElement?.tagName.toLowerCase();
    if (parentTag !== "ruby" && parentTag !== "rb" && parentTag !== "rp") {
      if (node === clickedNode) {
        clickDomOffset = fullDomText.length + clickedOffset;
      }
      fullDomText += node.textContent ?? "";
    }
    node = walker.nextNode() as Text | null;
  }
  if (clickDomOffset === -1) return null;

  let searchStart = 0;
  for (let i = 0; i < segments.length; i++) {
    const target = segments[i].trim();
    if (!target) continue;
    const idx = fullDomText.indexOf(target, searchStart);
    if (idx === -1) continue;
    const end = idx + target.length;
    if (clickDomOffset >= idx && clickDomOffset < end) return i;
    searchStart = end;
  }
  return null;
}

function clearBlockNumbers(container: HTMLElement): void {
  container.querySelectorAll("span[data-block-num]").forEach((el) => el.remove());
}

function applySearchHighlights(container: HTMLElement, keyword: string): HTMLElement[] {
  const target = keyword.trim();
  if (!target) return [];
  const targetLower = target.toLowerCase();

  type NodeRange = { node: Text; start: number; end: number; rubyAncestor?: HTMLElement };
  const nodeRanges: NodeRange[] = [];
  let fullText = "";

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    const parentTag = n.parentElement?.tagName.toLowerCase();
    if (parentTag === "ruby" || parentTag === "rb" || parentTag === "rp") {
      n = walker.nextNode() as Text | null;
      continue;
    }
    const start = fullText.length;
    fullText += n.textContent ?? "";
    const rubyAncestor =
      parentTag === "rt"
        ? (n.parentElement?.closest("ruby") as HTMLElement | null) ?? undefined
        : undefined;
    nodeRanges.push({ node: n, start, end: fullText.length, rubyAncestor });
    n = walker.nextNode() as Text | null;
  }

  const fullTextLower = fullText.toLowerCase();
  const matchStarts: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = fullTextLower.indexOf(targetLower, searchFrom);
    if (idx === -1) break;
    matchStarts.push(idx);
    searchFrom = idx + target.length;
  }
  if (matchStarts.length === 0) return [];

  const allMarks: HTMLElement[] = [];
  const processedRubyAncestors = new Set<HTMLElement>();

  for (const nr of nodeRanges) {
    if (nr.rubyAncestor) {
      const hasMatch = matchStarts.some((idx) => nr.end > idx && nr.start < idx + target.length);
      if (hasMatch && !processedRubyAncestors.has(nr.rubyAncestor)) {
        processedRubyAncestors.add(nr.rubyAncestor);
        nr.rubyAncestor.setAttribute("data-search", "");
        nr.rubyAncestor.style.background = "#bbf7d0";
        nr.rubyAncestor.style.borderRadius = "2px";
        allMarks.push(nr.rubyAncestor);
      }
      continue;
    }

    const overlaps: Array<{ lStart: number; lEnd: number }> = [];
    for (const idx of matchStarts) {
      const end = idx + target.length;
      if (nr.end <= idx || nr.start >= end) continue;
      overlaps.push({
        lStart: Math.max(0, idx - nr.start),
        lEnd: Math.min(nr.end - nr.start, end - nr.start),
      });
    }
    if (overlaps.length === 0) continue;

    const text = nr.node.textContent ?? "";
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const { lStart, lEnd } of overlaps) {
      if (pos < lStart) frag.appendChild(document.createTextNode(text.slice(pos, lStart)));
      const mark = document.createElement("mark");
      mark.setAttribute("data-search", "");
      mark.style.cssText = "background:#bbf7d0;border-radius:2px;padding:0;";
      mark.textContent = text.slice(lStart, lEnd);
      frag.appendChild(mark);
      allMarks.push(mark);
      pos = lEnd;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    nr.node.replaceWith(frag);
  }

  return allMarks;
}

function clearSearchHighlights(container: HTMLElement): void {
  container.querySelectorAll("mark[data-search]").forEach((m) => {
    m.replaceWith(...Array.from(m.childNodes));
  });
  container.querySelectorAll("[data-search]").forEach((el) => {
    el.removeAttribute("data-search");
    (el as HTMLElement).style.removeProperty("background");
    (el as HTMLElement).style.removeProperty("border-radius");
    (el as HTMLElement).style.removeProperty("color");
  });
}

/**
 * TTS セグメント境界に空 <span data-block-num="N"> を挿入する。
 * applyHighlight と同じルビ aware TreeWalker でテキストを走査し、
 * 各セグメントの先頭位置に span を差し込む。
 * span はテキストノードを持たないため TreeWalker(SHOW_TEXT) に影響しない。
 */
function injectBlockNumbers(container: HTMLElement, segments: string[]): void {
  if (segments.length === 0) return;

  type NodeRange = { node: Text; start: number; end: number };
  const nodeRanges: NodeRange[] = [];
  let fullText = "";

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    const parentTag = n.parentElement?.tagName.toLowerCase();
    if (parentTag === "ruby" || parentTag === "rb" || parentTag === "rp") {
      n = walker.nextNode() as Text | null;
      continue;
    }
    const start = fullText.length;
    fullText += n.textContent ?? "";
    nodeRanges.push({ node: n, start, end: fullText.length });
    n = walker.nextNode() as Text | null;
  }

  // 各セグメントの開始位置を逐次探索し、テキストノードインデックスと局所オフセットを記録
  type Insertion = { nodeIndex: number; localOffset: number; segmentNumber: number };
  const insertions: Insertion[] = [];
  let searchFrom = 0;

  for (let i = 0; i < segments.length; i++) {
    const target = segments[i].trim();
    if (!target) continue;
    const idx = fullText.indexOf(target, searchFrom);
    if (idx === -1) continue;

    const nodeIdx = nodeRanges.findIndex((r) => r.start <= idx && idx < r.end);
    if (nodeIdx !== -1) {
      insertions.push({ nodeIndex: nodeIdx, localOffset: idx - nodeRanges[nodeIdx].start, segmentNumber: i + 1 });
    }
    searchFrom = idx + target.length;
  }

  // ノード単位でグループ化し、各グループを局所オフセット降順で処理（右→左で分割）
  const byNode = new Map<number, { localOffset: number; segmentNumber: number }[]>();
  for (const ins of insertions) {
    if (!byNode.has(ins.nodeIndex)) byNode.set(ins.nodeIndex, []);
    byNode.get(ins.nodeIndex)!.push({ localOffset: ins.localOffset, segmentNumber: ins.segmentNumber });
  }

  const nodeIndices = Array.from(byNode.keys()).sort((a, b) => b - a);
  for (const nodeIdx of nodeIndices) {
    const items = byNode.get(nodeIdx)!.sort((a, b) => b.localOffset - a.localOffset);
    let cur = nodeRanges[nodeIdx].node;
    for (const { localOffset, segmentNumber } of items) {
      const span = document.createElement("span");
      span.setAttribute("data-block-num", String(segmentNumber));
      if (localOffset > 0) {
        // splitText で右部分を切り出し、その直前に span を挿入。cur は左部分のまま残る
        const right = cur.splitText(localOffset);
        right.parentNode?.insertBefore(span, right);
      } else {
        cur.parentNode?.insertBefore(span, cur);
      }
    }
  }
}

/**
 * 取得した生 HTML にベース URL とリンクインターセプトスクリプトを注入し、
 * iframe srcdoc として使える HTML 文字列を返す。
 */
function prepareSrcdoc(html: string, url: string): string {
  // URL を属性値に埋め込む前にエスケープして属性ブレイクアウトを防ぐ
  const safeUrl = url.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  const baseTag = `<base href="${safeUrl}">`;
  // クリック・右クリックを postMessage で親に通知するスクリプト
  const script =
    `<script>` +
    `document.addEventListener('click',function(e){` +
    `var a=e.target&&e.target.closest?e.target.closest('a'):null;` +
    `if(a&&a.href&&(a.href.startsWith('http://')||a.href.startsWith('https://'))){` +
    `e.preventDefault();window.parent.postMessage({type:'navigate',url:a.href},'*');}});` +
    `document.addEventListener('contextmenu',function(e){` +
    `e.preventDefault();` +
    `var a=e.target&&e.target.closest?e.target.closest('a'):null;` +
    `var lh=a&&a.href&&(a.href.startsWith('http://')||a.href.startsWith('https://'))?a.href:null;` +
    `window.parent.postMessage({type:'contextmenu',x:e.clientX,y:e.clientY,linkHref:lh},'*');});` +
    `<` + `/script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${baseTag}${script}`);
  }
  return baseTag + script + html;
}

// ─── 未加工 Web ページ用コンテキストメニュー ─────────────────────────────────

function BrowseContextMenu({
  x, y, currentUrl, linkHref, onClose, onBack,
}: {
  x: number; y: number;
  currentUrl: string;
  linkHref: string | null;
  onClose: () => void;
  onBack: () => void;
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

  const MENU_W = 240;
  const rowH = 36;
  const sepH = 7;
  const numItems = linkHref ? 6 : 3;
  const numSeps = linkHref ? 2 : 1;
  const MENU_H = numItems * rowH + numSeps * sepH + 6;
  const adjX = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 4));
  const adjY = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4));

  const btnStyle: React.CSSProperties = {
    display: "block", width: "100%", padding: "6px 14px",
    background: "none", border: "none", borderRadius: 0,
    cursor: "pointer", color: "var(--text)", fontSize: 13,
    textAlign: "left", boxShadow: "none", fontFamily: "inherit",
  };
  const sepStyle: React.CSSProperties = { height: 1, background: "var(--border)", margin: "3px 0" };

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
      {linkHref && (
        <>
          <button style={btnStyle} onMouseEnter={(e) => hover(e, true)} onMouseLeave={(e) => hover(e, false)}
            onClick={() => { registerArticle(linkHref).catch(() => {}); onClose(); }}>
            リンク先のURLを記事に追加
          </button>
          <button style={btnStyle} onMouseEnter={(e) => hover(e, true)} onMouseLeave={(e) => hover(e, false)}
            onClick={() => { navigator.clipboard.writeText(linkHref).catch(() => {}); onClose(); }}>
            リンク先のURLをコピー
          </button>
          <div style={sepStyle} />
        </>
      )}
      <button style={btnStyle} onMouseEnter={(e) => hover(e, true)} onMouseLeave={(e) => hover(e, false)}
        onClick={() => { registerArticle(currentUrl).catch(() => {}); onClose(); }}>
        現在のページのURLを記事に追加
      </button>
      <button style={btnStyle} onMouseEnter={(e) => hover(e, true)} onMouseLeave={(e) => hover(e, false)}
        onClick={() => { navigator.clipboard.writeText(currentUrl).catch(() => {}); onClose(); }}>
        現在のページのURLをコピー
      </button>
      <div style={sepStyle} />
      <button style={btnStyle} onMouseEnter={(e) => hover(e, true)} onMouseLeave={(e) => hover(e, false)}
        onClick={() => { onBack(); onClose(); }}>
        元の記事に戻る
      </button>
    </div>
  );
}

export function ArticleViewerPanel({
  article,
  playbackState,
  segmentIndex,
  onClose,
  collapsible = false,
  showFontSlider = false,
  onSegmentClick,
  synthProgress,
  onPlayNow,
  onRefresh,
  onToggleFavorite,
  viewGeneration,
  searchWord,
  onSearchWordChange,
  summaryMode = false,
  style,
}: {
  article: Article;
  playbackState: PlaybackState;
  segmentIndex: number | null;
  onClose?: () => void;
  collapsible?: boolean;
  showFontSlider?: boolean;
  onSegmentClick?: (idx: number) => void;
  synthProgress?: { articleId: number; done: number; total: number } | null;
  onPlayNow?: () => void;
  onRefresh?: () => void;
  onToggleFavorite?: (id: number) => void;
  viewGeneration?: number;
  searchWord?: string;
  onSearchWordChange?: (text: string) => void;
  summaryMode?: boolean;
  style?: React.CSSProperties;
}) {
  const [fontSize, setFontSize] = useState(15);
  const [collapsed, setCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [browsePage, setBrowsePage] = useState<{ url: string; title: string; srcdoc: string } | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseCtxMenu, setBrowseCtxMenu] = useState<{ x: number; y: number; linkHref: string | null } | null>(null);
  const [localSearchText, setLocalSearchText] = useState("");
  const [appliedSearchWord, setAppliedSearchWord] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [htmlMatchCount, setHtmlMatchCount] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchHtmlMatchesRef = useRef<HTMLElement[]>([]);

  // 記事が切り替わったらブラウズ状態をリセット
  useEffect(() => { setBrowsePage(null); setBrowseCtxMenu(null); }, [article.id]);

  // 外部から同一記事が再クリックされたときもブラウズ状態をリセット
  useEffect(() => { setBrowsePage(null); setBrowseCtxMenu(null); }, [viewGeneration]);

  // 外部 searchWord（ワードクラウドクリック・タブ間共有検索）を即時反映
  useEffect(() => {
    if (searchWord === undefined) return;
    if (searchWord === localSearchText) return; // 自分が発火元の場合はスキップ
    setLocalSearchText(searchWord);
    setAppliedSearchWord(searchWord);
    if (searchWord) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchWord]); // eslint-disable-line react-hooks/exhaustive-deps

  // 300ms デバウンス自動検索
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearchWord(localSearchText), 300);
    return () => clearTimeout(timer);
  }, [localSearchText]);

  // 設定されたキーでビューア内検索ボックスにフォーカス（ビューアタブのみ）
  useEffect(() => {
    if (!showFontSlider) return;
    function onKeyDown(e: KeyboardEvent) {
      if (matchesBinding(e, getCurrentKeybindings().viewerSearch)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showFontSlider]);

  // 検索ワード変化時にナビゲーション位置をリセット
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [appliedSearchWord]);

  // HTML モード: 検索ハイライトを適用・クリア（Effect A - Effect B より先に宣言する必要あり）
  useEffect(() => {
    const container = htmlRef.current;
    if (!container || !article.contentHtml || browsePage) {
      if (container) clearSearchHighlights(container);
      searchHtmlMatchesRef.current = [];
      setHtmlMatchCount(0);
      return;
    }
    clearSearchHighlights(container);
    if (!appliedSearchWord) {
      searchHtmlMatchesRef.current = [];
      setHtmlMatchCount(0);
      return;
    }
    const marks = applySearchHighlights(container, appliedSearchWord);
    searchHtmlMatchesRef.current = marks;
    setHtmlMatchCount(marks.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedSearchWord, article.contentHtml, browsePage]);

  // 現在の一致箇所へスクロール＋カレントマーク強調（Effect B）
  useEffect(() => {
    if (collapsed || browsePage) return;
    if (article.contentHtml && htmlRef.current) {
      const marks = searchHtmlMatchesRef.current;
      marks.forEach((m, i) => {
        if (!m.isConnected) return;
        m.style.background = i === currentMatchIndex ? "#16a34a" : "#bbf7d0";
        m.style.color = i === currentMatchIndex ? "#fff" : "";
      });
      const mark = marks[currentMatchIndex];
      if (mark?.isConnected) mark.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (!article.contentHtml && appliedSearchWord) {
      const segIdx = sortedSearchMatches[currentMatchIndex];
      if (segIdx !== undefined) {
        spanRefs.current[segIdx]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatchIndex, appliedSearchWord, article.contentHtml, collapsed, browsePage]);

  const handleNavigateBrowse = useCallback((url: string) => {
    setBrowseLoading(true);
    fetchPageHtml(url)
      .then((html) => {
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : url;
        setBrowsePage({ url, title, srcdoc: prepareSrcdoc(html, url) });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setBrowsePage({ url, title: url, srcdoc: `<p style="color:var(--danger)">ページの取得に失敗しました: ${msg}</p>` });
      })
      .finally(() => setBrowseLoading(false));
  }, []);

  // iframe 内のリンククリック・右クリックを受け取る
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // ブラウズ用 iframe からのメッセージのみ受け付ける（他フレームからの偽装を防ぐ）
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!e.data) return;
      if (e.data.type === "navigate" && typeof e.data.url === "string") {
        handleNavigateBrowse(e.data.url as string);
      } else if (e.data.type === "contextmenu") {
        const rect = iframeRef.current?.getBoundingClientRect();
        setBrowseCtxMenu({
          x: (rect?.left ?? 0) + (e.data.x as number),
          y: (rect?.top ?? 0) + (e.data.y as number),
          linkHref: (e.data.linkHref as string | null) ?? null,
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleNavigateBrowse]);

  function handleWheel(e: React.WheelEvent) {
    if (e.ctrlKey) {
      e.preventDefault();
      setFontSize((prev) => Math.max(8, Math.min(80, prev - Math.sign(e.deltaY) * 1)));
      return;
    }
    if (autoScroll) setAutoScroll(false);
  }

  const title = browsePage?.title ?? (article.title ?? article.url);
  const isLoading = article.status === "pending" || article.status === "extracting";
  const isError = article.status === "error";
  const hasContent =
    article.status === "ready" ||
    article.status === "queued" ||
    article.status === "played";

  const segments = hasContent
    ? splitSentences(
        buildFullText(article.title, article.content, article.contentHtml),
        (article.language ?? "ja") as "ja" | "en",
      )
    : [];

  // スクレイピングした HTML はメイン画面に直接描画するため、DOMPurify で必ずサニタイズする。
  // （Readability はセキュリティサニタイザーではないため、onerror 等のイベントハンドラ経由の
  //   XSS を防ぐ目的。ルビ要素 ruby/rt/rp/rb は DOMPurify デフォルトで保持される）
  const sanitizedHtml = useMemo(
    () => (article.contentHtml ? DOMPurify.sanitize(article.contentHtml) : ""),
    [article.contentHtml],
  );

  // 検索ワードに一致するセグメントインデックスを計算
  const searchMatchIndices = useMemo(() => {
    if (!appliedSearchWord || !hasContent) return new Set<number>();
    const lower = appliedSearchWord.toLowerCase();
    const result = new Set<number>();
    segments.forEach((seg, i) => {
      if (seg.toLowerCase().includes(lower)) result.add(i);
    });
    return result;
  }, [appliedSearchWord, segments, hasContent]);

  const sortedSearchMatches = useMemo(
    () => [...searchMatchIndices].sort((a, b) => a - b),
    [searchMatchIndices]
  );
  const currentSearchMatchSegIdx = sortedSearchMatches[currentMatchIndex] ?? -1;
  const totalMatches = article.contentHtml ? htmlMatchCount : searchMatchIndices.size;

  // 検索にヒットし、かつ再生中であれば自動追尾を OFF にする
  useEffect(() => {
    const hasMatches = article.contentHtml ? htmlMatchCount > 0 : searchMatchIndices.size > 0;
    if (appliedSearchWord && hasMatches && isActiveArticle && !isIdle) {
      setAutoScroll(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedSearchWord, htmlMatchCount, searchMatchIndices]);

  const isActiveArticle =
    playbackState.phase !== "idle" &&
    "articleId" in playbackState &&
    playbackState.articleId === article.id;

  const isIdle = playbackState.phase === "idle" || playbackState.phase === "error";

  // 要点モード: 再生中記事の重要文インデックスを計算（非重要文を dim 表示する）
  const [summaryKeySet, setSummaryKeySet] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!summaryMode || !isActiveArticle || !hasContent || segments.length === 0) {
      setSummaryKeySet(null);
      return;
    }
    let cancelled = false;
    getArticleKeywords(article.id)
      .then((kws) => { if (!cancelled) setSummaryKeySet(selectKeySentenceIndices(segments, kws)); })
      .catch(() => { if (!cancelled) setSummaryKeySet(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryMode, isActiveArticle, hasContent, article.id, segments.length]);

  // タイトルセグメント（segments[0]）読み上げ中はヘッダータイトルをハイライト（ブラウズ中は除外）
  const isTitleActive = !browsePage && hasContent && isActiveArticle && !isIdle && segmentIndex === 0 && article.title != null;

  // 未合成セグメント数の計算（合成進行中のみ有効）
  const isSynthInProgress =
    !!(synthProgress?.articleId === article.id && synthProgress.done < synthProgress.total);
  const synthesizedCount = isSynthInProgress ? synthProgress!.done : segments.length;

  const htmlRef = useRef<HTMLDivElement | null>(null);
  const manualScrollRef = useRef(false);

  // スクロールエフェクトが合成進捗で再発火しないよう、最新値を ref 経由で読み取る
  const synthesizedCountRef = useRef(synthesizedCount);
  synthesizedCountRef.current = synthesizedCount;
  const isSynthInProgressRef = useRef(isSynthInProgress);
  isSynthInProgressRef.current = isSynthInProgress;
  // unsynth マーク更新エフェクトが再生位置で再発火しないよう、ref 経由で読み取る
  const segmentIndexForUnsynthRef = useRef(segmentIndex);
  segmentIndexForUnsynthRef.current = segmentIndex;

  // 記事ロード時にスキップ対象要素をマークし、TTS セグメント境界にブロック番号を付与（ブラウズ中は除外）
  useEffect(() => {
    const container = htmlRef.current;
    if (!container || !article.contentHtml || browsePage) return;
    markSkippedElements(container);
    injectBlockNumbers(container, segments);
    return () => { clearBlockNumbers(container); };
  // segments は article.contentHtml から派生するため、contentHtml の変化で十分
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.contentHtml, browsePage]);

  // Effect A: 再生位置（segmentIndex）の変化時のみハイライト＋スクロールを実行する。
  // isSynthInProgress / synthesizedCount は deps から除外し ref 経由で読むことで、
  // バックグラウンド合成の進捗によるスクロール再発火を防ぐ。
  useEffect(() => {
    const container = htmlRef.current;
    if (!container || !article.contentHtml || browsePage) {
      if (container) clearHighlights(container);
      return;
    }

    clearHighlights(container);

    if (!isActiveArticle || segmentIndex === null || isIdle) return;
    if (segmentIndex >= segments.length) return;

    if (isSynthInProgressRef.current) {
      markUnsynthSegments(container, segments, synthesizedCountRef.current);
    }

    const marks = applyHighlight(container, segments[segmentIndex]);
    if (marks.length > 0 && showFontSlider && autoScroll && !manualScrollRef.current) {
      marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
    manualScrollRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentIndex, isActiveArticle, isIdle, segments, article.contentHtml, showFontSlider, autoScroll, browsePage]);
  // NOTE: isSynthInProgress / synthesizedCount は意図的に除外。ref 経由で最新値を参照。

  // Effect B: 合成進捗（synthesizedCount）の変化時に unsynth マークのみ更新する。
  // segmentIndex は deps から除外し ref 経由で読むことで、再生位置変化との二重処理を防ぐ。
  // スクロールは行わない（再生追尾は Effect A が担う）。
  useEffect(() => {
    const container = htmlRef.current;
    if (!container || !article.contentHtml || browsePage) return;

    const idx = segmentIndexForUnsynthRef.current;
    if (!isActiveArticle || idx === null || isIdle) return;
    if (idx >= segments.length) return;

    clearHighlights(container);
    if (isSynthInProgress) {
      markUnsynthSegments(container, segments, synthesizedCount);
    }
    applyHighlight(container, segments[idx]);
    // スクロールなし
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSynthInProgress, synthesizedCount, isActiveArticle, isIdle, segments, article.contentHtml, browsePage]);
  // NOTE: segmentIndex は意図的に除外。ref 経由で最新値を参照。

  const spanRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (article.contentHtml) return;
    if (!isActiveArticle || segmentIndex === null) return;
    if (segmentIndex >= segments.length) return;

    const span = spanRefs.current[segmentIndex];
    if (!span) return;

    if (showFontSlider && autoScroll && !manualScrollRef.current) {
      span.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    manualScrollRef.current = false;
  }, [segmentIndex, isActiveArticle, segments.length, article.contentHtml, showFontSlider, autoScroll]);

  function handleHtmlClick(e: React.MouseEvent<HTMLDivElement>) {
    // リンククリックをインターセプトしてビューア内で開く
    const anchor = (e.target as Element).closest("a");
    if (anchor instanceof HTMLAnchorElement && anchor.href) {
      const href = anchor.href;
      if (href.startsWith("http://") || href.startsWith("https://")) {
        e.preventDefault();
        handleNavigateBrowse(href);
        return;
      }
    }

    // ブラウズ中はセグメントジャンプ無効
    if (!onSegmentClick || !htmlRef.current || browsePage) return;
    const idx = getClickedSegmentIndex(htmlRef.current, segments, e.clientX, e.clientY);
    if (idx === null) return;
    // 未合成セグメントはジャンプ不可
    if (isSynthInProgress && idx >= synthesizedCount) return;
    onSegmentClick(idx);
  }

  return (
    <>
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-alt)",
        overflow: "hidden",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...style,
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        {collapsible && (
          <button
            onClick={() => setCollapsed((v) => !v)}
            style={{
              flexShrink: 0,
              border: "none",
              background: "none",
              cursor: "pointer",
              fontSize: 12,
              padding: "0 4px",
              color: "var(--text-muted)",
              boxShadow: "none",
            }}
            aria-label={collapsed ? "展開" : "折りたたむ"}
            title={collapsed ? "展開" : "折りたたむ"}
          >
            {collapsed ? "▶" : "▼"}
          </button>
        )}
        <span
          style={{
            flex: 1,
            fontSize: 14,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            backgroundColor: isTitleActive ? "#ffe066" : undefined,
            color: isTitleActive ? "#111" : undefined,
            borderRadius: isTitleActive ? 2 : undefined,
            transition: "background-color 0.2s",
          }}
          title={title}
        >
          {title}
        </span>
        {!browsePage && article.language === "en" && (
          <span style={{ fontSize: 10, fontWeight: 700, color: "#0066cc", background: "#e8f0fe", borderRadius: 3, padding: "0 4px", flexShrink: 0, marginLeft: 4 }}>EN</span>
        )}
        {onClose && (
          <button
            onClick={onClose}
            style={{
              flexShrink: 0,
              border: "none",
              background: "none",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              color: "var(--text-muted)",
              padding: "0 4px",
              boxShadow: "none",
            }}
            aria-label="閉じる"
          >
            ×
          </button>
        )}
      </div>

      {/* 検索バー: ビューアタブ・テキストモード・展開時のみ表示 */}
      {showFontSlider && !collapsed && !browsePage && !browseLoading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface)",
            flexShrink: 0,
          }}
        >
          <div style={{ position: "relative", width: 260 }}>
            <input
              ref={searchInputRef}
              placeholder="Ctrl+F でテキスト検索…"
              value={localSearchText}
              onChange={(e) => {
                const text = e.target.value;
                setLocalSearchText(text);
                onSearchWordChange?.(text);
                if (text && isActiveArticle && !isIdle) setAutoScroll(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && totalMatches > 0) {
                  e.preventDefault();
                  if (e.shiftKey) {
                    setCurrentMatchIndex((i) => (i - 1 + totalMatches) % totalMatches);
                  } else {
                    setCurrentMatchIndex((i) => (i + 1) % totalMatches);
                  }
                }
              }}
              style={{ width: "100%", padding: "3px 28px 3px 8px", fontSize: 12, boxSizing: "border-box" }}
            />
            {localSearchText && (
              <button
                tabIndex={-1}
                onClick={() => { setLocalSearchText(""); setAppliedSearchWord(""); onSearchWordChange?.(""); }}
                style={{
                  position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--text-muted)", padding: "0 2px",
                  lineHeight: 1, boxShadow: "none", display: "inline-flex", alignItems: "center",
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {appliedSearchWord && totalMatches === 0 && (
            <span style={{ fontSize: 12, color: "var(--danger)", whiteSpace: "nowrap" }}>見つかりません</span>
          )}
          {appliedSearchWord && totalMatches > 0 && (
            <>
              <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                {currentMatchIndex + 1} / {totalMatches}
              </span>
              <button
                tabIndex={-1}
                onClick={() => setCurrentMatchIndex((i) => (i - 1 + totalMatches) % totalMatches)}
                title="前の一致箇所 (Shift+Enter)"
                style={{ padding: "2px 7px", lineHeight: 1, display: "inline-flex", alignItems: "center" }}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                tabIndex={-1}
                onClick={() => setCurrentMatchIndex((i) => (i + 1) % totalMatches)}
                title="次の一致箇所 (Enter)"
                style={{ padding: "2px 7px", lineHeight: 1, display: "inline-flex", alignItems: "center" }}
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
        </div>
      )}

      {/* ブラウズページ: iframe でフルレンダリング（折りたたみ時は非表示） */}
      {!collapsed && (browseLoading || browsePage) && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {browseLoading && (
            <p style={{ color: "var(--text-muted)", margin: "12px 14px" }}>ページを取得中... (数秒〜数十秒かかる場合があります)</p>
          )}
          {!browseLoading && browsePage && browsePage.srcdoc != null && (
            <iframe
              ref={iframeRef}
              srcDoc={browsePage.srcdoc}
              // allow-same-origin は付与しない: スクレイプした未知のページをアプリと同一オリジンで
              // 実行させないため（IPC・localStorage 等へのアクセスを遮断）。リンク傍受スクリプトは
              // allow-scripts のみで動作し postMessage はオリジンに依存しない。
              sandbox="allow-scripts allow-forms allow-popups"
              title={browsePage.title}
              style={{ flex: 1, border: "none", width: "100%", minHeight: 0 }}
            />
          )}
        </div>
      )}

      {/* 元記事コンテンツ（ブラウズ中は非表示・折りたたみ時は非表示） */}
      {!collapsed && !browseLoading && !browsePage && (
        <div
          onScroll={() => { manualScrollRef.current = true; }}
          onWheel={handleWheel}
          style={{
            flex: 1,
            padding: "12px 14px",
            overflowY: "auto",
            fontSize,
            lineHeight: 1.8,
            minHeight: 0,
          }}
        >
          {summaryMode && isActiveArticle && (
            <div style={{
              background: "rgba(0,102,204,0.08)", border: "1px solid rgba(0,102,204,0.2)",
              borderRadius: 6, padding: "6px 10px", marginBottom: 10, fontSize: 12,
              color: "var(--accent)", display: "flex", alignItems: "center", gap: 6,
            }}>
              🔑 要点モード: 重要文のみ読み上げます{article.contentHtml ? "" : "（薄く表示された文はスキップされます）"}
            </div>
          )}
          {isLoading && (
            <p style={{ color: "var(--text-muted)", margin: 0 }}>コンテンツを取得中です</p>
          )}
          {isError && (
            <p style={{ color: "var(--danger)", margin: 0 }}>
              {article.errorMessage ?? "コンテンツの取得に失敗しました"}
            </p>
          )}

          {/* HTML モード: 見出し・段落構造を保持。クリックでセグメントジャンプ */}
          {hasContent && article.contentHtml && (
            <div
              ref={htmlRef}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
              className="viewer-html-content"
              style={{
                lineHeight: 1.8,
                cursor: onSegmentClick ? "pointer" : "default",
              }}
              onClick={handleHtmlClick}
            />
          )}

          {/* プレーンテキストモード: 文単位スパン（ブロック表示＋番号付き） */}
          {hasContent && !article.contentHtml &&
            segments.map((seg, i) => {
              const isCurrent = isActiveArticle && !isIdle && segmentIndex === i;
              const isUnsynth = isActiveArticle && !isIdle && isSynthInProgress && i >= synthesizedCount;
              const isSearchMatch = searchMatchIndices.has(i);
              const isCurrentSearchMatch = isSearchMatch && i === currentSearchMatchSegIdx;
              // 要点モード: 重要文以外を dim 表示する（再生されない文だと分かるように）
              const isNonKey = summaryKeySet !== null && !summaryKeySet.has(i);
              return (
                <span
                  key={i}
                  ref={(el) => { spanRefs.current[i] = el; }}
                  onClick={isUnsynth ? undefined : () => onSegmentClick?.(i)}
                  style={{
                    display: "block",
                    position: "relative",
                    paddingLeft: "18px",
                    opacity: isNonKey && !isCurrent ? 0.4 : 1,
                    backgroundColor: isCurrent
                      ? "#ffe066"
                      : isUnsynth
                        ? "rgba(251, 146, 60, 0.22)"
                        : isCurrentSearchMatch
                          ? "#16a34a"
                          : isSearchMatch
                            ? "rgba(34, 197, 94, 0.18)"
                            : "transparent",
                    color: isCurrent ? "#111" : isCurrentSearchMatch ? "#fff" : undefined,
                    borderRadius: 2,
                    outline: isSearchMatch && !isCurrent ? "1px solid rgba(34, 197, 94, 0.4)" : undefined,
                    transition: "background-color 0.2s",
                    cursor: (onSegmentClick && !isUnsynth) ? "pointer" : "default",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      fontSize: "10px",
                      lineHeight: "inherit",
                      color: "var(--text-muted)",
                      userSelect: "none",
                      pointerEvents: "none",
                    }}
                  >
                    {i + 1}
                  </span>
                  {seg}
                </span>
              );
            })}
        </div>
      )}

      {/* フォントサイズスライダー (showFontSlider=true かつ展開時のみ) */}
      {showFontSlider && !collapsed && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--surface)",
            flexShrink: 0,
          }}
        >
          {onPlayNow && !browsePage && (
            <>
              <button
                onClick={onPlayNow}
                style={{
                  flexShrink: 0,
                  padding: "3px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  background: "var(--accent)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  boxShadow: "none",
                  lineHeight: "1.6",
                  display: "inline-flex", alignItems: "center", gap: 4,
                }}
              >
                <Play size={13} fill="currentColor" strokeWidth={0} /> すぐ再生
              </button>
              <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 2px", flexShrink: 0 }} />
            </>
          )}
          {/* テキスト / ウェブ 切り替えトグル */}
          <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden", flexShrink: 0 }}>
            <button
              onClick={() => { setBrowsePage(null); setBrowseCtxMenu(null); }}
              title="テキスト表示"
              style={{
                padding: "3px 10px",
                fontSize: 12,
                background: !browsePage ? "var(--accent)" : "none",
                color: !browsePage ? "#fff" : "var(--text-muted)",
                border: "none",
                borderRadius: 0,
                cursor: !browsePage ? "default" : "pointer",
                whiteSpace: "nowrap",
                boxShadow: "none",
                lineHeight: "1.6",
              }}
            >
              テキスト
            </button>
            <button
              onClick={() => handleNavigateBrowse(article.url)}
              title="元のウェブページを表示"
              style={{
                padding: "3px 10px",
                fontSize: 12,
                background: browsePage ? "var(--accent)" : "none",
                color: browsePage ? "#fff" : "var(--text-muted)",
                border: "none",
                borderLeft: "1px solid var(--border)",
                borderRadius: 0,
                cursor: browsePage ? "default" : "pointer",
                whiteSpace: "nowrap",
                boxShadow: "none",
                lineHeight: "1.6",
              }}
            >
              ウェブ
            </button>
          </div>
          {/* ⟳ 更新: テキスト表示時のみ表示 */}
          {!browsePage && onRefresh && (
            <button
              onClick={onRefresh}
              title="記事を再取得する"
              style={{
                flexShrink: 0,
                padding: "3px 10px",
                fontSize: 12,
                background: "none",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                cursor: "pointer",
                whiteSpace: "nowrap",
                boxShadow: "none",
                lineHeight: "1.6",
                display: "inline-flex", alignItems: "center", gap: 4,
              }}
            >
              <RotateCw size={12} /> 更新
            </button>
          )}
          {onToggleFavorite && (
            <button
              onClick={() => onToggleFavorite(article.id)}
              title={article.isFavorite ? "お気に入り解除" : "お気に入り登録"}
              style={{
                flexShrink: 0,
                background: "none",
                border: "none",
                boxShadow: "none",
                cursor: "pointer",
                color: article.isFavorite ? "var(--favorite)" : "var(--text-muted)",
                padding: "0 4px",
                lineHeight: 1,
                display: "inline-flex", alignItems: "center",
              }}
            >
              <Star size={18} fill={article.isFavorite ? "currentColor" : "none"} />
            </button>
          )}
          <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 2px", flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            文字サイズ
          </span>
          <input
            type="range"
            min={8}
            max={80}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            style={{ flex: 1, margin: 0 }}
          />
          <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 32, textAlign: "right" }}>
            {fontSize}px
          </span>
          <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 4px" }} />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              style={{ margin: 0, cursor: "pointer" }}
            />
            自動追尾
          </label>
        </div>
      )}
    </div>
    {browseCtxMenu && browsePage && (
      <BrowseContextMenu
        x={browseCtxMenu.x}
        y={browseCtxMenu.y}
        currentUrl={browsePage.url}
        linkHref={browseCtxMenu.linkHref}
        onClose={() => setBrowseCtxMenu(null)}
        onBack={() => { setBrowsePage(null); setBrowseCtxMenu(null); }}
      />
    )}
    </>
  );
}

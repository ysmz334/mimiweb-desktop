const BLOCK_TAGS = new Set([
  "p","h1","h2","h3","h4","h5","h6","li","blockquote","pre",
  "div","tr","td","th","dt","dd","figcaption","article","section",
  "header","footer","aside","main","address","figure",
]);

// 掲示板投稿メタデータとして識別する CSS クラス名
const BBS_META_CLASSES = new Set([
  "name", "date", "uid", "id", "trip", "author",
  "post-date", "post-time", "post-meta", "postmeta",
  "user-id", "userid", "username", "timestamp",
  "reshead", "res-head", "res_head",
]);

// 掲示板の投稿ヘッダー行に含まれる日時パターン: 2024/05/15(水) 12:34:56
const BBS_TIMESTAMP_RE = /\d{4}\/\d{1,2}\/\d{1,2}[（(][月火水木金土日][)）]\s*\d{1,2}:\d{2}:\d{2}/;

/**
 * HTML 文字列をブロック要素の境界で改行を挿入したプレーンテキストに変換する。
 * Readability の textContent（DOM textContent ベース）はブロック要素間の改行を含まないため、
 * この関数で contentHtml から正確な構造付きテキストを生成する。
 */
function htmlToText(html: string): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    function extract(node: Node): string {
      if (node.nodeType === Node.TEXT_NODE) {
        return (node.textContent ?? "").replace(/[ \t\r]+/g, " ");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "rp" || tag === "rb") return "";
      if (tag === "rt") return ""; // <ruby> で処理するためここでは無視
      if (tag === "ruby") {
        // <rt> の読みを漢字テキストの代わりに使用する
        const rt = el.querySelector("rt");
        if (rt) return (rt.textContent ?? "").replace(/[ \t\r]+/g, " ");
        // <rt> がない場合は <rp> 以外のノードだけ抽出
        return Array.from(el.childNodes)
          .filter(n => n.nodeType !== Node.ELEMENT_NODE || (n as Element).tagName.toLowerCase() !== "rp")
          .map(extract)
          .join("");
      }
      // 掲示板メタデータ系クラス（投稿者名・日時・ID 等）をスキップ
      if (Array.from(el.classList).some(c => BBS_META_CLASSES.has(c.toLowerCase()))) return "";
      if (tag === "br") return "\n";
      const inner = Array.from(node.childNodes).map(extract).join("");
      if (BLOCK_TAGS.has(tag)) {
        const trimmed = inner.trim();
        return trimmed ? trimmed + "\n" : "";
      }
      return inner;
    }

    return extract(doc.body).replace(/\n+/g, "\n").trim();
  } catch {
    return "";
  }
}

/**
 * TTS 用テキストから読み上げ不要な要素を除去する。
 * - URL（http/https）
 * - 掲示板投稿ヘッダー行（日時パターンを含む行ごと除去 → ハンドル名・ID も同時に除去）
 * - 残存する投稿 ID パターン（ID:XXXXXXXX）
 */
function cleanTtsText(text: string): string {
  return text
    .split("\n")
    .map(line => {
      // 掲示板投稿ヘッダー行（日時パターンを含む行）を丸ごと除去
      // → 同行にあるハンドル名・ID も一括で取り除かれる
      if (BBS_TIMESTAMP_RE.test(line)) return "";
      // URL を除去
      return line.replace(/https?:\/\/[^\s　、。！？「」【】〔〕]+/g, "");
    })
    .join("\n")
    // 行除去で取り切れなかった残存 ID パターンを除去
    .replace(/\bID:[A-Za-z0-9+/]{6,12}\b/g, "")
    // 余分な空白・連続改行を整理
    .replace(/[ \t　]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * HTML コンテンツ内の TTS スキップ対象要素に data-tts-skip 属性を付与する。
 * - BBS メタクラス要素（name / date / uid 等）
 * - 掲示板投稿ヘッダー行を含むブロック要素
 * htmlToText() のスキップロジックと対称になるよう維持すること。
 */
export function markSkippedElements(container: HTMLElement): void {
  BBS_META_CLASSES.forEach((cls) => {
    container.querySelectorAll(`.${CSS.escape(cls)}`).forEach((el) => {
      el.setAttribute("data-tts-skip", "");
    });
  });

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (BBS_TIMESTAMP_RE.test(node.textContent ?? "")) {
      let ancestor: Element | null = node.parentElement;
      while (ancestor && ancestor !== container) {
        if (BLOCK_TAGS.has(ancestor.tagName.toLowerCase())) {
          ancestor.setAttribute("data-tts-skip", "");
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }
    node = walker.nextNode() as Text | null;
  }
}

/**
 * タイトル + 本文を結合して読み上げ用テキストを構築する。
 * contentHtml が渡された場合はブロック要素の境界に改行を挿入したテキストを生成し、
 * 見出しと本文段落が独立した合成チャンクになるようにする。
 * Readability の textContent はタイトルを先頭に含む場合があるため重複を除去する。
 */
export function buildFullText(
  title: string | null,
  content: string | null,
  contentHtml?: string | null,
): string {
  const t = title ?? "";
  const extracted = contentHtml ? htmlToText(contentHtml) : "";
  const c = extracted || (content ?? "");
  const trimmed = c.trimStart();
  const body = t && trimmed.startsWith(t)
    ? trimmed.slice(t.length).replace(/^[\s\n。、]+/, "")
    : c;
  const fullText = t ? `${t}。${body}` : c;
  return cleanTtsText(fullText);
}

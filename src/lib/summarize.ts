import type { KeywordScore } from "@/shared/types";

/**
 * TF-IDF キーワードスコアを使って各文をスコアリングし、重要文のインデックス集合を返す。
 * 要点抽出（extractive summarization）に使用する。
 *
 * - スコア = 文中に出現するキーワードの TF-IDF スコア合計 ÷ √(文字数)
 *   （長文がスコアを独占しないよう文字数で正規化する）
 * - 上位 `ratio` 割合の文を選び、元の順序を保った Set として返す
 * - 先頭文（タイトル相当）は常に含める
 * - 3 文以下の短い記事は全文を返す（要約の意味がないため）
 */
export function selectKeySentenceIndices(
  sentences: string[],
  keywords: KeywordScore[],
  ratio = 0.35,
): Set<number> {
  const n = sentences.length;
  if (n <= 3) return new Set(sentences.map((_, i) => i));

  const scoreMap = new Map<string, number>();
  for (const k of keywords) {
    if (k.word) scoreMap.set(k.word.toLowerCase(), k.score);
  }

  const scored = sentences.map((s, i) => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const [w, sc] of scoreMap) {
      if (w.length > 0 && lower.includes(w)) score += sc;
    }
    const norm = Math.sqrt(Math.max(1, s.length));
    return { i, score: score / norm };
  });

  const count = Math.max(1, Math.round(n * ratio));
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, count);
  const keys = new Set(top.map((x) => x.i));
  keys.add(0); // 先頭文（タイトル）は常に含める
  return keys;
}

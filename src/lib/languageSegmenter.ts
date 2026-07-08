// 言語セグメンタ: フルテキストを言語ラベル付き文列へ分割する唯一の入口。
// ja/en 記事は既存 splitSentences へ委譲して分割結果を一切変えず（非退行の構造的担保）、
// mixed 記事のみ行単位の言語判定と文単位の個別判定を組み合わせる。

import { splitSentences } from "./voicevoxClient";
import type { ArticleLanguage } from "@/shared/types";

export type SentenceLang = "ja" | "en";
export type { ArticleLanguage };

export interface SentenceSegment {
  text: string;
  lang: SentenceLang;
}

/** 日本語文字（ひらがな・カタカナ・CJK漢字）率のしきい値。Rust detect_language と同一 */
export const JA_CHAR_RATIO_THRESHOLD = 0.05;

function isJapaneseChar(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  // ひらがな: U+3040–U+309F / カタカナ: U+30A0–U+30FF / CJK統合漢字: U+4E00–U+9FFF
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x4e00 && code <= 0x9fff);
}

/**
 * 文単位の言語判定。日本語文字率が 5% 以上なら "ja"、ASCII 英字を含めば "en"、
 * どちらも乏しい判定不能文（記号・数字のみ等）は fallback を返す。
 */
export function detectSentenceLang(text: string, fallback: SentenceLang = "ja"): SentenceLang {
  const chars = [...text];
  if (chars.length === 0) return fallback;

  const jaCount = chars.filter(isJapaneseChar).length;
  if (jaCount / chars.length >= JA_CHAR_RATIO_THRESHOLD) return "ja";
  if (/[A-Za-z]/.test(text)) return "en";
  return fallback;
}

/**
 * フルテキストを言語ラベル付き文列へ分割する。
 * - ja/en: splitSentences(fullText, lang) へ委譲し、全セグメントに記事言語をラベル付け
 * - mixed: 行単位で言語判定 → 行内をその言語の分割規則で文分割 → 各文を個別判定。
 *   判定不能な文は直前の文の言語を引き継ぐ（先頭は "ja"）
 */
export function segmentText(fullText: string, articleLanguage: ArticleLanguage): SentenceSegment[] {
  if (articleLanguage !== "mixed") {
    return splitSentences(fullText, articleLanguage).map((text) => ({
      text,
      lang: articleLanguage,
    }));
  }

  const segments: SentenceSegment[] = [];
  let prevLang: SentenceLang = "ja";

  for (const line of fullText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineLang = detectSentenceLang(trimmed, prevLang);
    for (const sentence of splitSentences(trimmed, lineLang)) {
      const lang = detectSentenceLang(sentence, prevLang);
      segments.push({ text: sentence, lang });
      prevLang = lang;
    }
  }

  return segments;
}

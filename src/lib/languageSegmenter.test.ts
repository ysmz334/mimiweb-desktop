import { describe, it, expect } from "vitest";
import { splitSentences } from "./voicevoxClient";
import {
  detectSentenceLang,
  segmentText,
  JA_CHAR_RATIO_THRESHOLD,
} from "./languageSegmenter";

describe("detectSentenceLang", () => {
  it("日本語文は 'ja' と判定する", () => {
    expect(detectSentenceLang("これは日本語の文です。")).toBe("ja");
  });

  it("英語文は 'en' と判定する", () => {
    expect(detectSentenceLang("This is an English sentence.")).toBe("en");
  });

  it("判定しきい値は Rust detect_language と同一（5%）", () => {
    expect(JA_CHAR_RATIO_THRESHOLD).toBe(0.05);
    // ちょうど 5%: 日本語1文字 + 英語19文字
    expect(detectSentenceLang("a".repeat(19) + "あ")).toBe("ja");
    // 5% 未満: 日本語1文字 + 英語20文字
    expect(detectSentenceLang("a".repeat(20) + "あ")).toBe("en");
  });

  it("記号・数字のみの文は fallback を返す（既定 'ja'）", () => {
    expect(detectSentenceLang("---")).toBe("ja");
    expect(detectSentenceLang("123 456")).toBe("ja");
    expect(detectSentenceLang("---", "en")).toBe("en");
    expect(detectSentenceLang("2.", "en")).toBe("en");
  });

  it("空文字列は fallback を返す", () => {
    expect(detectSentenceLang("")).toBe("ja");
    expect(detectSentenceLang("", "en")).toBe("en");
  });

  it("カタカナ固有名詞入りの英文は 'ja' に倒れる（許容仕様）", () => {
    // 日本語文字率が 5% を超えるため。VOICEVOX がカタカナ込みで読めるので実害は小さい
    expect(detectSentenceLang("I bought a new クルマ yesterday.")).toBe("ja");
  });
});

describe("segmentText — ja/en 委譲の互換性", () => {
  // 既存 splitSentences テストケース全件: 分割結果を一切変えないことを保証する
  const JA_CASES = [
    "これはテスト。次の文です。",
    "本当？それはすごい！",
    "Hello! World? OK.",
    "句読点なし",
    "",
    "  テスト。  次の文。  ",
    "見出し行\n本文の一文目。二文目です。",
  ];
  const EN_CASES = [
    "Hello world. This is a test.",
    "Great job! Well done!",
    "How are you? I am fine.",
    "First line.\nSecond sentence! Third?",
    "",
  ];

  it("articleLanguage='ja' では splitSentences(text, 'ja') と完全一致する", () => {
    for (const text of JA_CASES) {
      const segments = segmentText(text, "ja");
      expect(segments.map((s) => s.text)).toEqual(splitSentences(text, "ja"));
      expect(segments.every((s) => s.lang === "ja")).toBe(true);
    }
  });

  it("articleLanguage='en' では splitSentences(text, 'en') と完全一致する", () => {
    for (const text of EN_CASES) {
      const segments = segmentText(text, "en");
      expect(segments.map((s) => s.text)).toEqual(splitSentences(text, "en"));
      expect(segments.every((s) => s.lang === "en")).toBe(true);
    }
  });
});

describe("segmentText — mixed（対訳スクリプト3形式）", () => {
  it("交互形式: 日本語行と英語行が交互のとき言語ラベルが交互になる", () => {
    const text =
      "私は毎朝コーヒーを飲みます。\n" +
      "I drink coffee every morning.\n" +
      "今日は天気がいいですね。\n" +
      "The weather is nice today.";
    expect(segmentText(text, "mixed")).toEqual([
      { text: "私は毎朝コーヒーを飲みます。", lang: "ja" },
      { text: "I drink coffee every morning.", lang: "en" },
      { text: "今日は天気がいいですね。", lang: "ja" },
      { text: "The weather is nice today.", lang: "en" },
    ]);
  });

  it("番号付き形式: 行頭の番号があっても各行の言語で分割・ラベル付けされる", () => {
    const text =
      "1. 私は毎朝コーヒーを飲みます。\n" +
      "1. I drink coffee every morning.\n" +
      "2. 今日は天気がいいですね。\n" +
      "2. The weather is nice today.";
    const segments = segmentText(text, "mixed");
    // 日本語行の番号は句点分割で行内に残る。英語行の番号 "1." は既存の英語分割規則で
    // 独立セグメントになり、判定不能のため直前の文の言語を引き継ぐ
    expect(segments.map((s) => s.text)).toEqual([
      "1. 私は毎朝コーヒーを飲みます。",
      "1.",
      "I drink coffee every morning.",
      "2. 今日は天気がいいですね。",
      "2.",
      "The weather is nice today.",
    ]);
    expect(segments.map((s) => s.lang)).toEqual(["ja", "ja", "en", "ja", "ja", "en"]);
  });

  it("段落形式: 段落内の複数文がその言語の分割規則で文分割される", () => {
    const text =
      "私は毎朝コーヒーを飲みます。今日は天気がいいですね。\n" +
      "\n" +
      "I drink coffee every morning. The weather is nice today.";
    expect(segmentText(text, "mixed")).toEqual([
      { text: "私は毎朝コーヒーを飲みます。", lang: "ja" },
      { text: "今日は天気がいいですね。", lang: "ja" },
      { text: "I drink coffee every morning.", lang: "en" },
      { text: "The weather is nice today.", lang: "en" },
    ]);
  });

  it("判定不能な文は直前の文の言語を引き継ぐ", () => {
    const text = "I drink coffee every morning.\n---\n今日は天気がいいですね。";
    expect(segmentText(text, "mixed")).toEqual([
      { text: "I drink coffee every morning.", lang: "en" },
      { text: "---", lang: "en" },
      { text: "今日は天気がいいですね。", lang: "ja" },
    ]);
  });

  it("先頭の判定不能な文は 'ja' になる", () => {
    const text = "***\nHello world.";
    expect(segmentText(text, "mixed")).toEqual([
      { text: "***", lang: "ja" },
      { text: "Hello world.", lang: "en" },
    ]);
  });

  it("空行を挟んでも空文セグメントを含まない", () => {
    const text = "日本語の文。\n\n\nEnglish sentence.\n  \n";
    const segments = segmentText(text, "mixed");
    expect(segments.map((s) => s.text)).toEqual(["日本語の文。", "English sentence."]);
    expect(segments.every((s) => s.text.length > 0)).toBe(true);
  });

  it("空文字列は空配列を返す", () => {
    expect(segmentText("", "mixed")).toEqual([]);
  });
});

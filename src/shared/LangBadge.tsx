import type { ArticleLanguage } from "@/shared/types";

/**
 * 記事言語バッジ: en → "EN"（従来のまま）、mixed → "JA·EN"（EN と区別できる日英バッジ）。
 * ja はバッジなし。スタイルは既存 EN バッジを踏襲。
 */
export function LangBadge({ language }: { language: ArticleLanguage }) {
  if (language !== "en" && language !== "mixed") return null;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: "var(--accent, #0066cc)",
        background: "#e8f0fe",
        borderRadius: 3,
        padding: "0 4px",
        flexShrink: 0,
      }}
    >
      {language === "en" ? "EN" : "JA·EN"}
    </span>
  );
}

import { TriangleAlert } from "lucide-react";
import type { ArticleLanguage } from "@/shared/types";

/**
 * Piper 未導入時のフォールバック警告バッジ（⚠）。
 * 英語文を含む記事（en / mixed）にのみ表示し、可用性が未解決（null）の間は出さない。
 */
export function FallbackBadge({
  language,
  piperInstalled,
  size = 13,
}: {
  language: ArticleLanguage;
  piperInstalled: boolean | null | undefined;
  size?: number;
}) {
  if (piperInstalled !== false) return null;
  if (language !== "en" && language !== "mixed") return null;
  return (
    <span
      title="英語文は日本語音声で代読されます（Piper 未導入）"
      style={{
        color: "var(--warning)",
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      <TriangleAlert size={size} />
    </span>
  );
}

import { FileText } from "lucide-react";
import { Favicon } from "./Favicon";
import type { ArticleSourceType } from "@/shared/types";

/**
 * 記事種別アイコン: テキスト記事は favicon 取得を行わず FileText を同寸で表示し、
 * web 記事は従来の favicon を表示する（レイアウト維持のため寸法は共通）。
 */
export function SourceIcon({
  url,
  sourceType,
  size = 14,
}: {
  url: string;
  sourceType?: ArticleSourceType;
  size?: number;
}) {
  if (sourceType === "text") {
    return (
      <span
        title="テキスト記事"
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
        }}
      >
        <FileText size={size} />
      </span>
    );
  }
  return <Favicon url={url} size={size} />;
}

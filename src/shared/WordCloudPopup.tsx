import { WordCloud } from "./WordCloud";
import type { KeywordScore } from "./types";

const W = 340;
const H = 240;
const MARGIN = 12;

export function WordCloudPopup({
  title,
  pos,
  keywords,
  loading,
}: {
  title: string | null;
  pos: { x: number; y: number };
  keywords: KeywordScore[] | null;
  loading: boolean;
}) {
  let left = pos.x + 18;
  let top = pos.y - H / 2;

  if (left + W > window.innerWidth - MARGIN) left = pos.x - W - 18;
  top = Math.max(MARGIN, Math.min(top, window.innerHeight - H - MARGIN));

  return (
    <div
      style={{
        position: "fixed",
        left,
        top,
        width: W,
        background: "var(--surface, #fff)",
        border: "1px solid var(--border, #ddd)",
        borderRadius: 8,
        padding: "10px 12px 12px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {title && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted, #888)",
            marginBottom: 6,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
      )}
      {loading ? (
        <div
          style={{
            height: H - 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted, #888)",
            fontSize: 13,
          }}
        >
          分析中…
        </div>
      ) : !keywords || keywords.length === 0 ? (
        <div
          style={{
            height: H - 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted, #888)",
            fontSize: 13,
          }}
        >
          キーワードなし
        </div>
      ) : (
        <WordCloud
          words={keywords.map((k) => ({ text: k.word, value: k.score }))}
          width={316}
          height={H - 30}
        />
      )}
    </div>
  );
}

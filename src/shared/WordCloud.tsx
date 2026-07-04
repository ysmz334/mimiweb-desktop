import cloud from "d3-cloud";
import { memo, useEffect, useState } from "react";

interface ComputedWord {
  text?: string;
  x?: number;
  y?: number;
  rotate?: number;
  size?: number;
}

const COLORS = [
  "#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c",
  "#0891b2", "#65a30d", "#db2777", "#7c3aed", "#0d9488",
  "#b45309", "#1d4ed8", "#15803d", "#b91c1c", "#7e22ce",
];

export const WordCloud = memo(function WordCloud({
  words,
  width = 316,
  height = 200,
  onWordClick,
}: {
  words: { text: string; value: number }[];
  width?: number;
  height?: number;
  onWordClick?: (word: string) => void;
}) {
  const [computed, setComputed] = useState<ComputedWord[]>([]);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (words.length === 0) {
      setComputed([]);
      return;
    }

    const maxVal = Math.max(...words.map((w) => w.value));
    const minVal = Math.min(...words.map((w) => w.value));
    const range = maxVal - minVal || 1;

    const sizedWords = words.slice(0, 60).map((w) => ({
      text: w.text,
      size: Math.round(11 + ((w.value - minVal) / range) * 26),
      value: w.value,
    }));

    cloud<{ text: string; size: number; value: number }>()
      .size([width, height])
      .words(sizedWords)
      .padding(2)
      .rotate(() => (Math.random() > 0.8 ? 90 : 0))
      .font('"Hiragino Sans", "Noto Sans JP", system-ui, sans-serif')
      .fontSize((d) => d.size)
      .on("end", (result) => {
        if (!cancelled) setComputed(result);
      })
      .start();

    return () => {
      cancelled = true;
    };
  }, [words, width, height]);

  return (
    <>
      <svg width={width} height={height} style={{ display: "block" }}>
        <g transform={`translate(${width / 2},${height / 2})`}>
          {computed.map((w, i) => (
            <text
              key={w.text}
              style={{
                fontSize: `${w.size}px`,
                fontFamily:
                  '"Hiragino Sans", "Noto Sans JP", system-ui, sans-serif',
                fill: COLORS[i % COLORS.length],
                userSelect: "none",
                cursor: onWordClick ? "pointer" : "default",
                opacity: tooltip && tooltip.text !== w.text ? 0.65 : 1,
                transition: "opacity 0.1s",
              }}
              textAnchor="middle"
              transform={`translate(${w.x ?? 0},${w.y ?? 0})rotate(${w.rotate ?? 0})`}
              onClick={onWordClick && w.text ? () => onWordClick(w.text!) : undefined}
              onMouseEnter={(e) => w.text && setTooltip({ text: w.text, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setTooltip(null)}
            >
              {w.text}
            </text>
          ))}
        </g>
      </svg>

      {tooltip && (
        <div
          style={{
            position: "fixed",
            top: tooltip.y - 36,
            left: tooltip.x,
            transform: "translateX(-50%)",
            background: "rgba(10,10,10,0.88)",
            color: "#f0f0f0",
            padding: "4px 10px",
            borderRadius: 5,
            fontSize: 12,
            whiteSpace: "nowrap",
            zIndex: 9999,
            pointerEvents: "none",
            lineHeight: 1.5,
            textAlign: "center",
          }}
        >
          {tooltip.text}
          {onWordClick && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>
              クリックして検索
            </div>
          )}
        </div>
      )}
    </>
  );
});

import { useState } from "react";
import { registerTextArticle } from "@/lib/tauriCommands";
import type { Article, ArticleError } from "@/shared/types";

function textErrorMessage(e: ArticleError): string {
  if (e.type === "empty_content") return "本文を入力してください";
  if (e.type === "database_error") return `エラー: ${e.message}`;
  return "登録に失敗しました";
}

/** テキスト記事の登録フォーム（登録エリアで UrlForm と切替表示される） */
export function TextForm({ onAdded }: { onAdded: (article: Article) => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = content.trim().length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setFieldError(null);
    setSubmitting(true);
    const result = await registerTextArticle(content, title.trim() || undefined);
    setSubmitting(false);

    if (result.ok) {
      onAdded(result.value);
      setTitle("");
      setContent("");
    } else {
      setFieldError(textErrorMessage(result.error));
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="タイトル（省略時は本文の先頭行）"
        style={{ padding: "6px 10px" }}
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="読み上げるテキストを貼り付け"
        rows={6}
        style={{ padding: "6px 10px", resize: "vertical", fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="submit" disabled={!canSubmit}>
          {submitting ? "登録中…" : "登録"}
        </button>
        {fieldError && (
          <span style={{ color: "var(--danger, #c00)", fontSize: 13 }}>{fieldError}</span>
        )}
      </div>
    </form>
  );
}

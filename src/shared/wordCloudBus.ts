export type BusEvent =
  | { type: "article"; articleId: number; title: string | null; url: string | null }
  | { type: "date"; date: string; articleIds: number[]; label: string };

type Listener = (event: BusEvent) => void;

const listeners = new Set<Listener>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export const wordCloudBus = {
  /** 記事ホバー開始（350ms デバウンス後に通知） */
  hover(articleId: number, title: string | null, url: string | null = null): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      listeners.forEach((l) => l({ type: "article", articleId, title, url }));
    }, 350);
  },

  /** デバウンスなしで即座に通知（ビューアタブ切り替え時など） */
  showNow(articleId: number, title: string | null, url: string | null = null): void {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    listeners.forEach((l) => l({ type: "article", articleId, title, url }));
  },

  /** 日付ホバー開始（その日に再生した全記事のキーワードを集約、350ms デバウンス） */
  hoverDate(date: string, articleIds: number[], label: string): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      listeners.forEach((l) => l({ type: "date", date, articleIds, label }));
    }, 350);
  },

  /** ホバー離脱（タイマーをキャンセルするだけ。表示は維持） */
  cancelPending(): void {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

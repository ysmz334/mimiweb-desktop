import { useState, useEffect, useCallback } from "react";
import { checkPiperInstalled } from "@/lib/tauriCommands";

/**
 * Piper 可用性の単一判定点。App が保持し、再生系（usePlayback）と各パネル
 * （バッジ・ルーティング・トースト）へ同一の状態として供給する。
 *
 * - null = チェック未解決（起動直後）。解決までフォールバック警告は表示しない
 * - 更新経路: 起動時（マウント時）に取得。セットアップ画面完了時は AppMain が
 *   再マウントされるため同経路でカバーされる。設定タブでのインストール成功時は
 *   SettingsPanel の onPiperInstalled コールバック経由で refreshPiperInstalled() を呼ぶ
 */
export function usePiperInstalled() {
  const [piperInstalled, setPiperInstalled] = useState<boolean | null>(null);

  const refreshPiperInstalled = useCallback(async () => {
    try {
      setPiperInstalled(await checkPiperInstalled());
    } catch {
      setPiperInstalled(false);
    }
  }, []);

  useEffect(() => {
    void refreshPiperInstalled();
  }, [refreshPiperInstalled]);

  return { piperInstalled, refreshPiperInstalled };
}

import { useState, useEffect, useCallback } from "react";
import {
  getSettings,
  updateSettings,
  getVoicevoxStatus,
  retryVoicevoxConnection,
  onVoicevoxStatusChanged,
} from "@/lib/tauriCommands";
import type { Settings, Speaker, VoicevoxStatus } from "@/shared/types";
import { VoicevoxClient } from "@/lib/voicevoxClient";

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [voicevoxStatus, setVoicevoxStatus] = useState<VoicevoxStatus>({ state: "starting" });
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [saving, setSaving] = useState(false);

  // 設定・ステータス初期読み込み
  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
    getVoicevoxStatus().then(setVoicevoxStatus).catch(() => {});
  }, []);

  // Voicevox ステータスイベントをリッスン
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onVoicevoxStatusChanged(setVoicevoxStatus).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // エンジンが ready になったら話者一覧を取得
  useEffect(() => {
    if (voicevoxStatus.state !== "ready") return;
    const client = new VoicevoxClient(voicevoxStatus.port);
    client.getSpeakers().then(setSpeakers).catch(() => {});
  }, [voicevoxStatus]);

  const update = useCallback(async (partial: Partial<Settings>) => {
    if (!settings) return;
    setSaving(true);
    try {
      await updateSettings(partial);
      setSettings((prev) => prev ? { ...prev, ...partial } : prev);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const retryConnection = useCallback(async () => {
    const status = await retryVoicevoxConnection();
    setVoicevoxStatus(status);
  }, []);

  return { settings, voicevoxStatus, speakers, saving, update, retryConnection };
}

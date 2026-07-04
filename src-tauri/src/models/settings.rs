use serde::{Deserialize, Serialize};
use thiserror::Error;

// ─── データモデル ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub voicevox_speaker_id: i64,
    pub voicevox_port: i64,
    pub playback_speed: f64,
    pub mp3_bitrate: i64,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PartialSettings {
    pub voicevox_speaker_id: Option<i64>,
    pub voicevox_port: Option<i64>,
    pub playback_speed: Option<f64>,
    pub mp3_bitrate: Option<i64>,
}

// ─── コマンドエラー ────────────────────────────────────────────────────────

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SettingsError {
    #[error("Database error: {message}")]
    DatabaseError { message: String },
}

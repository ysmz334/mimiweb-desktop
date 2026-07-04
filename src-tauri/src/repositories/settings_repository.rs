use sqlx::SqlitePool;
use thiserror::Error;

use crate::models::settings::{PartialSettings, Settings};

// ─── リポジトリエラー ─────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum SettingsRepoError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

// ─── SettingsRepository ───────────────────────────────────────────────────

pub struct SettingsRepository {
    pool: SqlitePool,
}

impl SettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>, SettingsRepoError> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(value)
    }

    pub async fn set(&self, key: &str, value: &str) -> Result<(), SettingsRepoError> {
        sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_all(&self) -> Result<Settings, SettingsRepoError> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT key, value FROM settings")
                .fetch_all(&self.pool)
                .await?;

        let get = |k: &str| -> &str {
            rows.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
                .unwrap_or("")
        };

        Ok(Settings {
            voicevox_speaker_id: get("voicevox_speaker_id").parse().unwrap_or(3),
            voicevox_port: get("voicevox_port").parse().unwrap_or(50021),
            playback_speed: get("playback_speed").parse().unwrap_or(1.0),
            mp3_bitrate: get("mp3_bitrate").parse().unwrap_or(128),
        })
    }

    pub async fn apply_partial(&self, partial: &PartialSettings) -> Result<Settings, SettingsRepoError> {
        if let Some(v) = partial.voicevox_speaker_id {
            self.set("voicevox_speaker_id", &v.to_string()).await?;
        }
        if let Some(v) = partial.voicevox_port {
            self.set("voicevox_port", &v.to_string()).await?;
        }
        if let Some(v) = partial.playback_speed {
            self.set("playback_speed", &v.to_string()).await?;
        }
        if let Some(v) = partial.mp3_bitrate {
            self.set("mp3_bitrate", &v.to_string()).await?;
        }
        self.get_all().await
    }
}

// ─── テスト ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::setup_test_db;

    async fn repo() -> SettingsRepository {
        SettingsRepository::new(setup_test_db().await)
    }

    #[tokio::test]
    async fn get_all_returns_seed_defaults() {
        let r = repo().await;
        let s = r.get_all().await.unwrap();

        assert_eq!(s.voicevox_speaker_id, 3);
        assert_eq!(s.voicevox_port, 50021);
        assert!((s.playback_speed - 1.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn set_and_get_persists_value() {
        let r = repo().await;
        r.set("voicevox_speaker_id", "10").await.unwrap();

        let value = r.get("voicevox_speaker_id").await.unwrap();
        assert_eq!(value.as_deref(), Some("10"));
    }

    #[tokio::test]
    async fn apply_partial_updates_only_specified_fields() {
        let r = repo().await;
        let updated = r
            .apply_partial(&PartialSettings {
                voicevox_speaker_id: Some(7),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(updated.voicevox_speaker_id, 7);
        assert_eq!(updated.voicevox_port, 50021); // 変更なし
        assert!((updated.playback_speed - 1.0).abs() < f64::EPSILON); // 変更なし
    }

    #[tokio::test]
    async fn apply_partial_updates_multiple_fields() {
        let r = repo().await;
        let updated = r
            .apply_partial(&PartialSettings {
                playback_speed: Some(1.5),
                voicevox_port: Some(50022),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!((updated.playback_speed - 1.5).abs() < f64::EPSILON);
        assert_eq!(updated.voicevox_port, 50022);
    }
}

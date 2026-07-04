use std::sync::Arc;
use sqlx::SqlitePool;

use crate::{
    repositories::{ArticleRepository, HistoryRepository, QueueRepository, SettingsRepository},
    services::VoicevoxManager,
};

pub struct AppState {
    db: SqlitePool,
    pub voicevox: Arc<VoicevoxManager>,
}

impl AppState {
    pub fn new(db: SqlitePool, voicevox: Arc<VoicevoxManager>) -> Self {
        Self { db, voicevox }
    }

    pub fn article_repo(&self) -> ArticleRepository {
        ArticleRepository::new(self.db.clone())
    }

    pub fn queue_repo(&self) -> QueueRepository {
        QueueRepository::new(self.db.clone())
    }

    pub fn history_repo(&self) -> HistoryRepository {
        HistoryRepository::new(self.db.clone())
    }

    pub fn settings_repo(&self) -> SettingsRepository {
        SettingsRepository::new(self.db.clone())
    }

    pub fn db(&self) -> &SqlitePool {
        &self.db
    }
}

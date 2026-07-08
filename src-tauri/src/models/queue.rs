use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::article::Article;

// ─── データモデル ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: i64,
    pub article_id: i64,
    pub position: i64,
    pub added_at: String,
    pub article: Article,
}

// JOIN クエリ結果を平坦に受け取るための内部型
#[derive(sqlx::FromRow)]
pub struct QueueJoinRow {
    pub id: i64,
    pub article_id: i64,
    pub position: i64,
    pub added_at: String,
    // articles カラム
    pub url: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub content_html: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub registered_at: String,
    pub extracted_at: Option<String>,
    pub is_favorite: bool,
    pub language: String,
    pub source_type: String,
}

impl From<QueueJoinRow> for QueueItem {
    fn from(row: QueueJoinRow) -> Self {
        QueueItem {
            id: row.id,
            article_id: row.article_id,
            position: row.position,
            added_at: row.added_at.clone(),
            article: Article {
                id: row.article_id,
                url: row.url,
                title: row.title,
                content: row.content,
                content_html: row.content_html,
                status: row.status,
                error_message: row.error_message,
                registered_at: row.registered_at,
                extracted_at: row.extracted_at,
                is_favorite: row.is_favorite,
                language: row.language,
                source_type: row.source_type,
            },
        }
    }
}

// ─── コマンドエラー ────────────────────────────────────────────────────────

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QueueError {
    #[error("Article not found")]
    ArticleNotFound,
    #[error("Queue item not found")]
    ItemNotFound,
    #[error("Article is already in queue")]
    AlreadyQueued,
    #[error("Database error: {message}")]
    DatabaseError { message: String },
}

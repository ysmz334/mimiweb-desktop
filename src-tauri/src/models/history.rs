use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::article::Article;

// ─── データモデル ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackHistory {
    pub id: i64,
    pub article_id: Option<i64>,
    pub started_at: Option<String>,
    pub completed_at: String,
    pub duration_seconds: i64,
    pub last_sentence_index: Option<i64>,
    pub sentence_count: Option<i64>,
    pub article: Option<Article>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStats {
    pub date: String,
    pub count: i64,
    pub total_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_played: i64,
    pub total_seconds: i64,
    pub daily_breakdown: Vec<DailyStats>,
}

// JOIN クエリ結果を平坦に受け取る内部型
#[derive(sqlx::FromRow)]
pub struct HistoryJoinRow {
    pub id: i64,
    pub article_id: Option<i64>,
    pub started_at: Option<String>,
    pub completed_at: String,
    pub duration_seconds: i64,
    pub last_sentence_index: Option<i64>,
    pub sentence_count: Option<i64>,
    // LEFT JOIN の nullable フィールド
    pub url: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub content_html: Option<String>,
    pub status: Option<String>,
    pub error_message: Option<String>,
    pub registered_at: Option<String>,
    pub extracted_at: Option<String>,
    pub is_favorite: Option<bool>,
    pub language: Option<String>,
    pub source_type: Option<String>,
}

impl From<HistoryJoinRow> for PlaybackHistory {
    fn from(row: HistoryJoinRow) -> Self {
        let article = match (&row.url, &row.status, &row.registered_at) {
            (Some(url), Some(status), Some(registered_at)) => Some(Article {
                id: row.article_id.unwrap_or(0),
                url: url.clone(),
                title: row.title.clone(),
                content: row.content.clone(),
                content_html: row.content_html.clone(),
                status: status.clone(),
                error_message: row.error_message.clone(),
                registered_at: registered_at.clone(),
                extracted_at: row.extracted_at.clone(),
                is_favorite: row.is_favorite.unwrap_or(false),
                language: row.language.clone().unwrap_or_else(|| "ja".to_string()),
                source_type: row.source_type.clone().unwrap_or_else(|| "web".to_string()),
            }),
            _ => None,
        };
        PlaybackHistory {
            id: row.id,
            article_id: row.article_id,
            started_at: row.started_at,
            completed_at: row.completed_at,
            duration_seconds: row.duration_seconds,
            last_sentence_index: row.last_sentence_index,
            sentence_count: row.sentence_count,
            article,
        }
    }
}

// ─── フィルタ ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    pub search: Option<String>,
    /// "title" | "content" | "url" | "all"（省略時は "all"）
    pub search_target: Option<String>,
    pub from_date: Option<String>,
    pub to_date: Option<String>,
}

// ─── コマンドエラー ────────────────────────────────────────────────────────

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HistoryError {
    #[error("Database error: {message}")]
    DatabaseError { message: String },
}

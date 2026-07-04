use serde::{Deserialize, Serialize};
use thiserror::Error;

// ─── データモデル ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: i64,
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
}

// ─── フィルタ ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArticleFilter {
    pub status: Option<String>,
    pub search: Option<String>,
    /// "title" | "content" | "url" | "all"（省略時は "all"）
    pub search_target: Option<String>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
    pub is_favorite: Option<bool>,
}

// ─── コマンドエラー（フロントエンドの ArticleError に対応） ──────────────

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArticleError {
    #[error("Duplicate URL")]
    DuplicateUrl,
    #[error("Article not found")]
    NotFound,
    #[error("Invalid URL: {message}")]
    InvalidUrl { message: String },
    #[error("Database error: {message}")]
    DatabaseError { message: String },
}

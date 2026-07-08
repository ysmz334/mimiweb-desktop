use chrono::Utc;
use sqlx::SqlitePool;
use thiserror::Error;

use crate::models::article::{Article, ArticleFilter};

// ─── リポジトリエラー ─────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum RepositoryError {
    #[error("Article not found: {0}")]
    NotFound(i64),
    #[error("Duplicate URL")]
    DuplicateUrl,
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

// ─── ArticleRepository ────────────────────────────────────────────────────

pub struct ArticleRepository {
    pool: SqlitePool,
}

impl ArticleRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn insert(&self, url: &str) -> Result<Article, RepositoryError> {
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES (?, 'pending', ?)",
        )
        .bind(url)
        .bind(&now)
        .execute(&self.pool)
        .await;

        match result {
            Ok(r) => self.get_by_id(r.last_insert_rowid()).await,
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                Err(RepositoryError::DuplicateUrl)
            }
            Err(e) => Err(RepositoryError::Database(e)),
        }
    }

    /// テキスト記事を登録する。抽出工程を経ないため status='ready'・extracted_at=now で
    /// 単発 INSERT する。content_html は持たない（プレーンテキスト表示経路を使用）。
    pub async fn insert_text(
        &self,
        url: &str,
        title: &str,
        content: &str,
        language: &str,
    ) -> Result<Article, RepositoryError> {
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            "INSERT INTO articles (url, title, content, status, registered_at, extracted_at, language, source_type)
             VALUES (?, ?, ?, 'ready', ?, ?, ?, 'text')",
        )
        .bind(url)
        .bind(title)
        .bind(content)
        .bind(&now)
        .bind(&now)
        .bind(language)
        .execute(&self.pool)
        .await;

        match result {
            Ok(r) => self.get_by_id(r.last_insert_rowid()).await,
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                Err(RepositoryError::DuplicateUrl)
            }
            Err(e) => Err(RepositoryError::Database(e)),
        }
    }

    /// テキスト記事の本文・タイトル・言語を更新する。source_type の検証は呼び出し側で行う。
    pub async fn update_text_content(
        &self,
        id: i64,
        title: &str,
        content: &str,
        language: &str,
    ) -> Result<Article, RepositoryError> {
        let now = Utc::now().to_rfc3339();
        let rows = sqlx::query(
            "UPDATE articles SET title = ?, content = ?, language = ?, extracted_at = ? WHERE id = ?",
        )
        .bind(title)
        .bind(content)
        .bind(language)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();

        if rows == 0 {
            return Err(RepositoryError::NotFound(id));
        }
        self.get_by_id(id).await
    }

    pub async fn get_by_id(&self, id: i64) -> Result<Article, RepositoryError> {
        sqlx::query_as::<_, Article>("SELECT * FROM articles WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(RepositoryError::NotFound(id))
    }

    /// ステータスのみ更新する。
    pub async fn update_status(&self, id: i64, status: &str) -> Result<Article, RepositoryError> {
        let rows = sqlx::query("UPDATE articles SET status = ? WHERE id = ?")
            .bind(status)
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();

        if rows == 0 {
            return Err(RepositoryError::NotFound(id));
        }
        self.get_by_id(id).await
    }

    /// 抽出コンテンツを保存して status を 'ready' にする。
    pub async fn save_content(
        &self,
        id: i64,
        title: Option<&str>,
        content: &str,
        content_html: Option<&str>,
        language: &str,
    ) -> Result<Article, RepositoryError> {
        let now = Utc::now().to_rfc3339();
        let rows = sqlx::query(
            "UPDATE articles
             SET status = 'ready', title = ?, content = ?, content_html = ?, extracted_at = ?, error_message = NULL, language = ?
             WHERE id = ?",
        )
        .bind(title)
        .bind(content)
        .bind(content_html)
        .bind(&now)
        .bind(language)
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();

        if rows == 0 {
            return Err(RepositoryError::NotFound(id));
        }
        self.get_by_id(id).await
    }

    /// 抽出エラーを記録して status を 'error' にする。
    pub async fn mark_error(
        &self,
        id: i64,
        error_message: &str,
    ) -> Result<Article, RepositoryError> {
        let rows = sqlx::query(
            "UPDATE articles SET status = 'error', error_message = ? WHERE id = ?",
        )
        .bind(error_message)
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();

        if rows == 0 {
            return Err(RepositoryError::NotFound(id));
        }
        self.get_by_id(id).await
    }

    pub async fn toggle_favorite(&self, id: i64) -> Result<Article, RepositoryError> {
        let rows = sqlx::query(
            "UPDATE articles SET is_favorite = NOT is_favorite WHERE id = ?",
        )
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();

        if rows == 0 {
            return Err(RepositoryError::NotFound(id));
        }
        self.get_by_id(id).await
    }

    pub async fn delete(&self, id: i64) -> Result<(), RepositoryError> {
        let rows = sqlx::query("DELETE FROM articles WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();

        if rows == 0 {
            return Err(RepositoryError::NotFound(id));
        }
        Ok(())
    }

    pub async fn list(&self, filter: &ArticleFilter) -> Result<Vec<Article>, RepositoryError> {
        let mut qb =
            sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT * FROM articles WHERE 1=1");

        if let Some(ref status) = filter.status {
            qb.push(" AND status = ");
            qb.push_bind(status.as_str());
        }

        if let Some(ref search) = filter.search {
            let pattern = format!("%{}%", search);
            match filter.search_target.as_deref().unwrap_or("all") {
                "title" => {
                    qb.push(" AND title LIKE ");
                    qb.push_bind(pattern);
                }
                "content" => {
                    qb.push(" AND content LIKE ");
                    qb.push_bind(pattern);
                }
                // URL 検索はプレースホルダ URL（text://）を持つテキスト記事を除外する
                "url" => {
                    qb.push(" AND (url LIKE ");
                    qb.push_bind(pattern);
                    qb.push(" AND source_type = 'web')");
                }
                _ => {
                    qb.push(" AND (title LIKE ");
                    qb.push_bind(pattern.clone());
                    qb.push(" OR content LIKE ");
                    qb.push_bind(pattern.clone());
                    qb.push(" OR (url LIKE ");
                    qb.push_bind(pattern);
                    qb.push(" AND source_type = 'web'))");
                }
            }
        }

        if let Some(fav) = filter.is_favorite {
            qb.push(" AND is_favorite = ");
            qb.push_bind(fav as i64);
        }

        let sort_col = match filter.sort_by.as_deref() {
            Some("title") => "title",
            _ => "registered_at",
        };
        let sort_dir = match filter.sort_order.as_deref() {
            Some("asc") => "ASC",
            _ => "DESC",
        };
        qb.push(format!(" ORDER BY {sort_col} {sort_dir}"));

        Ok(qb
            .build_query_as::<Article>()
            .fetch_all(&self.pool)
            .await?)
    }
}

// ─── テスト ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::setup_test_db;

    async fn repo() -> ArticleRepository {
        ArticleRepository::new(setup_test_db().await)
    }

    // ── insert ──

    #[tokio::test]
    async fn insert_returns_article_with_pending_status() {
        let r = repo().await;
        let article = r.insert("https://example.com").await.unwrap();

        assert_eq!(article.url, "https://example.com");
        assert_eq!(article.status, "pending");
        assert!(article.title.is_none());
        assert!(article.id > 0);
    }

    #[tokio::test]
    async fn insert_returns_duplicate_url_error() {
        let r = repo().await;
        r.insert("https://example.com").await.unwrap();
        let result = r.insert("https://example.com").await;

        assert!(
            matches!(result, Err(RepositoryError::DuplicateUrl)),
            "重複 URL は DuplicateUrl エラーになるべき"
        );
    }

    // ── get_by_id ──

    #[tokio::test]
    async fn get_by_id_returns_article() {
        let r = repo().await;
        let inserted = r.insert("https://example.com/a").await.unwrap();
        let fetched = r.get_by_id(inserted.id).await.unwrap();

        assert_eq!(fetched.id, inserted.id);
        assert_eq!(fetched.url, inserted.url);
    }

    #[tokio::test]
    async fn get_by_id_returns_not_found_for_missing_id() {
        let r = repo().await;
        let result = r.get_by_id(99999).await;

        assert!(matches!(result, Err(RepositoryError::NotFound(99999))));
    }

    // ── update_status ──

    #[tokio::test]
    async fn update_status_changes_status_field() {
        let r = repo().await;
        let article = r.insert("https://example.com/b").await.unwrap();
        let updated = r.update_status(article.id, "extracting").await.unwrap();

        assert_eq!(updated.status, "extracting");
    }

    #[tokio::test]
    async fn update_status_returns_not_found_for_missing_id() {
        let r = repo().await;
        let result = r.update_status(99999, "ready").await;

        assert!(matches!(result, Err(RepositoryError::NotFound(99999))));
    }

    // ── insert (language default) ──

    #[tokio::test]
    async fn insert_defaults_language_to_ja() {
        let r = repo().await;
        let article = r.insert("https://lang-default.com").await.unwrap();
        assert_eq!(article.language, "ja", "insert 後の language はデフォルト 'ja' であるべき");
    }

    // ── insert (source_type default) ──

    #[tokio::test]
    async fn insert_defaults_source_type_to_web() {
        let r = repo().await;
        let article = r.insert("https://source-type-default.com").await.unwrap();
        assert_eq!(article.source_type, "web", "insert 後の source_type はデフォルト 'web' であるべき");
    }

    // ── save_content ──

    #[tokio::test]
    async fn save_content_sets_ready_status_and_content() {
        let r = repo().await;
        let article = r.insert("https://example.com/c").await.unwrap();
        let updated = r
            .save_content(article.id, Some("タイトル"), "本文テキスト", Some("<p>本文テキスト</p>"), "ja")
            .await
            .unwrap();

        assert_eq!(updated.status, "ready");
        assert_eq!(updated.title.as_deref(), Some("タイトル"));
        assert_eq!(updated.content.as_deref(), Some("本文テキスト"));
        assert!(updated.extracted_at.is_some());
    }

    #[tokio::test]
    async fn save_content_stores_language_en() {
        let r = repo().await;
        let article = r.insert("https://en-article.com").await.unwrap();
        let updated = r
            .save_content(article.id, Some("Title"), "English body text.", None, "en")
            .await
            .unwrap();
        assert_eq!(updated.language, "en", "save_content で 'en' を渡すと language が 'en' になるべき");
    }

    #[tokio::test]
    async fn save_content_stores_language_ja() {
        let r = repo().await;
        let article = r.insert("https://ja-article.com").await.unwrap();
        let updated = r
            .save_content(article.id, Some("タイトル"), "日本語本文", None, "ja")
            .await
            .unwrap();
        assert_eq!(updated.language, "ja", "save_content で 'ja' を渡すと language が 'ja' になるべき");
    }

    // ── mark_error ──

    #[tokio::test]
    async fn mark_error_sets_error_status_and_message() {
        let r = repo().await;
        let article = r.insert("https://example.com/d").await.unwrap();
        let updated = r.mark_error(article.id, "取得タイムアウト").await.unwrap();

        assert_eq!(updated.status, "error");
        assert_eq!(updated.error_message.as_deref(), Some("取得タイムアウト"));
    }

    // ── delete ──

    #[tokio::test]
    async fn delete_removes_article() {
        let r = repo().await;
        let article = r.insert("https://example.com/e").await.unwrap();
        r.delete(article.id).await.unwrap();

        let result = r.get_by_id(article.id).await;
        assert!(matches!(result, Err(RepositoryError::NotFound(_))));
    }

    #[tokio::test]
    async fn delete_returns_not_found_for_missing_id() {
        let r = repo().await;
        let result = r.delete(99999).await;

        assert!(matches!(result, Err(RepositoryError::NotFound(99999))));
    }

    // ── list ──

    #[tokio::test]
    async fn list_returns_all_articles() {
        let r = repo().await;
        r.insert("https://a.com").await.unwrap();
        r.insert("https://b.com").await.unwrap();

        let articles = r.list(&ArticleFilter::default()).await.unwrap();
        assert_eq!(articles.len(), 2);
    }

    #[tokio::test]
    async fn list_filters_by_status() {
        let r = repo().await;
        let a = r.insert("https://a.com").await.unwrap();
        r.insert("https://b.com").await.unwrap();
        r.update_status(a.id, "extracting").await.unwrap();

        let filter = ArticleFilter {
            status: Some("extracting".to_string()),
            ..Default::default()
        };
        let articles = r.list(&filter).await.unwrap();

        assert_eq!(articles.len(), 1);
        assert_eq!(articles[0].url, "https://a.com");
    }

    #[tokio::test]
    async fn list_searches_by_url() {
        let r = repo().await;
        r.insert("https://example.com/article").await.unwrap();
        r.insert("https://other.com/post").await.unwrap();

        let filter = ArticleFilter {
            search: Some("example".to_string()),
            ..Default::default()
        };
        let articles = r.list(&filter).await.unwrap();

        assert_eq!(articles.len(), 1);
        assert!(articles[0].url.contains("example"));
    }

    // ── list (テキスト記事の URL 検索除外) ──

    #[tokio::test]
    async fn list_url_search_excludes_text_articles() {
        let r = repo().await;
        r.insert("https://example.com/text-page").await.unwrap();
        r.insert_text("text://uuid-1", "タイトル", "本文", "ja").await.unwrap();

        // プレースホルダ URL に部分一致するパターンでも text 記事はヒットしない
        let filter = ArticleFilter {
            search: Some("text".to_string()),
            search_target: Some("url".to_string()),
            ..Default::default()
        };
        let results = r.list(&filter).await.unwrap();
        assert_eq!(results.len(), 1, "URL 検索は web 記事のみヒットすべき");
        assert_eq!(results[0].source_type, "web");
    }

    #[tokio::test]
    async fn list_all_search_excludes_text_articles_by_url_only() {
        let r = repo().await;
        r.insert_text("text://uuid-abc", "園芸のタイトル", "園芸の本文です", "ja")
            .await
            .unwrap();

        // 「すべて」検索: プレースホルダ URL 部分（uuid）に一致してもヒットしない
        let filter = ArticleFilter {
            search: Some("uuid-abc".to_string()),
            search_target: Some("all".to_string()),
            ..Default::default()
        };
        let results = r.list(&filter).await.unwrap();
        assert!(results.is_empty(), "プレースホルダ URL は「すべて」検索でもヒットしないべき");

        // 「すべて」検索: タイトル・本文の一致では従来通りヒットする
        let filter = ArticleFilter {
            search: Some("園芸".to_string()),
            search_target: Some("all".to_string()),
            ..Default::default()
        };
        let results = r.list(&filter).await.unwrap();
        assert_eq!(results.len(), 1, "タイトル・本文一致ではテキスト記事もヒットすべき");
    }

    #[tokio::test]
    async fn list_title_and_content_search_still_hit_text_articles() {
        let r = repo().await;
        r.insert_text("text://uuid-xyz", "検索用タイトル", "検索用の本文テキスト", "ja")
            .await
            .unwrap();

        let by_title = r
            .list(&ArticleFilter {
                search: Some("検索用タイトル".to_string()),
                search_target: Some("title".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_title.len(), 1, "タイトル検索はテキスト記事にヒットすべき");

        let by_content = r
            .list(&ArticleFilter {
                search: Some("本文テキスト".to_string()),
                search_target: Some("content".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_content.len(), 1, "本文検索はテキスト記事にヒットすべき");
    }

    #[tokio::test]
    async fn list_returns_empty_when_none_match() {
        let r = repo().await;
        r.insert("https://a.com").await.unwrap();

        let filter = ArticleFilter {
            status: Some("ready".to_string()),
            ..Default::default()
        };
        let articles = r.list(&filter).await.unwrap();
        assert!(articles.is_empty());
    }
}

use chrono::Utc;
use sqlx::SqlitePool;
use thiserror::Error;

use crate::models::history::{DailyStats, HistoryFilter, HistoryJoinRow, PlaybackHistory, Stats};

const LIST_SQL: &str = "
    SELECT ph.id, ph.article_id, ph.started_at, ph.completed_at, ph.duration_seconds,
           ph.last_sentence_index, ph.sentence_count,
           a.url, a.title, a.content, a.content_html, a.status, a.error_message,
           a.registered_at, a.extracted_at, a.is_favorite, a.language, a.source_type
    FROM playback_history ph
    LEFT JOIN articles a ON ph.article_id = a.id
";

// ─── リポジトリエラー ─────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum HistoryRepoError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

// ─── HistoryRepository ────────────────────────────────────────────────────

pub struct HistoryRepository {
    pool: SqlitePool,
}

impl HistoryRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn record(
        &self,
        article_id: Option<i64>,
        duration_seconds: i64,
        started_at: Option<String>,
        last_sentence_index: Option<i64>,
        sentence_count: Option<i64>,
    ) -> Result<PlaybackHistory, HistoryRepoError> {
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            "INSERT INTO playback_history (article_id, started_at, completed_at, duration_seconds, last_sentence_index, sentence_count)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(article_id)
        .bind(started_at)
        .bind(&now)
        .bind(duration_seconds)
        .bind(last_sentence_index)
        .bind(sentence_count)
        .execute(&self.pool)
        .await?;

        let row_id = result.last_insert_rowid();
        let row = sqlx::query_as::<_, HistoryJoinRow>(&format!(
            "{} WHERE ph.id = {}",
            LIST_SQL, row_id
        ))
        .fetch_one(&self.pool)
        .await?;

        Ok(row.into())
    }

    pub async fn list(&self, filter: &HistoryFilter) -> Result<Vec<PlaybackHistory>, HistoryRepoError> {
        let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(LIST_SQL);
        qb.push("WHERE 1=1");

        if let Some(ref search) = filter.search {
            let pattern = format!("%{}%", search);
            match filter.search_target.as_deref().unwrap_or("all") {
                "title" => {
                    qb.push(" AND a.title LIKE ");
                    qb.push_bind(pattern);
                }
                "content" => {
                    qb.push(" AND a.content LIKE ");
                    qb.push_bind(pattern);
                }
                "url" => {
                    qb.push(" AND a.url LIKE ");
                    qb.push_bind(pattern);
                }
                _ => {
                    // "all": タイトル・本文・URL いずれかに一致
                    qb.push(" AND (a.title LIKE ");
                    qb.push_bind(pattern.clone());
                    qb.push(" OR a.content LIKE ");
                    qb.push_bind(pattern.clone());
                    qb.push(" OR a.url LIKE ");
                    qb.push_bind(pattern);
                    qb.push(")");
                }
            }
        }

        if let Some(ref from) = filter.from_date {
            qb.push(" AND ph.completed_at >= ");
            qb.push_bind(from.as_str());
        }

        if let Some(ref to) = filter.to_date {
            qb.push(" AND ph.completed_at <= ");
            qb.push_bind(to.as_str());
        }

        qb.push(" ORDER BY ph.completed_at DESC");

        let rows = qb
            .build_query_as::<HistoryJoinRow>()
            .fetch_all(&self.pool)
            .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// 指定記事の直近再生履歴を1件取得する（レジューム用）
    pub async fn get_last_for_article(&self, article_id: i64) -> Result<Option<PlaybackHistory>, HistoryRepoError> {
        let row = sqlx::query_as::<_, HistoryJoinRow>(&format!(
            "{} WHERE ph.article_id = ? ORDER BY ph.completed_at DESC LIMIT 1",
            LIST_SQL
        ))
        .bind(article_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(Into::into))
    }

    /// 再生中の進捗を更新する（文ブロック再生完了ごとに呼ぶ）
    pub async fn update_progress(
        &self,
        id: i64,
        last_sentence_index: Option<i64>,
        duration_seconds: i64,
    ) -> Result<(), HistoryRepoError> {
        sqlx::query(
            "UPDATE playback_history SET last_sentence_index = ?, duration_seconds = ? WHERE id = ?",
        )
        .bind(last_sentence_index)
        .bind(duration_seconds)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// 指定記事の全履歴のレジューム位置のみを無効化する。
    /// duration_seconds・completed_at 等の統計は保持する（ヒートマップに影響させない）。
    pub async fn clear_resume_position(&self, article_id: i64) -> Result<(), HistoryRepoError> {
        sqlx::query("UPDATE playback_history SET last_sentence_index = NULL WHERE article_id = ?")
            .bind(article_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_by_id(&self, id: i64) -> Result<(), HistoryRepoError> {
        sqlx::query("DELETE FROM playback_history WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_all(&self) -> Result<u64, HistoryRepoError> {
        let result = sqlx::query("DELETE FROM playback_history")
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    pub async fn get_stats(&self) -> Result<Stats, HistoryRepoError> {
        let (total_played, total_seconds): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(DISTINCT article_id), COALESCE(SUM(duration_seconds), 0) FROM playback_history",
        )
        .fetch_one(&self.pool)
        .await?;

        let daily_breakdown = sqlx::query_as::<_, (String, i64, i64)>(
            "SELECT strftime('%Y-%m-%d', completed_at) AS date,
                    COUNT(*) AS count,
                    SUM(duration_seconds) AS total_seconds
             FROM playback_history
             GROUP BY strftime('%Y-%m-%d', completed_at)
             ORDER BY date DESC",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(date, count, total_seconds)| DailyStats {
            date,
            count,
            total_seconds,
        })
        .collect();

        Ok(Stats {
            total_played,
            total_seconds,
            daily_breakdown,
        })
    }
}

// ─── テスト ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::setup_test_db;
    use crate::repositories::ArticleRepository;

    async fn setup() -> (ArticleRepository, HistoryRepository) {
        let pool = setup_test_db().await;
        (
            ArticleRepository::new(pool.clone()),
            HistoryRepository::new(pool),
        )
    }

    // ── record ──

    #[tokio::test]
    async fn record_creates_history_entry() {
        let (ar, hr) = setup().await;
        let a = ar.insert("https://a.com").await.unwrap();

        let entry = hr.record(Some(a.id), 120, None, Some(9), Some(10)).await.unwrap();

        assert_eq!(entry.article_id, Some(a.id));
        assert_eq!(entry.duration_seconds, 120);
        assert_eq!(entry.last_sentence_index, Some(9));
        assert_eq!(entry.sentence_count, Some(10));
        assert!(entry.article.is_some());
    }

    #[tokio::test]
    async fn record_accepts_null_article_id() {
        let (_, hr) = setup().await;
        let entry = hr.record(None, 60, None, None, None).await.unwrap();

        assert_eq!(entry.article_id, None);
        assert!(entry.article.is_none());
    }

    // ── list ──

    #[tokio::test]
    async fn list_returns_all_history_desc() {
        let (ar, hr) = setup().await;
        let a1 = ar.insert("https://a.com").await.unwrap();
        let a2 = ar.insert("https://b.com").await.unwrap();

        hr.record(Some(a1.id), 60, None, None, None).await.unwrap();
        hr.record(Some(a2.id), 90, None, None, None).await.unwrap();

        let history = hr.list(&HistoryFilter::default()).await.unwrap();
        assert_eq!(history.len(), 2);
        // DESC 順: 後に追加したものが先
        assert!(history[0].completed_at >= history[1].completed_at);
    }

    #[tokio::test]
    async fn list_filters_by_from_date() {
        let (ar, hr) = setup().await;
        let a = ar.insert("https://a.com").await.unwrap();
        hr.record(Some(a.id), 60, None, None, None).await.unwrap();

        // 未来の日付でフィルタ → 0件
        let filter = HistoryFilter {
            from_date: Some("2999-01-01T00:00:00+00:00".to_string()),
            ..Default::default()
        };
        let history = hr.list(&filter).await.unwrap();
        assert!(history.is_empty());
    }

    // ── get_stats ──

    #[tokio::test]
    async fn get_stats_returns_zero_when_empty() {
        let (_, hr) = setup().await;
        let stats = hr.get_stats().await.unwrap();

        assert_eq!(stats.total_played, 0);
        assert_eq!(stats.total_seconds, 0);
        assert!(stats.daily_breakdown.is_empty());
    }

    #[tokio::test]
    async fn get_stats_totals_match_recorded_entries() {
        let (ar, hr) = setup().await;
        let a = ar.insert("https://a.com").await.unwrap();

        hr.record(Some(a.id), 60, None, None, None).await.unwrap();
        hr.record(Some(a.id), 90, None, None, None).await.unwrap();
        hr.record(Some(a.id), 30, None, None, None).await.unwrap();

        let stats = hr.get_stats().await.unwrap();

        assert_eq!(stats.total_played, 1); // 同一記事3回再生 → ユニーク1件
        assert_eq!(stats.total_seconds, 180);
        // 同じ日なのでブレークダウンは 1 件
        assert_eq!(stats.daily_breakdown.len(), 1);
        assert_eq!(stats.daily_breakdown[0].count, 3);
        assert_eq!(stats.daily_breakdown[0].total_seconds, 180);
    }
}

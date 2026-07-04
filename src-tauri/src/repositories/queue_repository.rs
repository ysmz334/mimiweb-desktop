use chrono::Utc;
use sqlx::SqlitePool;
use thiserror::Error;

use crate::models::queue::{QueueItem, QueueJoinRow};

const LIST_SQL: &str = "
    SELECT qi.id, qi.article_id, qi.position, qi.added_at,
           a.url, a.title, a.content, a.content_html, a.status, a.error_message,
           a.registered_at, a.extracted_at, a.is_favorite, a.language
    FROM queue_items qi
    JOIN articles a ON qi.article_id = a.id
    ORDER BY qi.position ASC
";

// ─── リポジトリエラー ─────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum QueueRepoError {
    #[error("Article not found")]
    ArticleNotFound,
    #[error("Queue item not found: {0}")]
    ItemNotFound(i64),
    #[error("Article is already in queue")]
    AlreadyQueued,
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

// ─── QueueRepository ──────────────────────────────────────────────────────

pub struct QueueRepository {
    pool: SqlitePool,
}

impl QueueRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// キューの末尾にアイテムを追加する。同一記事は1つのみ登録可能。
    pub async fn add(&self, article_id: i64) -> Result<QueueItem, QueueRepoError> {
        // 重複チェック: 同一 article_id が既にキューに存在する場合はエラー
        let already_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM queue_items WHERE article_id = ?)",
        )
        .bind(article_id)
        .fetch_one(&self.pool)
        .await?;

        if already_exists {
            return Err(QueueRepoError::AlreadyQueued);
        }

        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            "INSERT INTO queue_items (article_id, position, added_at)
             VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM queue_items), ?)",
        )
        .bind(article_id)
        .bind(&now)
        .execute(&self.pool)
        .await;

        match result {
            Err(sqlx::Error::Database(e)) if e.is_foreign_key_violation() => {
                Err(QueueRepoError::ArticleNotFound)
            }
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                Err(QueueRepoError::AlreadyQueued)
            }
            Err(e) => Err(QueueRepoError::Database(e)),
            Ok(r) => {
                let row_id = r.last_insert_rowid();
                let item = sqlx::query_as::<_, QueueJoinRow>(&format!(
                    "{} WHERE qi.id = {}",
                    LIST_SQL.replace("ORDER BY qi.position ASC", ""),
                    row_id
                ))
                .fetch_one(&self.pool)
                .await?;
                Ok(item.into())
            }
        }
    }

    /// キューからアイテムを削除する。
    pub async fn remove(&self, id: i64) -> Result<(), QueueRepoError> {
        let rows = sqlx::query("DELETE FROM queue_items WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();

        if rows == 0 {
            return Err(QueueRepoError::ItemNotFound(id));
        }
        Ok(())
    }

    /// `ordered_ids` の順序で全アイテムの position を一括更新する。
    /// UNIQUE 制約の衝突を避けるため、まず全 position を負値にしてから再設定する。
    pub async fn reorder(&self, ordered_ids: &[i64]) -> Result<Vec<QueueItem>, QueueRepoError> {
        let mut tx = self.pool.begin().await?;

        // フェーズ 1: 競合回避のために position を -id にする
        for &id in ordered_ids {
            sqlx::query("UPDATE queue_items SET position = -id WHERE id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }

        // フェーズ 2: 正しい position を設定
        for (idx, &id) in ordered_ids.iter().enumerate() {
            sqlx::query("UPDATE queue_items SET position = ? WHERE id = ?")
                .bind(idx as i64 + 1)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        self.list().await
    }

    /// position 昇順でキューを返す（記事情報を JOIN して含む）。
    pub async fn list(&self) -> Result<Vec<QueueItem>, QueueRepoError> {
        let rows = sqlx::query_as::<_, QueueJoinRow>(LIST_SQL)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

// ─── テスト ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::setup_test_db;
    use crate::repositories::ArticleRepository;

    async fn setup() -> (ArticleRepository, QueueRepository) {
        let pool = setup_test_db().await;
        // FK を有効化
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        let article_repo = ArticleRepository::new(pool.clone());
        let queue_repo = QueueRepository::new(pool);
        (article_repo, queue_repo)
    }

    // ── add ──

    #[tokio::test]
    async fn add_appends_item_with_correct_position() {
        let (ar, qr) = setup().await;
        let a1 = ar.insert("https://a.com").await.unwrap();
        let a2 = ar.insert("https://b.com").await.unwrap();

        let item1 = qr.add(a1.id).await.unwrap();
        let item2 = qr.add(a2.id).await.unwrap();

        assert_eq!(item1.position, 1);
        assert_eq!(item2.position, 2);
        assert_eq!(item1.article.url, "https://a.com");
    }

    #[tokio::test]
    async fn add_returns_article_not_found_for_invalid_article_id() {
        let (_, qr) = setup().await;
        let result = qr.add(99999).await;

        assert!(
            matches!(result, Err(QueueRepoError::ArticleNotFound)),
            "存在しない article_id は ArticleNotFound エラーになるべき"
        );
    }

    // ── remove ──

    #[tokio::test]
    async fn remove_deletes_queue_item() {
        let (ar, qr) = setup().await;
        let a = ar.insert("https://c.com").await.unwrap();
        let item = qr.add(a.id).await.unwrap();

        qr.remove(item.id).await.unwrap();

        let items = qr.list().await.unwrap();
        assert!(items.is_empty());
    }

    #[tokio::test]
    async fn remove_returns_not_found_for_invalid_id() {
        let (_, qr) = setup().await;
        let result = qr.remove(99999).await;

        assert!(matches!(result, Err(QueueRepoError::ItemNotFound(99999))));
    }

    // ── reorder ──

    #[tokio::test]
    async fn reorder_updates_positions_correctly() {
        let (ar, qr) = setup().await;
        let a1 = ar.insert("https://d.com").await.unwrap();
        let a2 = ar.insert("https://e.com").await.unwrap();
        let a3 = ar.insert("https://f.com").await.unwrap();

        let i1 = qr.add(a1.id).await.unwrap();
        let i2 = qr.add(a2.id).await.unwrap();
        let i3 = qr.add(a3.id).await.unwrap();

        // 逆順に並び替え: [i3, i2, i1]
        let reordered = qr.reorder(&[i3.id, i2.id, i1.id]).await.unwrap();

        assert_eq!(reordered[0].id, i3.id);
        assert_eq!(reordered[0].position, 1);
        assert_eq!(reordered[1].id, i2.id);
        assert_eq!(reordered[1].position, 2);
        assert_eq!(reordered[2].id, i1.id);
        assert_eq!(reordered[2].position, 3);
    }

    // ── list ──

    #[tokio::test]
    async fn list_returns_items_in_position_order() {
        let (ar, qr) = setup().await;
        let a1 = ar.insert("https://g.com").await.unwrap();
        let a2 = ar.insert("https://h.com").await.unwrap();

        qr.add(a1.id).await.unwrap();
        qr.add(a2.id).await.unwrap();

        let items = qr.list().await.unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0].position < items[1].position);
        assert_eq!(items[0].article.url, "https://g.com");
    }

    #[tokio::test]
    async fn list_includes_article_data() {
        let (ar, qr) = setup().await;
        let a = ar.insert("https://i.com").await.unwrap();
        qr.add(a.id).await.unwrap();

        let items = qr.list().await.unwrap();
        assert_eq!(items[0].article.url, "https://i.com");
        assert_eq!(items[0].article.status, "pending");
    }
}

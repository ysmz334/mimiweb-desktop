use std::cmp::Ordering;
use std::collections::HashMap;
use sqlx::SqlitePool;

pub struct KeywordRepository {
    pool: SqlitePool,
}

impl KeywordRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 記事のキーワード頻度を一括保存（既存は置き換え）
    pub async fn store_keywords(
        &self,
        article_id: i64,
        counts: &HashMap<String, u32>,
    ) -> sqlx::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM article_keywords WHERE article_id = ?")
            .bind(article_id)
            .execute(&mut *tx)
            .await?;
        for (word, &count) in counts {
            sqlx::query(
                "INSERT INTO article_keywords (article_id, word, count) VALUES (?, ?, ?)",
            )
            .bind(article_id)
            .bind(word)
            .bind(count as i64)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// TF-IDF スコア付きキーワードを上位 top_n 件返す（正規化済み 0.0–1.0）
    pub async fn get_scored_keywords(
        &self,
        article_id: i64,
        top_n: usize,
    ) -> sqlx::Result<Vec<(String, f64)>> {
        // 対象記事の (word, count)
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT word, count FROM article_keywords WHERE article_id = ?",
        )
        .bind(article_id)
        .fetch_all(&self.pool)
        .await?;

        if rows.is_empty() {
            return Ok(Vec::new());
        }

        let total: i64 = rows.iter().map(|(_, c)| c).sum();

        // 全記事数 N
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT article_id) FROM article_keywords",
        )
        .fetch_one(&self.pool)
        .await?;

        // 対象記事の各語の DF (何記事に登場するか)
        let df_rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT word, COUNT(DISTINCT article_id) AS df
             FROM article_keywords
             WHERE word IN (SELECT word FROM article_keywords WHERE article_id = ?)
             GROUP BY word",
        )
        .bind(article_id)
        .fetch_all(&self.pool)
        .await?;

        let df_map: HashMap<String, i64> = df_rows.into_iter().collect();

        let n_f = n as f64;
        let total_f = total as f64;

        let mut scores: Vec<(String, f64)> = rows
            .iter()
            .map(|(word, count)| {
                let tf = *count as f64 / total_f;
                let df = df_map.get(word).copied().unwrap_or(1) as f64;
                // スムージング済み IDF
                let idf = ((n_f + 1.0) / (df + 1.0)).ln() + 1.0;
                (word.clone(), tf * idf)
            })
            .collect();

        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        scores.truncate(top_n);

        // 最大値で正規化
        if let Some(max) = scores.first().map(|(_, s)| *s) {
            if max > 0.0 {
                for (_, s) in &mut scores {
                    *s /= max;
                }
            }
        }

        Ok(scores)
    }
}

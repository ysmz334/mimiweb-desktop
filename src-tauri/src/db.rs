use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

pub const MIGRATION_SQL: &str = include_str!("../migrations/001_create_tables.sql");

/// articles の source_type カラムを追加する（既存 DB 用・冪等）。
pub async fn ensure_source_type_column(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let has_source_type: bool = sqlx::query_scalar(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'source_type'",
    )
    .fetch_one(pool)
    .await?;
    if !has_source_type {
        sqlx::query("ALTER TABLE articles ADD COLUMN source_type TEXT NOT NULL DEFAULT 'web'")
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn setup_test_db() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("Failed to create in-memory SQLite pool");

    sqlx::raw_sql(MIGRATION_SQL)
        .execute(&pool)
        .await
        .expect("Migration failed");

    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_tables_created() {
        let pool = setup_test_db().await;
        for table in ["articles", "queue_items", "playback_history", "settings"] {
            let exists: bool = sqlx::query_scalar(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .bind(table)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(exists, "table '{table}' should exist");
        }
    }

    #[tokio::test]
    async fn articles_has_language_column() {
        let pool = setup_test_db().await;
        let has_language: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'language'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(has_language, "articles テーブルに language カラムが存在すべき");
    }

    #[tokio::test]
    async fn articles_language_defaults_to_ja() {
        let pool = setup_test_db().await;
        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://lang-test.com', 'pending', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let lang: String =
            sqlx::query_scalar("SELECT language FROM articles WHERE url = 'https://lang-test.com'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(lang, "ja", "language のデフォルト値は 'ja' であるべき");
    }

    #[tokio::test]
    async fn articles_language_migration_idempotent() {
        let pool = setup_test_db().await;
        // language カラムが既に存在する状態でも ADD COLUMN は安全に回避できることを確認
        let has_language: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'language'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        // 存在確認 → 存在する場合は ALTER をスキップするロジックの検証
        if !has_language {
            sqlx::query("ALTER TABLE articles ADD COLUMN language TEXT NOT NULL DEFAULT 'ja'")
                .execute(&pool)
                .await
                .unwrap();
        }
        // 再度確認しても正常
        let still_has: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'language'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(still_has, "マイグレーション後も language カラムが存在すべき");
    }

    #[tokio::test]
    async fn articles_has_source_type_column() {
        let pool = setup_test_db().await;
        let has_source_type: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'source_type'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(has_source_type, "articles テーブルに source_type カラムが存在すべき");
    }

    #[tokio::test]
    async fn articles_source_type_defaults_to_web() {
        let pool = setup_test_db().await;
        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://type-test.com', 'pending', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let source_type: String = sqlx::query_scalar(
            "SELECT source_type FROM articles WHERE url = 'https://type-test.com'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(source_type, "web", "source_type のデフォルト値は 'web' であるべき");
    }

    #[tokio::test]
    async fn source_type_migration_applies_to_existing_db_and_is_idempotent() {
        // source_type カラムを持たない旧スキーマの DB を再現する
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE articles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'pending',
                registered_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://old-db.com', 'ready', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // マイグレーションを2回適用しても冪等であること
        ensure_source_type_column(&pool).await.unwrap();
        ensure_source_type_column(&pool).await.unwrap();

        // 既存の全記事が種別 'web' として読み出せること
        let source_type: String =
            sqlx::query_scalar("SELECT source_type FROM articles WHERE url = 'https://old-db.com'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(source_type, "web", "マイグレーション後、既存記事は種別 'web' として読めるべき");
    }

    #[tokio::test]
    async fn articles_url_unique_constraint() {
        let pool = setup_test_db().await;
        let url = "https://example.com";
        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES (?, 'pending', '2024-01-01T00:00:00Z')",
        )
        .bind(url)
        .execute(&pool)
        .await
        .unwrap();

        let result = sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES (?, 'pending', '2024-01-01T00:00:00Z')",
        )
        .bind(url)
        .execute(&pool)
        .await;

        assert!(result.is_err(), "duplicate URL must violate UNIQUE constraint");
    }

    #[tokio::test]
    async fn articles_status_check_constraint() {
        let pool = setup_test_db().await;
        let result = sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://a.com', 'invalid', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await;

        assert!(result.is_err(), "invalid status must violate CHECK constraint");
    }

    #[tokio::test]
    async fn settings_seed_data_present() {
        let pool = setup_test_db().await;
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT key, value FROM settings ORDER BY key")
                .fetch_all(&pool)
                .await
                .unwrap();

        assert_eq!(rows.len(), 3, "settings should have 3 seed rows");

        let find = |k: &str| rows.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(find("voicevox_speaker_id"), Some("3"));
        assert_eq!(find("voicevox_port"), Some("50021"));
        assert_eq!(find("playback_speed"), Some("1.0"));
    }

    #[tokio::test]
    async fn queue_items_cascade_delete_on_article_removal() {
        let pool = setup_test_db().await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://b.com', 'pending', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let article_id: i64 = sqlx::query_scalar("SELECT last_insert_rowid()")
            .fetch_one(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO queue_items (article_id, position, added_at) VALUES (?, 1, '2024-01-01T00:00:00Z')",
        )
        .bind(article_id)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM articles WHERE id = ?")
            .bind(article_id)
            .execute(&pool)
            .await
            .unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM queue_items")
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(count, 0, "queue_items should be CASCADE deleted with article");
    }

    #[tokio::test]
    async fn playback_history_article_id_set_null_on_article_removal() {
        let pool = setup_test_db().await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://c.com', 'pending', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let article_id: i64 = sqlx::query_scalar("SELECT last_insert_rowid()")
            .fetch_one(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO playback_history (article_id, completed_at, duration_seconds) VALUES (?, '2024-01-01T00:00:00Z', 120)",
        )
        .bind(article_id)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM articles WHERE id = ?")
            .bind(article_id)
            .execute(&pool)
            .await
            .unwrap();

        let null_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM playback_history WHERE article_id IS NULL")
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(
            null_count, 1,
            "playback_history.article_id should be SET NULL after article deletion"
        );
    }

    #[tokio::test]
    async fn queue_position_unique_constraint() {
        let pool = setup_test_db().await;

        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://d.com', 'pending', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let article_id: i64 = sqlx::query_scalar("SELECT last_insert_rowid()")
            .fetch_one(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO queue_items (article_id, position, added_at) VALUES (?, 1, '2024-01-01T00:00:00Z')",
        )
        .bind(article_id)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO articles (url, status, registered_at) VALUES ('https://e.com', 'pending', '2024-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let article_id2: i64 = sqlx::query_scalar("SELECT last_insert_rowid()")
            .fetch_one(&pool)
            .await
            .unwrap();

        let result = sqlx::query(
            "INSERT INTO queue_items (article_id, position, added_at) VALUES (?, 1, '2024-01-01T00:00:00Z')",
        )
        .bind(article_id2)
        .execute(&pool)
        .await;

        assert!(result.is_err(), "duplicate position must violate UNIQUE index");
    }
}

use tauri::{AppHandle, State};

use crate::{
    models::article::{Article, ArticleError, ArticleFilter},
    repositories::{article_repository::RepositoryError, ArticleRepository, KeywordRepository},
    state::AppState,
};

fn repo_err_to_article_err(e: RepositoryError) -> ArticleError {
    match e {
        RepositoryError::DuplicateUrl => ArticleError::DuplicateUrl,
        RepositoryError::NotFound(_) => ArticleError::NotFound,
        RepositoryError::Database(e) => ArticleError::DatabaseError {
            message: e.to_string(),
        },
    }
}

fn validate_http_url(url: &str) -> Result<(), ArticleError> {
    let parsed = url
        .parse::<reqwest::Url>()
        .map_err(|e| ArticleError::InvalidUrl {
            message: e.to_string(),
        })?;
    if !["http", "https"].contains(&parsed.scheme()) {
        return Err(ArticleError::InvalidUrl {
            message: "URL は http または https で始まる必要があります".to_string(),
        });
    }
    Ok(())
}

/// WebView でページを完全レンダリングし、HTML を返す。失敗時は DB にエラーを記録。
/// イベント emit は呼び出し元で行う。
pub async fn run_extraction_task(
    app: &AppHandle,
    id: i64,
    url: &str,
    repo: &ArticleRepository,
) -> Result<String, String> {
    match crate::services::webview_scraper::fetch_with_webview(app, url, id).await {
        Ok(html) => Ok(html),
        Err(e) => {
            let _ = repo.mark_error(id, &e).await;
            Err(e)
        }
    }
}

// ─── テキスト記事 ──────────────────────────────────────────────────────────

/// タイトル自動採用時の最大文字数
const TEXT_TITLE_MAX_CHARS: usize = 80;

/// タイトル省略時（または空白のみ）は本文の最初の非空行を 80 文字上限で採用する。
/// 呼び出し前に本文が非空であることを検証済みのため、必ず非空のタイトルが得られる。
fn derive_text_title(title: Option<&str>, content: &str) -> String {
    if let Some(t) = title {
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let first_line = content
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    first_line.chars().take(TEXT_TITLE_MAX_CHARS).collect()
}

/// テキスト記事登録のコア処理（イベント emit を除く）。
/// 空本文の拒否 → タイトル導出 → プレースホルダ URL 生成 → 3値言語判定 →
/// INSERT（ready）→ キーワード分析（mixed は日本語パイプライン）を行う。
pub async fn register_text_article_core(
    pool: &sqlx::SqlitePool,
    title: Option<String>,
    content: String,
) -> Result<Article, ArticleError> {
    if content.trim().is_empty() {
        return Err(ArticleError::EmptyContent);
    }

    let derived_title = derive_text_title(title.as_deref(), &content);
    let url = format!("text://{}", uuid::Uuid::new_v4());
    let language = crate::services::piper_manager::detect_article_language(&content);

    let repo = ArticleRepository::new(pool.clone());
    let article = repo
        .insert_text(&url, &derived_title, &content, language)
        .await
        .map_err(repo_err_to_article_err)?;

    // キーワード抽出（失敗しても記事登録には影響しない）
    let keyword_language = if language == "mixed" { "ja" } else { language };
    let text = format!("{} {}", derived_title, content);
    let counts = crate::analysis::keywords::extract_word_counts(&text, keyword_language);
    if !counts.is_empty() {
        let kw_repo = KeywordRepository::new(pool.clone());
        if let Err(e) = kw_repo.store_keywords(article.id, &counts).await {
            tracing::warn!("keyword store failed for text article {}: {e}", article.id);
        }
    }

    Ok(article)
}

/// テキスト記事編集のコア処理（イベント emit を除く）。
/// テキスト記事以外は `NotTextArticle` で拒否し、保存時に言語判定・キーワード分析を
/// 再実施したうえで、対象記事のレジューム位置のみを無効化する（統計は保持）。
pub async fn update_text_article_core(
    pool: &sqlx::SqlitePool,
    id: i64,
    title: Option<String>,
    content: String,
) -> Result<Article, ArticleError> {
    if content.trim().is_empty() {
        return Err(ArticleError::EmptyContent);
    }

    let repo = ArticleRepository::new(pool.clone());
    let existing = repo.get_by_id(id).await.map_err(repo_err_to_article_err)?;
    if existing.source_type != "text" {
        return Err(ArticleError::NotTextArticle);
    }

    let derived_title = derive_text_title(title.as_deref(), &content);
    let language = crate::services::piper_manager::detect_article_language(&content);

    let article = repo
        .update_text_content(id, &derived_title, &content, language)
        .await
        .map_err(repo_err_to_article_err)?;

    // キーワード再分析（失敗しても編集保存には影響しない）
    let keyword_language = if language == "mixed" { "ja" } else { language };
    let text = format!("{} {}", derived_title, content);
    let counts = crate::analysis::keywords::extract_word_counts(&text, keyword_language);
    let kw_repo = KeywordRepository::new(pool.clone());
    if let Err(e) = kw_repo.store_keywords(article.id, &counts).await {
        tracing::warn!("keyword store failed for text article {}: {e}", article.id);
    }

    // 旧本文に基づく途中再開位置を無効化する（再生統計は保持）
    let history_repo = crate::repositories::HistoryRepository::new(pool.clone());
    if let Err(e) = history_repo.clear_resume_position(article.id).await {
        tracing::warn!("resume position clear failed for article {}: {e}", article.id);
    }

    Ok(article)
}

// ─── Tauri コマンド ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn update_text_article(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
    title: Option<String>,
    content: String,
) -> Result<Article, ArticleError> {
    use tauri::Emitter;

    let article = update_text_article_core(state.db(), id, title, content).await?;

    // 既存の抽出完了イベントを発火し、一覧更新・Piper 誘導の既存経路を再利用する
    let _ = app.emit("article:extraction-completed", &article);

    Ok(article)
}

#[tauri::command]
pub async fn register_text_article(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
    content: String,
) -> Result<Article, ArticleError> {
    use tauri::Emitter;

    let article = register_text_article_core(state.db(), title, content).await?;

    // 既存の抽出完了イベントを発火し、一覧更新・Piper 誘導の既存経路を再利用する
    let _ = app.emit("article:extraction-completed", &article);

    Ok(article)
}

#[tauri::command]
pub async fn register_article(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<Article, ArticleError> {
    validate_http_url(&url)?;

    let article = state
        .article_repo()
        .insert(&url)
        .await
        .map_err(repo_err_to_article_err)?;

    let id = article.id;
    let url_clone = url.clone();
    let pool = state.db().clone();

    tokio::spawn(async move {
        use tauri::Emitter;
        let repo = ArticleRepository::new(pool);
        match run_extraction_task(&app, id, &url_clone, &repo).await {
            Ok(html) => {
                let _ = app.emit(
                    "article:extraction-started",
                    serde_json::json!({ "id": id, "html": html, "url": url_clone }),
                );
            }
            Err(reason) => {
                let _ = app.emit(
                    "article:extraction-failed",
                    serde_json::json!({ "id": id, "reason": reason }),
                );
            }
        }
    });

    Ok(article)
}

#[tauri::command]
pub async fn get_articles(
    state: State<'_, AppState>,
    filter: Option<ArticleFilter>,
) -> Result<Vec<Article>, ArticleError> {
    state
        .article_repo()
        .list(&filter.unwrap_or_default())
        .await
        .map_err(repo_err_to_article_err)
}

#[tauri::command]
pub async fn delete_article(state: State<'_, AppState>, id: i64) -> Result<(), ArticleError> {
    state
        .article_repo()
        .delete(id)
        .await
        .map_err(repo_err_to_article_err)
}

#[tauri::command]
pub async fn retry_extract(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Article, ArticleError> {
    let article = state
        .article_repo()
        .get_by_id(id)
        .await
        .map_err(repo_err_to_article_err)?;

    let updated = state
        .article_repo()
        .update_status(id, "pending")
        .await
        .map_err(repo_err_to_article_err)?;

    let url = article.url.clone();
    let pool = state.db().clone();

    tokio::spawn(async move {
        use tauri::Emitter;
        let repo = ArticleRepository::new(pool);
        match run_extraction_task(&app, id, &url, &repo).await {
            Ok(html) => {
                let _ = app.emit(
                    "article:extraction-started",
                    serde_json::json!({ "id": id, "html": html, "url": url }),
                );
            }
            Err(reason) => {
                let _ = app.emit(
                    "article:extraction-failed",
                    serde_json::json!({ "id": id, "reason": reason }),
                );
            }
        }
    });

    Ok(updated)
}

#[tauri::command]
pub async fn save_extracted_content(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
    title: Option<String>,
    content: String,
    content_html: Option<String>,
) -> Result<Article, ArticleError> {
    use tauri::Emitter;

    let language = crate::services::piper_manager::detect_language(&content);
    let article = state
        .article_repo()
        .save_content(id, title.as_deref(), &content, content_html.as_deref(), language)
        .await
        .map_err(repo_err_to_article_err)?;

    // キーワード抽出（バックグラウンド、失敗しても記事保存には影響しない）
    {
        let text = format!("{} {}", title.as_deref().unwrap_or(""), content);
        let counts = crate::analysis::keywords::extract_word_counts(&text, language);
        if !counts.is_empty() {
            let kw_repo = KeywordRepository::new(state.db().clone());
            if let Err(e) = kw_repo.store_keywords(id, &counts).await {
                tracing::warn!("keyword store failed for article {id}: {e}");
            }
        }
    }

    let _ = app.emit("article:extraction-completed", &article);

    Ok(article)
}

#[tauri::command]
pub async fn mark_extraction_error(
    state: State<'_, AppState>,
    id: i64,
    error: String,
) -> Result<Article, ArticleError> {
    state
        .article_repo()
        .mark_error(id, &error)
        .await
        .map_err(repo_err_to_article_err)
}

#[tauri::command]
pub async fn toggle_favorite(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Article, ArticleError> {
    state
        .article_repo()
        .toggle_favorite(id)
        .await
        .map_err(repo_err_to_article_err)
}

/// 指定 URL の生 HTML を返す（ビューア内リンクのインライン閲覧用）。
/// DB には記録しない。article_id として 0 を使用する（同時実行は想定しない）。
#[tauri::command]
pub async fn fetch_page_html(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let parsed = url.parse::<reqwest::Url>().map_err(|e| e.to_string())?;
    if !["http", "https"].contains(&parsed.scheme()) {
        return Err("http または https URL のみサポートしています".to_string());
    }
    crate::services::webview_scraper::fetch_with_webview(&app, &url, 0).await
}

// ─── テスト ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::setup_test_db;
    use crate::models::article::ArticleFilter;

    // ── derive_text_title ──

    #[test]
    fn derive_text_title_uses_explicit_title() {
        let title = derive_text_title(Some("明示タイトル"), "本文の一行目\n二行目");
        assert_eq!(title, "明示タイトル");
    }

    #[test]
    fn derive_text_title_falls_back_to_first_non_empty_line() {
        let title = derive_text_title(None, "\n  \n最初の非空行がタイトルになる\n二行目");
        assert_eq!(title, "最初の非空行がタイトルになる");
    }

    #[test]
    fn derive_text_title_truncates_to_80_chars() {
        let long_line = "あ".repeat(100);
        let title = derive_text_title(None, &long_line);
        assert_eq!(title.chars().count(), 80, "80 文字に切り詰められるべき");
        assert_eq!(title, "あ".repeat(80));
    }

    #[test]
    fn derive_text_title_treats_blank_title_as_missing() {
        let title = derive_text_title(Some("   "), "本文から採用される行");
        assert_eq!(title, "本文から採用される行", "空白のみのタイトルは省略と同義");
    }

    // ── register_text_article_core ──

    #[tokio::test]
    async fn register_text_rejects_empty_content() {
        let pool = setup_test_db().await;
        let result = register_text_article_core(&pool, None, "".to_string()).await;
        assert!(matches!(result, Err(ArticleError::EmptyContent)), "空の本文は拒否すべき");
    }

    #[tokio::test]
    async fn register_text_rejects_whitespace_only_content() {
        let pool = setup_test_db().await;
        let result = register_text_article_core(&pool, None, "  \n\t \n  ".to_string()).await;
        assert!(matches!(result, Err(ArticleError::EmptyContent)), "空白のみの本文は拒否すべき");
    }

    #[tokio::test]
    async fn register_text_creates_ready_text_article() {
        let pool = setup_test_db().await;
        let article = register_text_article_core(
            &pool,
            Some("テスト記事".to_string()),
            "これは日本語のテキスト記事です。読み上げのテストに使います。".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(article.status, "ready", "抽出工程なしで即時 ready になるべき");
        assert_eq!(article.source_type, "text");
        assert!(article.url.starts_with("text://"), "プレースホルダ URL は text:// 形式: {}", article.url);
        assert_eq!(article.title.as_deref(), Some("テスト記事"));
        assert_eq!(article.language, "ja");
        assert!(article.content_html.is_none(), "テキスト記事に content_html は持たせない");
        assert!(article.extracted_at.is_some(), "extracted_at が設定されるべき");
    }

    #[tokio::test]
    async fn register_text_generates_unique_placeholder_urls() {
        let pool = setup_test_db().await;
        let a1 = register_text_article_core(&pool, None, "一つ目の記事本文です。".to_string())
            .await
            .unwrap();
        let a2 = register_text_article_core(&pool, None, "一つ目の記事本文です。".to_string())
            .await
            .unwrap();
        assert_ne!(a1.url, a2.url, "同一本文でも URL は一意であるべき");
    }

    #[tokio::test]
    async fn register_text_stores_keywords() {
        let pool = setup_test_db().await;
        let article = register_text_article_core(
            &pool,
            None,
            "機械学習の勉強を続けています。機械学習は面白い分野です。".to_string(),
        )
        .await
        .unwrap();

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM article_keywords WHERE article_id = ?")
                .bind(article.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(count > 0, "登録時にキーワードが保存されるべき");
    }

    #[tokio::test]
    async fn register_text_detects_mixed_language() {
        let pool = setup_test_db().await;
        let content = "私は毎朝コーヒーを飲みます。\n\
                       I drink coffee every morning.\n\
                       今日は天気がいいですね。\n\
                       The weather is nice today.";
        let article = register_text_article_core(&pool, None, content.to_string())
            .await
            .unwrap();
        assert_eq!(article.language, "mixed", "対訳形式は mixed と判定されるべき");

        // mixed でもキーワード分析（日本語パイプライン）が動くこと
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM article_keywords WHERE article_id = ?")
                .bind(article.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(count > 0, "mixed 記事でもキーワードが保存されるべき");
    }

    // ── update_text_article_core ──

    #[tokio::test]
    async fn update_text_rejects_non_text_article() {
        let pool = setup_test_db().await;
        let repo = ArticleRepository::new(pool.clone());
        let web_article = repo.insert("https://example.com/web").await.unwrap();

        let result = update_text_article_core(
            &pool,
            web_article.id,
            None,
            "新しい本文".to_string(),
        )
        .await;
        assert!(
            matches!(result, Err(ArticleError::NotTextArticle)),
            "web 記事への編集要求は NotTextArticle で拒否すべき"
        );
    }

    #[tokio::test]
    async fn update_text_rejects_empty_content() {
        let pool = setup_test_db().await;
        let article = register_text_article_core(&pool, None, "元の本文です。".to_string())
            .await
            .unwrap();

        let result = update_text_article_core(&pool, article.id, None, "   \n ".to_string()).await;
        assert!(matches!(result, Err(ArticleError::EmptyContent)));
    }

    #[tokio::test]
    async fn update_text_returns_not_found_for_missing_id() {
        let pool = setup_test_db().await;
        let result = update_text_article_core(&pool, 99999, None, "本文".to_string()).await;
        assert!(matches!(result, Err(ArticleError::NotFound)));
    }

    #[tokio::test]
    async fn update_text_saves_content_and_redetects_language() {
        let pool = setup_test_db().await;
        let article = register_text_article_core(
            &pool,
            Some("元タイトル".to_string()),
            "日本語だけの本文です。".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(article.language, "ja");

        let mixed_content = "私は毎朝コーヒーを飲みます。\n\
                             I drink coffee every morning.\n\
                             今日は天気がいいですね。\n\
                             The weather is nice today.";
        let updated = update_text_article_core(
            &pool,
            article.id,
            Some("新タイトル".to_string()),
            mixed_content.to_string(),
        )
        .await
        .unwrap();

        assert_eq!(updated.title.as_deref(), Some("新タイトル"));
        assert_eq!(updated.content.as_deref(), Some(mixed_content));
        assert_eq!(updated.language, "mixed", "保存時に言語判定を再実施すべき");
        assert_eq!(updated.source_type, "text");
    }

    #[tokio::test]
    async fn update_text_replaces_keywords() {
        let pool = setup_test_db().await;
        let article = register_text_article_core(
            &pool,
            None,
            "機械学習の話題です。機械学習を勉強します。".to_string(),
        )
        .await
        .unwrap();

        update_text_article_core(
            &pool,
            article.id,
            None,
            "園芸の話題です。園芸を楽しみます。".to_string(),
        )
        .await
        .unwrap();

        let old_kw: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM article_keywords WHERE article_id = ? AND word = '機械学習'",
        )
        .bind(article.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let new_kw: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM article_keywords WHERE article_id = ? AND word = '園芸'",
        )
        .bind(article.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(old_kw, 0, "旧本文のキーワードは置き換えられるべき");
        assert!(new_kw > 0, "新本文のキーワードが保存されるべき");
    }

    #[tokio::test]
    async fn update_text_clears_resume_position_but_keeps_stats() {
        let pool = setup_test_db().await;
        let article = register_text_article_core(
            &pool,
            None,
            "一文目です。二文目です。三文目です。".to_string(),
        )
        .await
        .unwrap();

        // 途中まで再生した履歴（レジューム対象）を作る
        sqlx::query(
            "INSERT INTO playback_history
               (article_id, started_at, completed_at, duration_seconds, last_sentence_index, sentence_count)
             VALUES (?, '2024-01-01T00:00:00Z', '2024-01-01T00:05:00Z', 300, 1, 3)",
        )
        .bind(article.id)
        .execute(&pool)
        .await
        .unwrap();

        update_text_article_core(&pool, article.id, None, "書き換えた新しい本文です。".to_string())
            .await
            .unwrap();

        let (last_idx, duration): (Option<i64>, i64) = sqlx::query_as(
            "SELECT last_sentence_index, duration_seconds FROM playback_history WHERE article_id = ?",
        )
        .bind(article.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(last_idx, None, "編集保存後は旧本文のレジューム位置が無効化されるべき");
        assert_eq!(duration, 300, "再生時間などの統計は保持されるべき");
    }

    #[tokio::test]
    async fn register_text_article_visible_via_get_articles() {
        let pool = setup_test_db().await;
        let registered = register_text_article_core(
            &pool,
            None,
            "記事取得 API で見えることを確認する本文です。".to_string(),
        )
        .await
        .unwrap();

        let repo = ArticleRepository::new(pool);
        let listed = repo.list(&ArticleFilter::default()).await.unwrap();
        let found = listed.iter().find(|a| a.id == registered.id).expect("一覧に含まれるべき");
        assert_eq!(found.status, "ready");
        assert_eq!(found.source_type, "text");
    }
}


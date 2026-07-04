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

// ─── Tauri コマンド ────────────────────────────────────────────────────────

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


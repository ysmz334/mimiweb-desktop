mod analysis;
mod commands;
mod db;
mod models;
mod repositories;
mod services;
mod state;

use std::sync::Arc;
use std::sync::OnceLock;
use state::AppState;
use services::VoicevoxManager;
use tauri::Manager;

static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            // ログファイルを %APPDATA%\com.mimiweb.desktop\logs\ に出力
            let log_dir = data_dir.join("logs");
            std::fs::create_dir_all(&log_dir)?;
            let file_appender = tracing_appender::rolling::daily(&log_dir, "mimiweb.log");
            let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
            LOG_GUARD.set(guard).ok();
            let _ = tracing_subscriber::fmt()
                .with_writer(non_blocking)
                .with_ansi(false)
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                )
                .try_init();

            let db_path = data_dir.join("mimiweb.db");
            let db_url = format!("sqlite:{}", db_path.display());

            let db = tauri::async_runtime::block_on(async {
                let pool = sqlx::sqlite::SqlitePoolOptions::new()
                    .connect_with(
                        db_url
                            .parse::<sqlx::sqlite::SqliteConnectOptions>()?
                            .create_if_missing(true)
                            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                            .foreign_keys(true),
                    )
                    .await?;
                sqlx::raw_sql(db::MIGRATION_SQL).execute(&pool).await?;
                // content_html カラムが存在しない既存 DB への後付けマイグレーション
                let col_exists: bool = sqlx::query_scalar(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'content_html'"
                )
                .fetch_one(&pool)
                .await?;
                if !col_exists {
                    sqlx::query("ALTER TABLE articles ADD COLUMN content_html TEXT")
                        .execute(&pool)
                        .await?;
                }
                // queue_items の article_id 一意インデックスを追加（既存 DB 用・重複があれば古い方を先に削除）
                let queue_idx_exists: bool = sqlx::query_scalar(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='index' AND name='idx_queue_article_id'"
                )
                .fetch_one(&pool)
                .await?;
                if !queue_idx_exists {
                    // 重複データがあれば最古を残して削除
                    sqlx::query(
                        "DELETE FROM queue_items WHERE id NOT IN (SELECT MIN(id) FROM queue_items GROUP BY article_id)"
                    )
                    .execute(&pool)
                    .await?;
                    sqlx::query(
                        "CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_article_id ON queue_items(article_id)"
                    )
                    .execute(&pool)
                    .await?;
                }
                // article_keywords テーブルを追加（既存 DB 用）
                let has_keywords_table: bool = sqlx::query_scalar(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='article_keywords'"
                )
                .fetch_one(&pool)
                .await?;
                if !has_keywords_table {
                    sqlx::query(
                        "CREATE TABLE article_keywords (
                            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
                            word TEXT NOT NULL,
                            count INTEGER NOT NULL DEFAULT 1,
                            PRIMARY KEY (article_id, word)
                        )"
                    )
                    .execute(&pool)
                    .await?;
                    sqlx::query(
                        "CREATE INDEX idx_article_keywords_word ON article_keywords(word)"
                    )
                    .execute(&pool)
                    .await?;
                }
                // articles の language カラムを追加（既存 DB 用）
                let has_language: bool = sqlx::query_scalar(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'language'"
                )
                .fetch_one(&pool)
                .await?;
                if !has_language {
                    sqlx::query("ALTER TABLE articles ADD COLUMN language TEXT NOT NULL DEFAULT 'ja'")
                        .execute(&pool)
                        .await?;
                }
                // articles の is_favorite カラムを追加（既存 DB 用）
                let has_is_favorite: bool = sqlx::query_scalar(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('articles') WHERE name = 'is_favorite'"
                )
                .fetch_one(&pool)
                .await?;
                if !has_is_favorite {
                    sqlx::query("ALTER TABLE articles ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0")
                        .execute(&pool)
                        .await?;
                }
                // playback_history の再生位置・開始時刻カラムを追加（既存 DB 用）
                let has_started_at: bool = sqlx::query_scalar(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('playback_history') WHERE name = 'started_at'"
                )
                .fetch_one(&pool)
                .await?;
                if !has_started_at {
                    sqlx::query("ALTER TABLE playback_history ADD COLUMN started_at TEXT")
                        .execute(&pool)
                        .await?;
                    sqlx::query("ALTER TABLE playback_history ADD COLUMN last_sentence_index INTEGER")
                        .execute(&pool)
                        .await?;
                    sqlx::query("ALTER TABLE playback_history ADD COLUMN sentence_count INTEGER")
                        .execute(&pool)
                        .await?;
                }
                Ok::<_, Box<dyn std::error::Error>>(pool)
            })?;

            let voicevox = Arc::new(VoicevoxManager::new());
            let app_state = AppState::new(db, Arc::clone(&voicevox));

            app.manage(app_state);

            let app_handle = app.handle().clone();
            let voicevox_for_start = Arc::clone(&voicevox);
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                use services::voicevox_manager::VoicevoxStatus;
                if let Err(e) = voicevox_for_start.start(&app_handle).await {
                    tracing::error!("Voicevox failed to start: {e}");
                    let failed = VoicevoxStatus::Failed { reason: e.to_string() };
                    *voicevox_for_start.status.lock().await = failed.clone();
                    let _ = app_handle.emit("voicevox:status-changed", &failed);
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // スクレイパーウィンドウ等の補助ウィンドウは通常のウィンドウ閉じ動作に任せる
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.voicevox.shutdown().await;
                    }
                    app.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::article::register_article,
            commands::article::get_articles,
            commands::article::delete_article,
            commands::article::retry_extract,
            commands::article::save_extracted_content,
            commands::article::mark_extraction_error,
            commands::article::fetch_page_html,
            commands::article::toggle_favorite,
            commands::queue::get_queue,
            commands::queue::add_to_queue,
            commands::queue::remove_from_queue,
            commands::queue::reorder_queue,
            commands::history::record_playback,
            commands::history::update_playback_progress,
            commands::history::get_history,
            commands::history::get_stats,
            commands::history::get_last_playback,
            commands::history::delete_history_item,
            commands::history::delete_all_history,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::get_voicevox_status,
            commands::settings::retry_voicevox_connection,
            commands::setup::check_engine_installed,
            commands::setup::download_engine,
            commands::keywords::get_article_keywords,
            commands::login::open_login_window,
            commands::piper::check_piper_installed,
            commands::piper::download_piper,
            commands::piper::synthesize_english,
            commands::update::check_for_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

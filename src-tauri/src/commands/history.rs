use tauri::State;

use crate::{
    models::history::{HistoryError, HistoryFilter, PlaybackHistory, Stats},
    repositories::history_repository::HistoryRepoError,
    state::AppState,
};

fn map_err(e: HistoryRepoError) -> HistoryError {
    HistoryError::DatabaseError {
        message: e.to_string(),
    }
}

#[tauri::command]
pub async fn record_playback(
    state: State<'_, AppState>,
    article_id: Option<i64>,
    duration_seconds: i64,
    started_at: Option<String>,
    last_sentence_index: Option<i64>,
    sentence_count: Option<i64>,
) -> Result<i64, HistoryError> {
    let history = state
        .history_repo()
        .record(article_id, duration_seconds, started_at, last_sentence_index, sentence_count)
        .await
        .map_err(map_err)?;
    Ok(history.id)
}

#[tauri::command]
pub async fn update_playback_progress(
    state: State<'_, AppState>,
    id: i64,
    last_sentence_index: Option<i64>,
    duration_seconds: i64,
) -> Result<(), HistoryError> {
    state
        .history_repo()
        .update_progress(id, last_sentence_index, duration_seconds)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    filter: Option<HistoryFilter>,
) -> Result<Vec<PlaybackHistory>, HistoryError> {
    state
        .history_repo()
        .list(&filter.unwrap_or_default())
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<Stats, HistoryError> {
    state.history_repo().get_stats().await.map_err(map_err)
}

#[tauri::command]
pub async fn get_last_playback(
    state: State<'_, AppState>,
    article_id: i64,
) -> Result<Option<PlaybackHistory>, HistoryError> {
    state
        .history_repo()
        .get_last_for_article(article_id)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn delete_history_item(state: State<'_, AppState>, id: i64) -> Result<(), HistoryError> {
    state
        .history_repo()
        .delete_by_id(id)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn delete_all_history(state: State<'_, AppState>) -> Result<(), HistoryError> {
    state
        .history_repo()
        .delete_all()
        .await
        .map(|_| ())
        .map_err(map_err)
}

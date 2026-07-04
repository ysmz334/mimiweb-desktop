use tauri::State;

use crate::{
    models::queue::{QueueError, QueueItem},
    repositories::queue_repository::QueueRepoError,
    state::AppState,
};

fn map_err(e: QueueRepoError) -> QueueError {
    match e {
        QueueRepoError::ArticleNotFound => QueueError::ArticleNotFound,
        QueueRepoError::ItemNotFound(_) => QueueError::ItemNotFound,
        QueueRepoError::AlreadyQueued => QueueError::AlreadyQueued,
        QueueRepoError::Database(e) => QueueError::DatabaseError {
            message: e.to_string(),
        },
    }
}

#[tauri::command]
pub async fn get_queue(state: State<'_, AppState>) -> Result<Vec<QueueItem>, QueueError> {
    state
        .queue_repo()
        .list()
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn add_to_queue(
    state: State<'_, AppState>,
    article_id: i64,
) -> Result<QueueItem, QueueError> {
    state
        .queue_repo()
        .add(article_id)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn remove_from_queue(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), QueueError> {
    state
        .queue_repo()
        .remove(id)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn reorder_queue(
    state: State<'_, AppState>,
    ordered_ids: Vec<i64>,
) -> Result<Vec<QueueItem>, QueueError> {
    state
        .queue_repo()
        .reorder(&ordered_ids)
        .await
        .map_err(map_err)
}

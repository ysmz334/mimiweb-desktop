use std::sync::Arc;
use tauri::State;

use crate::{
    models::settings::{PartialSettings, Settings, SettingsError},
    repositories::settings_repository::SettingsRepoError,
    services::voicevox_manager::VoicevoxStatus,
    state::AppState,
};

fn map_err(e: SettingsRepoError) -> SettingsError {
    SettingsError::DatabaseError {
        message: e.to_string(),
    }
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, SettingsError> {
    state.settings_repo().get_all().await.map_err(map_err)
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    settings: PartialSettings,
) -> Result<Settings, SettingsError> {
    state
        .settings_repo()
        .apply_partial(&settings)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn get_voicevox_status(state: State<'_, AppState>) -> Result<VoicevoxStatus, ()> {
    Ok(state.voicevox.current_status().await)
}

/// Voicevox エンジンへの接続を再試行する。
/// 非同期で再起動を開始し、即座に Starting ステータスを返す。
#[tauri::command]
pub async fn retry_voicevox_connection(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<VoicevoxStatus, ()> {
    use tauri::Emitter;

    let voicevox = Arc::clone(&state.voicevox);

    // 現在の子プロセスを停止してから再起動する
    voicevox.shutdown().await;

    let starting = VoicevoxStatus::Starting;
    *voicevox.status.lock().await = starting.clone();
    let _ = app.emit("voicevox:status-changed", &starting);

    tokio::spawn(async move {
        if let Err(e) = voicevox.start(&app).await {
            tracing::error!("Voicevox retry failed: {e}");
            let failed = VoicevoxStatus::Failed { reason: e.to_string() };
            *voicevox.status.lock().await = failed.clone();
            let _ = app.emit("voicevox:status-changed", &failed);
        }
    });

    Ok(starting)
}

use base64::Engine as _;
use tauri::AppHandle;

use crate::services::piper_manager::{self, PiperManager};

/// Piper がインストール済みか確認する。
#[tauri::command]
pub async fn check_piper_installed<R: tauri::Runtime>(app: AppHandle<R>) -> bool {
    piper_manager::is_installed(&app)
}

/// Piper バイナリとモデルをダウンロード・展開する。
/// 進捗は "piper-setup:progress" イベントで通知する。
#[tauri::command]
pub async fn download_piper<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
    PiperManager::new()
        .download(&app)
        .await
        .map_err(|e| e.to_string())
}

/// テキストを英語 TTS で合成し、WAV バイト列を base64 文字列で返す。
#[tauri::command]
pub async fn synthesize_english<R: tauri::Runtime>(
    app: AppHandle<R>,
    text: String,
) -> Result<String, String> {
    let wav = PiperManager::new()
        .synthesize(&app, &text)
        .await
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
}

use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

use crate::services::voicevox_manager::engine_directory;

// ダウンロード対象: VOICEVOX Engine Windows CPU 版 (LGPL v3)
// https://github.com/VOICEVOX/voicevox_engine
const ENGINE_VERSION: &str = "0.25.2";
const ENGINE_DOWNLOAD_URL: &str =
    "https://github.com/VOICEVOX/voicevox_engine/releases/download/\
     0.25.2/voicevox_engine-windows-cpu-0.25.2.7z.001";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// エンジンが利用可能かチェックする。
/// engine_directory() が解決するパスに run.exe が存在すれば true。
#[tauri::command]
pub async fn check_engine_installed<R: tauri::Runtime>(app: AppHandle<R>) -> bool {
    engine_directory(&app).join("run.exe").exists()
}

/// VOICEVOX エンジンを GitHub Releases からダウンロードして展開する。
/// 進捗は "engine-setup:progress" イベント（DownloadProgress）で通知する。
/// 展開フェーズに入ったら "engine-setup:extracting" を emit する。
/// 成功すると Ok(())、失敗すると Err(メッセージ) を返す。
#[tauri::command]
pub async fn download_engine<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri::Emitter;

    let tmp_dir = std::env::temp_dir().join("mimiweb-engine-setup");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| format!("一時ディレクトリの作成に失敗: {e}"))?;
    let archive_path = tmp_dir.join(format!("voicevox_engine-{ENGINE_VERSION}.7z.001"));

    // ── ① ダウンロード ──────────────────────────────────────────────────────
    download_with_progress(&app, ENGINE_DOWNLOAD_URL, &archive_path).await?;

    // ── ② 展開 ──────────────────────────────────────────────────────────────
    let _ = app.emit("engine-setup:extracting", ());

    let extract_dir = tmp_dir.join("extracted");
    if extract_dir.exists() {
        tokio::fs::remove_dir_all(&extract_dir)
            .await
            .map_err(|e| format!("展開先ディレクトリの削除に失敗: {e}"))?;
    }
    tokio::fs::create_dir_all(&extract_dir)
        .await
        .map_err(|e| format!("展開先ディレクトリの作成に失敗: {e}"))?;

    let archive_path_c = archive_path.clone();
    let extract_dir_c = extract_dir.clone();
    tokio::task::spawn_blocking(move || {
        sevenz_rust::decompress_file(&archive_path_c, &extract_dir_c)
    })
    .await
    .map_err(|e| format!("展開タスクのパニック: {e}"))?
    .map_err(|e| format!("7z 展開に失敗: {e}"))?;

    // ── ③ run.exe を含むサブディレクトリを探して移動 ───────────────────────
    let engine_src =
        find_engine_dir(&extract_dir).ok_or("展開物に run.exe が見つかりません")?;
    let engine_dst = engine_install_dir();

    if engine_dst.exists() {
        std::fs::remove_dir_all(&engine_dst)
            .map_err(|e| format!("既存エンジンディレクトリの削除に失敗: {e}"))?;
    }

    // 同一ドライブなら rename（高速）、そうでなければコピー後削除
    if std::fs::rename(&engine_src, &engine_dst).is_err() {
        copy_dir_all(&engine_src, &engine_dst)
            .map_err(|e| format!("エンジンファイルのコピーに失敗: {e}"))?;
    }

    // ── ④ 一時ファイル削除 ──────────────────────────────────────────────────
    let _ = std::fs::remove_dir_all(&tmp_dir);

    Ok(())
}

// ─── ヘルパー ──────────────────────────────────────────────────────────────

async fn download_with_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    use tauri::Emitter;

    let client = reqwest::Client::builder()
        .user_agent("mimiweb-desktop/engine-downloader")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ダウンロード開始に失敗: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP エラー: {}", resp.status()));
    }

    let total = resp.content_length();
    let mut downloaded = 0u64;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("ファイル作成に失敗: {e}"))?;

    let mut stream = resp;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("ダウンロード中にエラー: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("書き込みに失敗: {e}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "engine-setup:progress",
            DownloadProgress {
                downloaded,
                total,
            },
        );
    }

    file.flush()
        .await
        .map_err(|e| format!("フラッシュに失敗: {e}"))?;

    Ok(())
}

/// 展開ディレクトリ内を再帰的に探索し、run.exe を含む最初のディレクトリを返す。
fn find_engine_dir(root: &Path) -> Option<PathBuf> {
    if root.join("run.exe").exists() {
        return Some(root.to_path_buf());
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(found) = find_engine_dir(&entry.path()) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// エンジンの最終インストール先（exe 隣の voicevox_engine/）。
/// engine_directory() の ② ポータブルパスと同一。
fn engine_install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("voicevox_engine")))
        .unwrap_or_else(|| PathBuf::from("voicevox_engine"))
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), dst_path)?;
        }
    }
    Ok(())
}

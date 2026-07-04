use std::{net::TcpListener, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use serde::Serialize;
use tauri::Manager;
use tokio::{process::Child, sync::Mutex};
use thiserror::Error;

const DEFAULT_PORT: u16 = 50021;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const HEALTH_LOOP_INTERVAL: Duration = Duration::from_secs(5);
const MAX_RESTART_ATTEMPTS: u32 = 3;

// ─── ステータス型（フロントエンドの VoicevoxStatus に対応） ───────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum VoicevoxStatus {
    Starting,
    Ready { port: u16 },
    Restarting { attempt: u32 },
    Failed { reason: String },
    Stopping,
}

// ─── エラー型 ──────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum VoicevoxError {
    #[error("Engine startup timed out after {0}s")]
    StartupTimeout(u64),
    #[error("Failed to spawn Voicevox sidecar: {0}")]
    SpawnFailed(String),
    #[error("HTTP error: {0}")]
    Http(String),
}

// ─── VoicevoxManager ──────────────────────────────────────────────────────

pub struct VoicevoxManager {
    pub status: Arc<Mutex<VoicevoxStatus>>,
    active_port: Arc<Mutex<Option<u16>>>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Default for VoicevoxManager {
    fn default() -> Self {
        Self {
            status: Arc::new(Mutex::new(VoicevoxStatus::Starting)),
            active_port: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
        }
    }
}

impl VoicevoxManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn current_status(&self) -> VoicevoxStatus {
        self.status.lock().await.clone()
    }

    /// Voicevox エンジンを起動し、準備完了後にヘルスチェックループを開始する。
    pub async fn start<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), VoicevoxError> {
        use tauri::Emitter;

        let (spawned_child, port) = launch_sidecar(app).await?;

        *self.child.lock().await = Some(spawned_child);
        *self.active_port.lock().await = Some(port);

        let ready = VoicevoxStatus::Ready { port };
        *self.status.lock().await = ready.clone();
        let _ = app.emit("voicevox:status-changed", &ready);

        tracing::info!("Voicevox ready on port {port}");

        let status_arc = Arc::clone(&self.status);
        let port_arc = Arc::clone(&self.active_port);
        let child_arc = Arc::clone(&self.child);
        let app_clone = app.clone();
        tokio::spawn(health_loop(status_arc, port_arc, child_arc, app_clone));

        Ok(())
    }

    /// Voicevox プロセスを停止し、ステータスを Stopping に更新する。
    /// 既に Stopping 状態なら何もしない（冪等）。
    pub async fn shutdown(&self) {
        {
            let mut status = self.status.lock().await;
            if matches!(*status, VoicevoxStatus::Stopping) {
                return;
            }
            *status = VoicevoxStatus::Stopping;
        }

        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
        }

        tracing::info!("Voicevox stopped");
    }
}

// ─── プライベートヘルパー ──────────────────────────────────────────────────

async fn launch_sidecar<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(Child, u16), VoicevoxError> {
    use super::process_guard::attach_to_job_object;

    let port = find_available_port(DEFAULT_PORT).await;
    let engine_dir = engine_directory(app);
    let exe = engine_dir.join("run.exe");
    tracing::info!("Starting Voicevox: {} on port {port}", exe.display());

    let mut cmd = tokio::process::Command::new(&exe);
    cmd.args(["--port", &port.to_string()])
        .current_dir(&engine_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // リリースビルドでコンソールウィンドウが表示されないようにする
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| VoicevoxError::SpawnFailed(format!("spawn failed: {e}")))?;

    // stdout/stderr を非同期で消費してパイプバッファがブロックしないようにする
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(drain_lines(stdout, false));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain_lines(stderr, true));
    }

    if let Some(pid) = child.id() {
        if let Err(e) = attach_to_job_object(pid) {
            tracing::warn!("Failed to attach Voicevox to job object: {e}");
        }
    }

    wait_for_engine_ready(port, STARTUP_TIMEOUT).await?;
    Ok((child, port))
}

/// エンジンバイナリと model/ が置かれているディレクトリを返す。
pub(crate) fn engine_directory<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    // ① 開発ビルド: コンパイル時の src-tauri/ 直下を基点にする
    #[cfg(debug_assertions)]
    {
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("voicevox_engine-windows-cpu-0.25.2")
            .join("windows-cpu");
        if dev_dir.exists() {
            return dev_dir;
        }
    }

    // ② ポータブル配布: exe と同階層の voicevox_engine/ を優先する
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let portable = exe_dir.join("voicevox_engine");
            if portable.exists() {
                return portable;
            }
        }
    }

    // ③ インストーラー配布: Tauri リソースディレクトリ内の voicevox_engine/
    app.path()
        .resource_dir()
        .map(|d| d.join("voicevox_engine"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// プロセスの stdout または stderr を行単位で読んでログに記録し、バッファブロックを防ぐ。
async fn drain_lines<R>(reader: R, is_stderr: bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if is_stderr {
            tracing::debug!("[voicevox stderr] {line}");
        } else {
            tracing::debug!("[voicevox] {line}");
        }
    }
}

async fn health_loop<R: tauri::Runtime>(
    status: Arc<Mutex<VoicevoxStatus>>,
    active_port: Arc<Mutex<Option<u16>>>,
    child: Arc<Mutex<Option<Child>>>,
    app: tauri::AppHandle<R>,
) {
    use tauri::Emitter;

    let mut consecutive_failures = 0u32;

    loop {
        tokio::time::sleep(HEALTH_LOOP_INTERVAL).await;

        // Stopping または Starting (retry 開始) でループを終了する
        if matches!(
            *status.lock().await,
            VoicevoxStatus::Stopping | VoicevoxStatus::Starting
        ) {
            break;
        }

        let port = match *active_port.lock().await {
            Some(p) => p,
            None => break,
        };

        if check_health(port).await {
            consecutive_failures = 0;
            continue;
        }

        consecutive_failures += 1;
        tracing::warn!(
            "Voicevox health check failed ({consecutive_failures}/{MAX_RESTART_ATTEMPTS})"
        );

        if consecutive_failures > MAX_RESTART_ATTEMPTS {
            let failed = VoicevoxStatus::Failed {
                reason: format!(
                    "連続 {} 回の再起動に失敗しました",
                    MAX_RESTART_ATTEMPTS
                ),
            };
            *status.lock().await = failed.clone();
            let _ = app.emit("voicevox:status-changed", &failed);
            break;
        }

        let restarting = VoicevoxStatus::Restarting {
            attempt: consecutive_failures,
        };
        *status.lock().await = restarting.clone();
        let _ = app.emit("voicevox:status-changed", &restarting);

        match launch_sidecar(&app).await {
            Ok((new_child, new_port)) => {
                consecutive_failures = 0;
                *child.lock().await = Some(new_child);
                *active_port.lock().await = Some(new_port);
                let ready = VoicevoxStatus::Ready { port: new_port };
                *status.lock().await = ready.clone();
                let _ = app.emit("voicevox:status-changed", &ready);
                tracing::info!("Voicevox restarted on port {new_port}");
            }
            Err(e) => {
                tracing::error!(
                    "Voicevox restart attempt {consecutive_failures} failed: {e}"
                );
            }
        }
    }
}

// ─── 公開ヘルパー関数（テスト対象） ─────────────────────────────────────

/// デフォルトポートが使用中なら空きポートを返す。
pub async fn find_available_port(default_port: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", default_port)).is_ok() {
        return default_port;
    }
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(default_port + 1)
}

/// `http://127.0.0.1:{port}/version` が 200 を返すまでポーリングする。
pub async fn wait_for_engine_ready(
    port: u16,
    timeout: Duration,
) -> Result<(), VoicevoxError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| VoicevoxError::Http(e.to_string()))?;

    let url = format!("http://127.0.0.1:{port}/version");

    tokio::time::timeout(timeout, async {
        loop {
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    return Ok::<(), VoicevoxError>(());
                }
            }
            tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
        }
    })
    .await
    .map_err(|_| VoicevoxError::StartupTimeout(timeout.as_secs()))?
}

/// `/version` エンドポイントが 200 を返すかどうか確認する（1 回のみ）。
pub async fn check_health(port: u16) -> bool {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .get(format!("http://127.0.0.1:{port}/version"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

// ─── テスト ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn port_from_mock_url(url: &str) -> u16 {
        url.rsplit(':').next().unwrap().parse().unwrap()
    }

    // ── find_available_port ──

    #[tokio::test]
    async fn find_available_port_returns_default_when_free() {
        let port = find_available_port(59990).await;
        assert!(port > 0);
    }

    #[tokio::test]
    async fn find_available_port_returns_different_when_busy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = listener.local_addr().unwrap().port();

        let port = find_available_port(busy).await;
        drop(listener);

        assert_ne!(port, busy, "使用中のポートとは別のポートが返るべき");
    }

    // ── wait_for_engine_ready ──

    #[tokio::test]
    async fn wait_for_engine_ready_succeeds_on_http_200() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/version")
            .with_status(200)
            .with_body("0.25.2")
            .create_async()
            .await;

        let port = port_from_mock_url(&server.url());
        let result = wait_for_engine_ready(port, Duration::from_secs(5)).await;
        assert!(result.is_ok(), "HTTP 200 で成功するべき");
    }

    #[tokio::test]
    async fn wait_for_engine_ready_times_out_when_unreachable() {
        let result = wait_for_engine_ready(1, Duration::from_millis(300)).await;
        assert!(
            matches!(result, Err(VoicevoxError::StartupTimeout(_))),
            "到達不能なサーバーではタイムアウトするべき"
        );
    }

    #[tokio::test]
    async fn wait_for_engine_ready_retries_past_non_200() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/version")
            .with_status(200)
            .with_body("0.25.2")
            .create_async()
            .await;
        server
            .mock("GET", "/version")
            .with_status(503)
            .expect(1)
            .create_async()
            .await;

        let port = port_from_mock_url(&server.url());
        let result = wait_for_engine_ready(port, Duration::from_secs(5)).await;
        assert!(result.is_ok(), "503 の後 200 が返れば成功するべき");
    }

    #[tokio::test]
    async fn wait_for_engine_ready_fails_if_always_503() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/version")
            .with_status(503)
            .create_async()
            .await;

        let port = port_from_mock_url(&server.url());
        let result = wait_for_engine_ready(port, Duration::from_millis(800)).await;
        assert!(
            matches!(result, Err(VoicevoxError::StartupTimeout(_))),
            "常に 503 ならタイムアウトするべき"
        );
    }

    // ── check_health ──

    #[tokio::test]
    async fn check_health_returns_true_on_200() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/version")
            .with_status(200)
            .with_body("0.25.2")
            .create_async()
            .await;

        let port = port_from_mock_url(&server.url());
        assert!(check_health(port).await, "200 では true を返すべき");
    }

    #[tokio::test]
    async fn check_health_returns_false_when_unreachable() {
        assert!(!check_health(1).await, "到達不能なサーバーでは false を返すべき");
    }

    #[tokio::test]
    async fn check_health_returns_false_on_non_200() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/version")
            .with_status(503)
            .create_async()
            .await;

        let port = port_from_mock_url(&server.url());
        assert!(!check_health(port).await, "503 では false を返すべき");
    }

    // ── shutdown ──

    #[tokio::test]
    async fn shutdown_sets_status_to_stopping() {
        let manager = VoicevoxManager::new();
        manager.shutdown().await;
        assert!(
            matches!(*manager.status.lock().await, VoicevoxStatus::Stopping),
            "shutdown 後は Stopping になるべき"
        );
    }

    #[tokio::test]
    async fn shutdown_is_idempotent() {
        let manager = VoicevoxManager::new();
        manager.shutdown().await;
        manager.shutdown().await; // 2 回目もパニック・デッドロックしない
        assert!(matches!(*manager.status.lock().await, VoicevoxStatus::Stopping));
    }
}

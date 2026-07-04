use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub async fn open_login_window(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: reqwest::Url = url
        .parse()
        .map_err(|_| format!("無効な URL: {url}"))?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("http または https の URL を指定してください".to_string());
    }

    let domain = parsed.host_str().unwrap_or("site").to_string();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let label = format!("login-{ts}");
    let title = format!("ログイン - {domain}");
    let app_for_main = app.clone();

    app.run_on_main_thread(move || {
        if let Err(e) = WebviewWindowBuilder::new(
            &app_for_main,
            &label,
            WebviewUrl::External(parsed),
        )
        .title(&title)
        .inner_size(1100.0, 760.0)
        .resizable(true)
        .visible(true)
        .build()
        {
            tracing::error!("Login window build error: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

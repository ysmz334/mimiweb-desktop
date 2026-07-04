use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const HTML_RELAY_TIMEOUT: Duration = Duration::from_secs(40);
/// window.load 後に JS hydration を待つ時間
const JS_HYDRATION_WAIT_MS: u64 = 3000;

/// Private Network Access プリフライトと POST 両方に対応する最小 HTTP リレーサーバー。
/// XHR は text/plain で送られるため preflight が必要な場合がある。
async fn serve_relay(listener: TcpListener) -> Result<String, String> {
    // CORS + Private Network Access ヘッダー
    let cors = concat!(
        "Access-Control-Allow-Origin: *\r\n",
        "Access-Control-Allow-Methods: POST, OPTIONS\r\n",
        "Access-Control-Allow-Headers: Content-Type\r\n",
        "Access-Control-Allow-Private-Network: true\r\n",
    );

    // OPTIONS preflight → POST の順で最大 4 接続を処理する
    for _ in 0..4 {
        let (mut stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => return Err(format!("Relay accept error: {e}")),
        };

        // ヘッダー末尾 \r\n\r\n まで読む（最大 10 MB バッファ）
        let mut buf = vec![0u8; 10 * 1024 * 1024];
        let mut total = 0usize;

        loop {
            if total >= buf.len() {
                buf.resize(buf.len() * 2, 0);
            }
            let n = stream.read(&mut buf[total..]).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            total += n;
            if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }

        let header_end = match buf[..total].windows(4).position(|w| w == b"\r\n\r\n") {
            Some(p) => p,
            None => continue,
        };

        let headers_str = String::from_utf8_lossy(&buf[..header_end]);
        let first_line = headers_str.lines().next().unwrap_or("");

        // OPTIONS プリフライト
        if first_line.starts_with("OPTIONS") {
            let resp = format!("HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\n\r\n");
            let _ = stream.write_all(resp.as_bytes()).await;
            continue; // 次の接続（実際の POST）を待つ
        }

        // POST: ボディを読む
        if first_line.starts_with("POST") {
            let body_start = header_end + 4;
            let cl = parse_content_length(&headers_str);

            if let Some(length) = cl {
                // Content-Length 指定あり: 正確に読む
                while total < body_start + length {
                    if total >= buf.len() {
                        buf.resize(buf.len() * 2, 0);
                    }
                    let n = stream.read(&mut buf[total..]).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    total += n;
                }
                let end = (body_start + length).min(total);
                let html = String::from_utf8_lossy(&buf[body_start..end]).into_owned();
                let resp = format!("HTTP/1.1 200 OK\r\n{cors}Content-Length: 0\r\n\r\n");
                let _ = stream.write_all(resp.as_bytes()).await;
                if !html.is_empty() {
                    return Ok(html);
                }
            } else {
                // Content-Length なし: EOF まで読む
                loop {
                    if total >= buf.len() {
                        buf.resize(buf.len() * 2, 0);
                    }
                    let n = stream.read(&mut buf[total..]).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    total += n;
                }
                let html = String::from_utf8_lossy(&buf[body_start..total]).into_owned();
                let resp = format!("HTTP/1.1 200 OK\r\n{cors}Content-Length: 0\r\n\r\n");
                let _ = stream.write_all(resp.as_bytes()).await;
                if !html.is_empty() {
                    return Ok(html);
                }
            }
        }
    }

    Err("Relay server exhausted connections without receiving HTML".to_string())
}

fn parse_content_length(headers: &str) -> Option<usize> {
    headers
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l[15..].trim().parse().ok())
}

/// スクレイピング用ウィンドウで全メディア要素の再生をブロックする初期化スクリプト。
/// HTMLMediaElement.prototype.play を上書きして即 resolve するだけにし、
/// 非表示ウィンドウからの意図しない音声出力を防ぐ。
const MEDIA_BLOCK_SCRIPT: &str = r#"(function() {
    try {
        HTMLMediaElement.prototype.play = function() {
            this.muted = true;
            return Promise.resolve();
        };
    } catch(e) {}
})();"#;

/// 隠し WebviewWindow でページを完全レンダリングし、JS 実行後の HTML を返す。
///
/// ローカル HTTP サーバー（127.0.0.1:0）をリレーとして使用するため
/// Tauri IPC や capability 設定が不要。
pub async fn fetch_with_webview(
    app: &AppHandle,
    url: &str,
    article_id: i64,
) -> Result<String, String> {
    let label = format!("scraper-{}", article_id);

    // ランダムポートでリレーサーバーを起動
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind relay server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let (html_tx, html_rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let relay_timeout = HTML_RELAY_TIMEOUT + Duration::from_secs(5);
    tokio::spawn(async move {
        let result =
            tokio::time::timeout(relay_timeout, serve_relay(listener))
                .await
                .unwrap_or_else(|_| Err("Relay server timed out".to_string()));
        let _ = html_tx.send(result);
    });

    // ページロード後に XHR で HTML をローカルサーバーへ POST する init スクリプト。
    // - ホスト名＋パス名チェック: リダイレクト先の別ドメインページを誤ってキャプチャしない。
    // - サイズチェック: 10 KB 未満ならコンテンツ未ロードと判断してリトライ（最大 5 回）。
    // - init スクリプトはナビゲーション毎に再実行されるため、各ページで独立して動作する。

    // URL を JSON 文字列としてエスケープして JS リテラルに安全に埋め込む。
    // そのまま埋め込むと URL 内の ' や \ で JS 構文が壊れる可能性がある。
    let url_json = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string());

    let init_script = format!(
        r#"(function() {{
            var _sent = false;
            var _retries = 0;
            var _targetHostname = '';
            var _targetPathname = '';
            try {{
                var _tUrl = new URL({url_json});
                _targetHostname = _tUrl.hostname;
                _targetPathname = _tUrl.pathname;
            }} catch(e) {{}}

            function normPath(p) {{
                return p.replace(/\.[^.\/]+$/, '').replace(/\/$/, '');
            }}
            var _targetPathNorm = normPath(_targetPathname);

            function isOnTargetPage() {{
                if (!_targetHostname) return true;
                if (window.location.hostname !== _targetHostname) return false;
                var actualNorm = normPath(window.location.pathname);
                return actualNorm === _targetPathNorm || actualNorm.startsWith(_targetPathNorm + '/');
            }}

            function hasReadableContent() {{
                var h1 = document.querySelector('h1');
                if (h1 && h1.textContent.trim().length > 0) return true;
                var pText = 0;
                var ps = document.querySelectorAll('p');
                for (var i = 0; i < ps.length; i++) {{
                    pText += (ps[i].textContent || '').trim().length;
                    if (pText > 200) return true;
                }}
                return false;
            }}

            function tryToSend() {{
                if (_sent) return;
                if (!isOnTargetPage()) return;
                var html = document.documentElement.outerHTML;
                var ready = html.length >= 10000 && hasReadableContent();
                if (!ready && _retries < 8) {{
                    _retries++;
                    setTimeout(tryToSend, 2000);
                    return;
                }}
                _sent = true;
                try {{
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', 'http://127.0.0.1:{port}/', true);
                    xhr.setRequestHeader('Content-Type', 'text/plain; charset=utf-8');
                    xhr.send(html);
                }} catch(e) {{
                    console.error('[scraper] XHR failed:', e);
                }}
            }}

            if (document.readyState === 'complete') {{
                setTimeout(tryToSend, {wait_ms});
            }} else {{
                window.addEventListener('load', function() {{
                    setTimeout(tryToSend, {wait_ms});
                }});
            }}
        }})();"#,
        url_json = url_json,
        port = port,
        wait_ms = JS_HYDRATION_WAIT_MS,
    );

    // WebView2 ウィンドウはメインスレッドで生成する必要がある
    let (win_tx, win_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    let label_for_main = label.clone();
    let url_string = url.to_string();
    let init_for_main = init_script;

    app.run_on_main_thread(move || {
        let result: Result<(), String> = (|| {
            let parsed: reqwest::Url = url_string
                .parse()
                .map_err(|_| format!("Invalid URL: {url_string}"))?;
            WebviewWindowBuilder::new(
                &app_for_main,
                &label_for_main,
                WebviewUrl::External(parsed),
            )
            .visible(false)
            .initialization_script(MEDIA_BLOCK_SCRIPT)
            .initialization_script(&init_for_main)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string())
        })();
        let _ = win_tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    // メインスレッドでのウィンドウ生成完了を待つ
    win_rx
        .await
        .map_err(|_| "Window creation channel closed".to_string())?
        .map_err(|e| e)?;

    // HTML が届くまで待機
    let result = tokio::time::timeout(HTML_RELAY_TIMEOUT, html_rx).await;

    // ウィンドウを閉じる（on_window_event は "main" のみ処理するため安全）
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }

    match result {
        Ok(Ok(Ok(html))) => Ok(html),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("HTML relay channel closed unexpectedly".to_string()),
        Err(_) => Err(format!("Timed out waiting for page content: {url}")),
    }
}

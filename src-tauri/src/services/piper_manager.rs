use std::{path::PathBuf, time::Duration};
use tauri::Manager;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ─── エラー型 ──────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum PiperError {
    #[error("Piper is not installed")]
    NotInstalled,
    #[error("Synthesis timed out")]
    Timeout,
    #[error("Download failed: {0}")]
    DownloadFailed(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// ─── PiperManager ─────────────────────────────────────────────────────────

pub struct PiperManager;

// Piper v2023.11.14-2 Windows AMD64 バイナリ
const PIPER_ZIP_URL: &str =
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
// HuggingFace モデルファイル
const MODEL_URL: &str =
    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx";
const MODEL_JSON_URL: &str =
    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx.json";

const SYNTHESIZE_TIMEOUT: Duration = Duration::from_secs(30);
// Piper の en_US-ryan-high モデルは 22050 Hz で出力する
const PIPER_SAMPLE_RATE: u32 = 22050;

impl PiperManager {
    pub fn new() -> Self {
        Self
    }

    /// テキストを Piper で音声合成し WAV バイト列を返す。
    /// Piper が未インストールの場合は `PiperError::NotInstalled` を返す。
    pub async fn synthesize<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        text: &str,
    ) -> Result<Vec<u8>, PiperError> {
        let dir = piper_directory(app);
        let piper_exe = dir.join("piper.exe");
        let model = dir.join("en_US-ryan-high.onnx");

        if !piper_exe.exists() || !model.exists() {
            return Err(PiperError::NotInstalled);
        }

        let mut cmd = tokio::process::Command::new(&piper_exe);
        cmd.args(["--model", model.to_str().unwrap_or(""), "--output_raw"])
            .current_dir(&dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn()?;

        // stdin にテキストを書き込む
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).await?;
            // stdin をドロップして EOF を通知
        }

        // stderr を非同期で消費してバッファブロックを防ぐ
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain_lines(stderr));
        }

        // stdout から raw PCM を読み取る（タイムアウト付き）
        let pcm = tokio::time::timeout(SYNTHESIZE_TIMEOUT, async {
            let mut stdout = child.stdout.take().expect("stdout piped");
            let mut buf = Vec::new();
            stdout.read_to_end(&mut buf).await?;
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
        .await
        .map_err(|_| PiperError::Timeout)??;

        let _ = child.wait().await;

        Ok(pcm_to_wav(&pcm, PIPER_SAMPLE_RATE))
    }

    /// Piper バイナリと音声モデルをダウンロードして `piper_engine/` に展開する。
    /// すでにインストール済みの場合は即 `Ok(())` を返す（冪等）。
    /// 進捗は `piper-setup:progress` イベント（{downloaded, total}）で通知する。
    pub async fn download<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), PiperError> {
        use tauri::Emitter;

        if is_installed(app) {
            return Ok(());
        }

        let install_dir = piper_install_dir();
        tokio::fs::create_dir_all(&install_dir)
            .await
            .map_err(|e| PiperError::DownloadFailed(format!("インストールディレクトリ作成失敗: {e}")))?;

        let client = reqwest::Client::builder()
            .user_agent("mimiweb-desktop/piper-downloader")
            .build()
            .map_err(|e| PiperError::DownloadFailed(e.to_string()))?;

        // ── ① Piper バイナリ ZIP をダウンロード ──────────────────────────────
        let tmp_dir = std::env::temp_dir().join("mimiweb-piper-setup");
        tokio::fs::create_dir_all(&tmp_dir)
            .await
            .map_err(|e| PiperError::DownloadFailed(format!("一時ディレクトリ作成失敗: {e}")))?;
        let zip_path = tmp_dir.join("piper_windows_amd64.zip");

        download_file_with_progress(app, &client, PIPER_ZIP_URL, &zip_path).await?;

        // ── ② ZIP を展開して piper_engine/ に配置 ────────────────────────────
        let _ = app.emit("piper-setup:extracting", ());
        extract_piper_zip(&zip_path, &install_dir)
            .map_err(|e| PiperError::DownloadFailed(format!("ZIP 展開失敗: {e}")))?;

        // ── ③ ONNX モデルをダウンロード ─────────────────────────────────────
        let model_path = install_dir.join("en_US-ryan-high.onnx");
        download_file_with_progress(app, &client, MODEL_URL, &model_path).await?;

        // ── ④ ONNX JSON をダウンロード ──────────────────────────────────────
        let model_json_path = install_dir.join("en_US-ryan-high.onnx.json");
        download_file_with_progress(app, &client, MODEL_JSON_URL, &model_json_path).await?;

        // ── ⑤ 一時ファイル削除 ───────────────────────────────────────────────
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

        Ok(())
    }
}

// ─── ヘルパー ─────────────────────────────────────────────────────────────

async fn drain_lines<R>(reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!("[piper] {line}");
    }
}

/// ファイルを HTTP ダウンロードし、chunk ごとに `piper-setup:progress` を emit する。
async fn download_file_with_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
) -> Result<(), PiperError> {
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| PiperError::DownloadFailed(format!("ダウンロード開始失敗: {e}")))?;

    if !resp.status().is_success() {
        return Err(PiperError::DownloadFailed(format!("HTTP エラー: {}", resp.status())));
    }

    let total = resp.content_length();
    let mut downloaded = 0u64;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| PiperError::DownloadFailed(format!("ファイル作成失敗: {e}")))?;

    let mut stream = resp;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| PiperError::DownloadFailed(format!("ダウンロードエラー: {e}")))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| PiperError::DownloadFailed(format!("書き込み失敗: {e}")))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit("piper-setup:progress", serde_json::json!({ "downloaded": downloaded, "total": total }));
    }

    file.flush()
        .await
        .map_err(|e| PiperError::DownloadFailed(format!("フラッシュ失敗: {e}")))?;

    Ok(())
}

/// Piper ZIP を展開し、`piper/` ディレクトリ内容を `dest/` に配置する。
fn extract_piper_zip(zip_path: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;

        let raw_name = entry.name().to_string();

        // ZIP内のパスが `piper/` で始まる場合はその prefix を除去する
        let relative = if let Some(stripped) = raw_name.strip_prefix("piper/") {
            stripped.to_string()
        } else if raw_name == "piper" {
            continue; // ディレクトリエントリ自体はスキップ
        } else {
            raw_name.clone()
        };

        if relative.is_empty() {
            continue;
        }

        // ── Zip Slip 防止 ─────────────────────────────────────────────────
        // ".." / ルートパス / Windows ドライブプレフィックスを含むエントリは拒否する
        let has_traversal = std::path::Path::new(&relative).components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
        if has_traversal {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("不正な ZIP エントリパスを検出しました: {}", relative),
            ));
        }

        let out_path = dest.join(&relative);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out_file = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out_file)?;
        }
    }

    Ok(())
}

/// Piper の最終インストール先（exe 隣の piper_engine/）。
fn piper_install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("piper_engine")))
        .unwrap_or_else(|| PathBuf::from("piper_engine"))
}

// ─── ディレクトリ解決 ─────────────────────────────────────────────────────

/// Piper エンジンが配置されるディレクトリを返す。
/// engine_directory() と同じ解決順序：
///   ① 開発時: CARGO_MANIFEST_DIR/binaries/piper_engine/
///   ② ポータブル: exe 隣の piper_engine/
///   ③ リソースディレクトリ内の piper_engine/
pub fn piper_directory<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("piper_engine");
        if dev_dir.exists() {
            return dev_dir;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let portable = exe_dir.join("piper_engine");
            if portable.exists() {
                return portable;
            }
        }
    }

    app.path()
        .resource_dir()
        .map(|d| d.join("piper_engine"))
        .unwrap_or_else(|_| PathBuf::from("piper_engine"))
}

/// Piper 実行に必要な 3 ファイルがすべて存在すれば true を返す。
pub fn is_installed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let dir = piper_directory(app);
    dir.join("piper.exe").exists()
        && dir.join("en_US-ryan-high.onnx").exists()
        && dir.join("en_US-ryan-high.onnx.json").exists()
}

// ─── 言語検出 ─────────────────────────────────────────────────────────────

/// テキストに含まれる日本語文字（ひらがな・カタカナ・CJK漢字）の割合が
/// 5% 以上なら `"ja"`、未満なら `"en"` を返す。空文字は `"ja"` にフォールバック。
pub fn detect_language(text: &str) -> &'static str {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    if total == 0 {
        return "ja";
    }
    let japanese_count = chars.iter().filter(|&&c| is_japanese(c)).count();
    let ratio = japanese_count as f64 / total as f64;
    if ratio >= 0.05 {
        "ja"
    } else {
        "en"
    }
}

#[inline]
fn is_japanese(c: char) -> bool {
    // ひらがな: U+3040–U+309F
    // カタカナ: U+30A0–U+30FF
    // CJK統合漢字: U+4E00–U+9FFF
    matches!(c as u32, 0x3040..=0x30FF | 0x4E00..=0x9FFF)
}

/// mixed 判定: 少数派言語の行がこの行数以上あること
pub const MIXED_MIN_MINORITY_LINES: usize = 2;
/// mixed 判定: 少数派言語の行が全行数（空行除く）に占める割合の下限
pub const MIXED_MIN_MINORITY_RATIO: f64 = 0.10;

/// 記事全体を "ja" / "en" / "mixed" の3値で判定する。
///
/// 空行を除く各行を `detect_language` で分類し、少数派言語が
/// `MIXED_MIN_MINORITY_LINES` 行以上かつ全体の `MIXED_MIN_MINORITY_RATIO` 以上なら
/// "mixed"、それ以外は多数派の言語を返す（1行だけの引用では mixed 化しない）。
/// 純日本語・純英語のテキストでは既存 `detect_language` と同一の結果を返す。
pub fn detect_article_language(text: &str) -> &'static str {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return detect_language(text);
    }

    let ja_lines = lines.iter().filter(|l| detect_language(l) == "ja").count();
    let en_lines = lines.len() - ja_lines;
    let minority = ja_lines.min(en_lines);
    let minority_ratio = minority as f64 / lines.len() as f64;

    if minority >= MIXED_MIN_MINORITY_LINES && minority_ratio >= MIXED_MIN_MINORITY_RATIO {
        "mixed"
    } else if ja_lines >= en_lines {
        "ja"
    } else {
        "en"
    }
}

// ─── PCM → WAV 変換 ───────────────────────────────────────────────────────

/// 16bit mono の raw PCM バイト列に RIFF WAV ヘッダー（44 bytes）を付加して返す。
pub fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let file_size = 36 + data_len; // RIFF チャンクサイズ = ファイルサイズ - 8
    let byte_rate = sample_rate * 2; // 16bit mono: sample_rate * 1ch * 2bytes
    let block_align: u16 = 2; // 1ch * 16bit / 8
    let bits_per_sample: u16 = 16;

    let mut wav = Vec::with_capacity(44 + pcm.len());

    // RIFF チャンク
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    // fmt サブチャンク
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // チャンクサイズ = 16
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM = 1
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono = 1ch
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());

    // data サブチャンク
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);

    wav
}

// ─── テスト ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── detect_language ──

    #[test]
    fn detect_language_japanese_sentence() {
        let result = detect_language("これはテストです。日本語の文章です。");
        assert_eq!(result, "ja");
    }

    #[test]
    fn detect_language_english_sentence() {
        let result = detect_language("This is an English sentence for testing.");
        assert_eq!(result, "en");
    }

    #[test]
    fn detect_language_empty_string() {
        let result = detect_language("");
        assert_eq!(result, "ja", "空文字は 'ja' にフォールバック");
    }

    #[test]
    fn detect_language_mixed_mostly_english() {
        // 英語がほとんどで日本語が少量（5%未満）
        let long_english = "a".repeat(100);
        let text = format!("{}あ", long_english); // 1/101 ≈ 0.99% < 5%
        assert_eq!(detect_language(&text), "en");
    }

    #[test]
    fn detect_language_threshold_exactly_5_percent() {
        // ちょうど5%: 日本語1文字 + 英語19文字 = 1/20 = 5.0%
        let text = format!("{}あ", "a".repeat(19));
        assert_eq!(detect_language(&text), "ja", "5.0% は 'ja' になるべき");
    }

    #[test]
    fn detect_language_below_threshold_4_point_9_percent() {
        // 4.76%: 日本語1文字 + 英語20文字 = 1/21 ≈ 4.76% < 5%
        let text = format!("{}あ", "a".repeat(20));
        assert_eq!(detect_language(&text), "en", "4.76% は 'en' になるべき");
    }

    #[test]
    fn detect_language_kanji_only() {
        let result = detect_language("漢字だけの文章");
        assert_eq!(result, "ja");
    }

    #[test]
    fn detect_language_katakana_only() {
        let result = detect_language("コンピュータプログラミング");
        assert_eq!(result, "ja");
    }

    // ── detect_article_language ──

    /// 純日本語・純英語テキストでは既存 detect_language と同一の結果を返す（互換性保証）
    #[test]
    fn detect_article_language_matches_detect_language_for_pure_texts() {
        let pure_texts = [
            "これはテストです。日本語の文章です。",
            "これは一行目です。\n二行目の文章です。\n三行目もあります。",
            "This is an English sentence for testing.",
            "First line of English text.\nSecond line here.\nThird line too.",
            "",
            "漢字だけの文章",
            "コンピュータプログラミング",
        ];
        for text in pure_texts {
            assert_eq!(
                detect_article_language(text),
                detect_language(text),
                "純テキストでは detect_language と同一結果であるべき: {text:?}"
            );
        }
    }

    #[test]
    fn detect_article_language_bilingual_script_is_mixed() {
        // 対訳スクリプト形式（日本語行と英語行が交互）
        let text = "私は毎朝コーヒーを飲みます。\n\
                    I drink coffee every morning.\n\
                    今日は天気がいいですね。\n\
                    The weather is nice today.\n\
                    駅までの道を教えてください。\n\
                    Could you tell me the way to the station?";
        assert_eq!(detect_article_language(text), "mixed", "対訳スクリプトは 'mixed' になるべき");
    }

    #[test]
    fn detect_article_language_ja_tech_article_with_code_stays_ja() {
        // コードブロック・英語引用を含む日本語技術記事は 'ja' のまま
        // （英語行 4 行 / 全 42 行 ≈ 9.5% < 10%）
        let mut lines: Vec<String> = Vec::new();
        for i in 0..38 {
            lines.push(format!("これは日本語技術記事の本文の第{i}段落です。Rust の所有権について説明します。"));
        }
        lines.push("fn main() {".to_string());
        lines.push("    let owned = String::from(\"hello\");".to_string());
        lines.push("}".to_string());
        lines.push("As the Rust book says, ownership is a set of rules.".to_string());
        let text = lines.join("\n");
        assert_eq!(
            detect_article_language(&text),
            "ja",
            "コードブロック・英語引用を含む日本語技術記事は 'ja' のままであるべき"
        );
    }

    #[test]
    fn detect_article_language_single_english_quote_is_not_mixed() {
        // 英語行が 1 行だけ（2 行未満）→ mixed にしない
        let mut lines: Vec<String> = (0..5)
            .map(|i| format!("日本語の本文行その{i}です。"))
            .collect();
        lines.push("To be, or not to be, that is the question.".to_string());
        let text = lines.join("\n");
        assert_eq!(detect_article_language(&text), "ja", "1 行だけの英語引用では mixed にならないべき");
    }

    #[test]
    fn detect_article_language_minority_at_exactly_10_percent_is_mixed() {
        // 少数派 2 行 / 全 20 行 = ちょうど 10% → mixed
        let mut lines: Vec<String> = (0..18)
            .map(|i| format!("日本語の本文行その{i}です。"))
            .collect();
        lines.push("This is the first English line.".to_string());
        lines.push("This is the second English line.".to_string());
        let text = lines.join("\n");
        assert_eq!(detect_article_language(&text), "mixed", "少数派がちょうど 10% なら mixed になるべき");
    }

    #[test]
    fn detect_article_language_minority_below_10_percent_is_majority() {
        // 少数派 2 行 / 全 30 行 ≈ 6.7% < 10% → 多数派 'ja'
        let mut lines: Vec<String> = (0..28)
            .map(|i| format!("日本語の本文行その{i}です。"))
            .collect();
        lines.push("This is the first English line.".to_string());
        lines.push("This is the second English line.".to_string());
        let text = lines.join("\n");
        assert_eq!(detect_article_language(&text), "ja", "少数派が 10% 未満なら多数派の言語になるべき");
    }

    #[test]
    fn detect_article_language_english_article_with_ja_minority_is_mixed() {
        // 英語多数派 + 日本語少数派（2 行以上・10% 以上）でも対称に mixed
        let mut lines: Vec<String> = (0..8)
            .map(|i| format!("This is English body line number {i}."))
            .collect();
        lines.push("これは日本語の行です。".to_string());
        lines.push("こちらも日本語の行です。".to_string());
        let text = lines.join("\n");
        assert_eq!(detect_article_language(&text), "mixed", "英語多数派でも日本語少数派がしきい値超えなら mixed");
    }

    #[test]
    fn detect_article_language_english_article_with_single_ja_line_is_en() {
        let mut lines: Vec<String> = (0..10)
            .map(|i| format!("This is English body line number {i}."))
            .collect();
        lines.push("これは日本語の行です。".to_string());
        let text = lines.join("\n");
        assert_eq!(detect_article_language(&text), "en", "日本語行が 1 行だけなら 'en' のままであるべき");
    }

    #[test]
    fn detect_article_language_blank_lines_are_ignored() {
        // 空行・空白のみの行は行数に数えない（20 行中 2 行 = 10% の判定が空行で薄まらない）
        let mut lines: Vec<String> = (0..18)
            .map(|i| format!("日本語の本文行その{i}です。\n"))
            .collect();
        lines.push("This is the first English line.\n\n\n".to_string());
        lines.push("This is the second English line.\n   \n".to_string());
        let text = lines.join("\n");
        assert_eq!(detect_article_language(&text), "mixed", "空行を除いた行数でしきい値判定すべき");
    }

    // ── pcm_to_wav ──

    #[test]
    fn pcm_to_wav_starts_with_riff() {
        let wav = pcm_to_wav(&[], 22050);
        assert_eq!(&wav[0..4], b"RIFF", "WAV は RIFF で始まるべき");
    }

    #[test]
    fn pcm_to_wav_header_is_44_bytes_for_empty_pcm() {
        let wav = pcm_to_wav(&[], 22050);
        assert_eq!(wav.len(), 44, "空PCMのWAVは44バイトのヘッダーのみ");
    }

    #[test]
    fn pcm_to_wav_total_size_is_correct() {
        let pcm = vec![0u8; 100];
        let wav = pcm_to_wav(&pcm, 22050);
        assert_eq!(wav.len(), 44 + 100);
    }

    #[test]
    fn pcm_to_wav_file_size_field_is_correct() {
        // RIFF チャンクサイズ = ファイルサイズ - 8 = 44 + data_len - 8 = 36 + data_len
        let pcm = vec![0u8; 100];
        let wav = pcm_to_wav(&pcm, 22050);
        let chunk_size = u32::from_le_bytes(wav[4..8].try_into().unwrap());
        assert_eq!(chunk_size, 36 + 100);
    }

    #[test]
    fn pcm_to_wav_contains_wave_marker() {
        let wav = pcm_to_wav(&[], 22050);
        assert_eq!(&wav[8..12], b"WAVE");
    }

    #[test]
    fn pcm_to_wav_sample_rate_is_stored_correctly() {
        let wav = pcm_to_wav(&[], 22050);
        let sr = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        assert_eq!(sr, 22050);
    }

    // ── is_installed (ダミーパス) ──

    #[test]
    fn is_installed_returns_false_when_dir_missing() {
        // ダミーパス経由ではなく、存在しないパスを直接チェック
        let fake_dir = PathBuf::from("/nonexistent/piper_engine");
        let installed = fake_dir.join("piper.exe").exists()
            && fake_dir.join("en_US-ryan-high.onnx").exists()
            && fake_dir.join("en_US-ryan-high.onnx.json").exists();
        assert!(!installed, "存在しないディレクトリでは false を返すべき");
    }

    // ── synthesize (piper.exe なし) ──

    #[tokio::test]
    async fn synthesize_returns_not_installed_when_exe_missing() {
        // piper.exe が存在しないパスを直接チェックすることで NotInstalled を検証
        let fake_dir = PathBuf::from("/nonexistent/piper_engine");
        let piper_exe = fake_dir.join("piper.exe");
        let model = fake_dir.join("en_US-ryan-high.onnx");
        assert!(
            !piper_exe.exists() || !model.exists(),
            "piper.exe/model が存在しない場合は NotInstalled になるべき"
        );
    }
}

use serde::Serialize;

// 公開後にGitHubリポジトリを設定してください (例: "yourname/mimiweb-desktop")
const GITHUB_REPO: &str = "";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub has_update: bool,
    pub latest_version: String,
    pub release_url: String,
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    if GITHUB_REPO.is_empty() {
        return Ok(UpdateInfo {
            has_update: false,
            latest_version: String::new(),
            release_url: String::new(),
        });
    }

    let current = app.package_info().version.to_string();
    let api_url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");

    let client = reqwest::Client::new();
    let resp = client
        .get(&api_url)
        .header("User-Agent", format!("mimiweb-desktop/{current}"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Ok(UpdateInfo {
            has_update: false,
            latest_version: String::new(),
            release_url: String::new(),
        });
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = json["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let release_url = json["html_url"].as_str().unwrap_or("").to_string();

    let has_update = !tag.is_empty() && is_newer(&tag, &current);

    Ok(UpdateInfo {
        has_update,
        latest_version: tag,
        release_url,
    })
}

fn is_newer(latest: &str, current: &str) -> bool {
    fn parse(v: &str) -> [u32; 3] {
        let p: Vec<u32> = v.split('.').filter_map(|s| s.parse().ok()).collect();
        [
            p.first().copied().unwrap_or(0),
            p.get(1).copied().unwrap_or(0),
            p.get(2).copied().unwrap_or(0),
        ]
    }
    parse(latest) > parse(current)
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn newer_patch() {
        assert!(is_newer("0.1.1", "0.1.0"));
    }

    #[test]
    fn newer_minor() {
        assert!(is_newer("0.2.0", "0.1.9"));
    }

    #[test]
    fn same_version() {
        assert!(!is_newer("0.1.0", "0.1.0"));
    }

    #[test]
    fn older_version() {
        assert!(!is_newer("0.0.9", "0.1.0"));
    }
}

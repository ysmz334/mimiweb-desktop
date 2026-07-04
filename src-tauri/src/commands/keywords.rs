use serde::Serialize;
use tauri::State;

use crate::{repositories::keyword_repository::KeywordRepository, state::AppState};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeywordScore {
    pub word: String,
    pub score: f64,
}

#[tauri::command]
pub async fn get_article_keywords(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Vec<KeywordScore>, String> {
    let repo = KeywordRepository::new(state.db().clone());
    repo.get_scored_keywords(id, 60)
        .await
        .map(|pairs| {
            pairs
                .into_iter()
                .map(|(word, score)| KeywordScore { word, score })
                .collect()
        })
        .map_err(|e| e.to_string())
}

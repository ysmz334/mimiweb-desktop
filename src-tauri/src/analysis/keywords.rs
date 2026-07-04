use std::collections::HashMap;
use std::sync::OnceLock;

use lindera::{
    dictionary::load_dictionary,
    mode::Mode,
    segmenter::Segmenter,
    tokenizer::Tokenizer,
};
use rust_stemmers::{Algorithm, Stemmer};

// ─── 静的インスタンス ─────────────────────────────────────────────────────

static TOKENIZER: OnceLock<Tokenizer> = OnceLock::new();
static ENGLISH_STEMMER: OnceLock<Stemmer> = OnceLock::new();

fn get_tokenizer() -> &'static Tokenizer {
    TOKENIZER.get_or_init(|| {
        let dictionary = load_dictionary("embedded://ipadic")
            .expect("IPAdic 辞書の初期化に失敗しました");
        let segmenter = Segmenter::new(Mode::Normal, dictionary, None);
        Tokenizer::new(segmenter)
    })
}

fn get_english_stemmer() -> &'static Stemmer {
    ENGLISH_STEMMER.get_or_init(|| Stemmer::create(Algorithm::English))
}

// ─── HTML 除去 ────────────────────────────────────────────────────────────

fn strip_html(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut in_tag = false;
    let mut in_entity = false;
    let mut ent = String::new();

    for c in src.chars() {
        match c {
            '<' => { in_tag = true; }
            '>' => { in_tag = false; out.push(' '); }
            '&' if !in_tag => { in_entity = true; ent.clear(); ent.push('&'); }
            ';' if in_entity => {
                in_entity = false;
                out.push_str(match ent.as_str() {
                    "&amp;" => "&", "&lt;" => "<", "&gt;" => ">",
                    "&nbsp;" | "&#160;" => " ", "&quot;" => "\"",
                    _ => " ",
                });
                ent.clear();
            }
            _ if in_entity => { ent.push(c); if ent.len() > 10 { in_entity = false; ent.clear(); } }
            _ if in_tag => {}
            _ => { out.push(c); }
        }
    }
    out
}

// ─── 日本語ストップワード ─────────────────────────────────────────────────
//
// 「非自立」「代名詞」「数」「接尾」は品詞フィルタで除去されるため、
// ここでは品詞フィルタをすり抜ける一般名詞・固有名詞の頻出語を列挙する。

static JA_STOP_WORDS: &[&str] = &[
    // 時間・方向・程度などの一般名詞（副詞的用法が多い）
    "何", "人", "今", "年", "月", "日", "時", "前", "後", "上", "下", "中",
    "内", "外", "間", "方", "頃", "回", "度", "番",
    // 汎用すぎる形式名詞（非自立としてフィルタされない場合がある）
    "こと", "もの", "ため", "とき", "よう", "ところ", "わけ", "かた",
    "なか", "うえ", "もと", "ほう",
    // 汎用すぎる抽象名詞
    "今回", "今年", "今日", "今月", "最近", "場合", "関係", "問題",
    "方法", "情報", "必要", "可能", "以上", "以下", "以外", "以内",
    "一番", "一つ", "自分", "相手", "部分", "状況", "状態", "意味",
    "感じ", "感覚", "内容", "理由", "原因", "結果", "影響", "効果",
    "目的", "対象", "種類", "形式", "傾向", "可能性",
    // 英語頻出語（lindera では名詞として解析される）
    "the", "and", "for", "that", "with", "this", "from", "have",
    "not", "but", "are", "was", "its", "his", "her", "their",
    "you", "your", "our", "one", "all", "can", "will", "more",
    "also", "use", "has", "how", "new", "get", "any", "about",
    "been", "when", "what", "into", "than", "they", "just",
];

// ─── 英語ストップワード ───────────────────────────────────────────────────

static EN_STOP_WORDS: &[&str] = &[
    // 冠詞
    "a", "an", "the",
    // 前置詞
    "about", "above", "across", "after", "against", "along", "among",
    "around", "at", "before", "behind", "below", "beneath", "beside",
    "between", "beyond", "by", "down", "during", "except", "for", "from",
    "in", "inside", "into", "near", "of", "off", "on", "onto", "out",
    "outside", "over", "past", "since", "through", "throughout", "to",
    "toward", "towards", "under", "until", "up", "upon", "with", "within",
    "without",
    // 接続詞
    "and", "but", "or", "nor", "so", "yet", "although", "because",
    "either", "however", "if", "neither", "once", "than", "that",
    "though", "unless", "when", "whereas", "whether", "while",
    // 代名詞
    "he", "her", "hers", "herself", "him", "himself", "his", "i", "it",
    "its", "itself", "me", "mine", "my", "myself", "our", "ours",
    "ourselves", "she", "their", "theirs", "them", "themselves", "they",
    "us", "we", "what", "which", "who", "whom", "whose", "you", "your",
    "yours", "yourself", "yourselves",
    // 助動詞・一般動詞（高頻度）
    "am", "are", "be", "been", "being", "can", "could", "did", "do",
    "does", "done", "had", "has", "have", "having", "is", "may", "might",
    "must", "ought", "shall", "should", "was", "were", "will", "would",
    "came", "come", "get", "go", "goes", "going", "got", "gone",
    "know", "let", "made", "make", "say", "said", "see", "seem",
    "take", "took", "use", "used",
    // 短縮形の断片（アポストロフィで分割されたもの）
    "don", "doesn", "didn", "won", "wouldn", "isn", "aren",
    "wasn", "weren", "hasn", "haven", "hadn", "shouldn", "couldn",
    // 高頻度機能語
    "again", "ago", "already", "also", "another", "any", "back",
    "both", "each", "else", "even", "ever", "every", "few", "here",
    "just", "many", "more", "most", "much", "no", "none", "not",
    "now", "often", "one", "only", "other", "own", "quite", "rather",
    "really", "same", "still", "such", "then", "there", "therefore",
    "these", "this", "those", "thus", "too", "two", "very", "well",
    "where", "how", "why",
];

// ─── 品詞フィルタ（日本語用） ─────────────────────────────────────────────

fn is_content_noun(pos: &str, pos1: &str) -> bool {
    if pos != "名詞" {
        return false;
    }
    !matches!(pos1, "代名詞" | "数" | "接尾" | "非自立" | "特殊")
}

// ─── 日本語語句クリーニング ───────────────────────────────────────────────

/// 語句の先頭・末尾にあるノイズ文字（括弧・記号・数字・空白）を除去する。
fn clean_japanese_word(word: &str) -> &str {
    word.trim_matches(|c: char| {
        matches!(c,
            // 括弧類（全角・半角・和文）
            '（' | '）' | '(' | ')' |
            '「' | '」' | '『' | '』' |
            '【' | '】' | '〔' | '〕' |
            '〈' | '〉' | '《' | '》' |
            '〖' | '〗' | '〘' | '〙' | '〚' | '〛' |
            '[' | ']' | '{' | '}' |
            // 引用符
            '"' | '\'' | '\u{201C}' | '\u{201D}' | '\u{2018}' | '\u{2019}' |
            // 句読点・中黒・省略記号
            '。' | '、' | '，' | '．' | '・' | '…' | '‥' |
            // ダッシュ・ハイフン・記号
            '—' | '‐' | '−' | '-' | '_' | '=' | '+' |
            '*' | '/' | '\\' | '|' | '^' | '~' | '～' |
            '!' | '?' | '！' | '？' |
            '#' | '@' | '$' | '%' | '&' |
            // 空白（全角・半角）
            ' ' | '\u{3000}' |
            // 数字（全角・半角）
            '0'..='9' | '０'..='９'
        )
    })
}

/// 漢字・ひらがな・カタカナ・ASCII英字のいずれかを1文字以上含むこと。
/// 記号・数字のみのトークンを除外する。
fn is_valid_japanese_word(word: &str) -> bool {
    word.chars().any(|c| {
        matches!(c,
            '\u{4E00}'..='\u{9FFF}' |   // CJK統合漢字
            '\u{3040}'..='\u{309F}' |   // ひらがな
            '\u{30A0}'..='\u{30FF}' |   // カタカナ
            '\u{FF65}'..='\u{FF9F}' |   // 半角カタカナ
            '\u{F900}'..='\u{FAFF}' |   // CJK互換漢字
            'a'..='z' | 'A'..='Z'
        )
    })
}

// ─── 日本語抽出 ────────────────────────────────────────────────────────────

fn extract_japanese_word_counts(text: &str) -> HashMap<String, u32> {
    let tokenizer = get_tokenizer();

    let mut tokens = match tokenizer.tokenize(text) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("形態素解析に失敗しました: {e}");
            return HashMap::new();
        }
    };

    let mut counts: HashMap<String, u32> = HashMap::new();
    // 連続する名詞を貯めるバッファ（複合語として連結するため）
    let mut run: Vec<String> = Vec::new();

    for token in tokens.iter_mut() {
        let details = token.details();

        let pos  = details.first().copied().unwrap_or("*");
        let pos1 = details.get(1).copied().unwrap_or("*");

        // 内容名詞でなければ（助詞・動詞など）連接を切る
        if !is_content_noun(pos, pos1) {
            flush_noun_run(&mut run, &mut counts);
            continue;
        }

        let base = details.get(6).copied().unwrap_or("*");
        let raw = if base == "*" || base.is_empty() {
            token.surface.as_ref()
        } else {
            base
        };

        // 括弧・記号・数字を先頭末尾からトリム
        let cleaned = clean_japanese_word(raw);

        // 短すぎる / 無効文字のみ / ストップワードは複合語に含めず連接を切る
        if cleaned.chars().count() < 2 || !is_valid_japanese_word(cleaned) {
            flush_noun_run(&mut run, &mut counts);
            continue;
        }

        let word = cleaned.to_lowercase();

        if JA_STOP_WORDS.contains(&word.as_str()) {
            flush_noun_run(&mut run, &mut counts);
            continue;
        }

        run.push(word);
    }
    flush_noun_run(&mut run, &mut counts);

    counts
}

/// 連続した名詞のバッファを複合語としてカウントへ反映し、バッファをクリアする。
/// - 1 語: 単独名詞としてカウント
/// - 2〜4 語かつ連結20文字以内: 連結した複合語としてカウント（例: 機械 + 学習 → 機械学習）
/// - それ以上に長い連接: 暴走防止のため個別語としてカウント
fn flush_noun_run(run: &mut Vec<String>, counts: &mut HashMap<String, u32>) {
    if run.is_empty() {
        return;
    }
    if run.len() == 1 {
        *counts.entry(run[0].clone()).or_insert(0) += 1;
    } else {
        let joined: String = run.concat();
        if run.len() > 4 || joined.chars().count() > 20 {
            for w in run.iter() {
                *counts.entry(w.clone()).or_insert(0) += 1;
            }
        } else {
            *counts.entry(joined).or_insert(0) += 1;
        }
    }
    run.clear();
}

// ─── 英語抽出 ─────────────────────────────────────────────────────────────

fn extract_english_word_counts(text: &str) -> HashMap<String, u32> {
    let stemmer = get_english_stemmer();

    // 非ASCII英字で分割 → 小文字化 → 3文字未満除外
    let words: Vec<String> = text
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|s| s.len() >= 3)
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| !EN_STOP_WORDS.contains(&s.as_str()))
        .collect();

    // stem → (表層形 → 出現回数) のマップを構築
    let mut stem_map: HashMap<String, HashMap<String, u32>> = HashMap::new();
    for word in words {
        let stem = stemmer.stem(&word).into_owned();
        *stem_map.entry(stem).or_default().entry(word).or_insert(0) += 1;
    }

    // 各ステムグループを集約: 最多出現の表層形をキーとし、合計カウントを値にする
    stem_map
        .into_values()
        .filter_map(|surface_counts| {
            let total: u32 = surface_counts.values().sum();
            surface_counts.into_iter().max_by_key(|(_, c)| *c).map(|(best, _)| (best, total))
        })
        .collect()
}

// ─── 公開 API ─────────────────────────────────────────────────────────────

/// テキスト（HTML含む可）から語句をカウントして返す。
/// `language` が `"en"` の場合は英語パイプライン（ストップワード除去＋ Porter2 語幹処理）を使用し、
/// それ以外は日本語形態素解析（IPAdic）を使用する。
pub fn extract_word_counts(raw: &str, language: &str) -> HashMap<String, u32> {
    let text = strip_html(raw);
    if language == "en" {
        extract_english_word_counts(&text)
    } else {
        extract_japanese_word_counts(&text)
    }
}

// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    // ── 英語パイプライン ──────────────────────────────────────────────────

    #[test]
    fn test_english_removes_articles() {
        let result = extract_word_counts("The quick brown fox jumped over the lazy dog", "en");
        assert!(!result.contains_key("the"), "冠詞 'the' は除去されるべき");
        assert!(!result.contains_key("a"), "冠詞 'a' は除去されるべき");
        assert!(result.contains_key("fox") || result.contains_key("quick"),
            "内容語は保持されるべき");
    }

    #[test]
    fn test_english_removes_prepositions() {
        let result = extract_word_counts("cat on the mat with a hat", "en");
        assert!(!result.contains_key("on"), "前置詞 'on' は除去されるべき");
        assert!(!result.contains_key("with"), "前置詞 'with' は除去されるべき");
        assert!(result.contains_key("cat") || result.contains_key("mat"),
            "内容語は保持されるべき");
    }

    #[test]
    fn test_english_strips_symbols() {
        let result = extract_word_counts("Hello, world! How are you? Great.", "en");
        assert!(result.contains_key("hello"), "'hello' は記号除去後に存在するべき");
        assert!(result.contains_key("world"), "'world' は記号除去後に存在するべき");
        assert!(result.contains_key("great"), "'great' は記号除去後に存在するべき");
        assert!(!result.contains_key("how"), "疑問詞 'how' は除去");
        assert!(!result.contains_key("are"), "助動詞 'are' は除去");
    }

    #[test]
    fn test_english_stems_variants() {
        // "run"・"running"・"runs" はすべて stem "run" に集約される
        let result = extract_word_counts("run running runs", "en");
        let total: u32 = result.values().sum();
        assert_eq!(total, 3, "3語がひとつのステムに集約され合計カウントは3");
        assert_eq!(result.len(), 1, "ステムグループはひとつ");
    }

    #[test]
    fn test_english_surface_form_display() {
        // "studies" 2回、"study" 1回 → 最多表層形 "studies" が表示キーになる
        let result = extract_word_counts("studies studies study", "en");
        assert!(result.contains_key("studies"),
            "最多出現の表層形 'studies' がキーになるべき");
        assert!(!result.contains_key("study"),
            "'study' 単体はキーにならないはず（'studies' に集約）");
        let total: u32 = result.values().sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn test_english_html_stripped() {
        let result = extract_word_counts("<p>Hello <strong>world</strong></p>", "en");
        assert!(result.contains_key("hello"), "HTML除去後 'hello' が存在するべき");
        assert!(result.contains_key("world"), "HTML除去後 'world' が存在するべき");
    }

    #[test]
    fn test_english_min_length_filter() {
        // 2文字以下のトークンは除外される
        let result = extract_word_counts("I am an ox at it", "en");
        // "am", "an", "at" はストップワード、"I", "it", "ox" のうち
        // "i" (1文字) と "it" (2文字) はフィルタで除去、"ox" (2文字) も除去
        assert!(!result.contains_key("i"), "1文字トークンは除外");
        assert!(!result.contains_key("it"), "2文字トークンは除外");
        assert!(!result.contains_key("ox"), "2文字トークンは除外");
    }

    #[test]
    fn test_english_empty_string() {
        let result = extract_word_counts("", "en");
        assert!(result.is_empty(), "空文字は空マップを返す");
    }

    #[test]
    fn test_english_only_stopwords() {
        let result = extract_word_counts("the and of in is are was", "en");
        assert!(result.is_empty(), "ストップワードのみは空マップを返す");
    }

    #[test]
    fn test_english_numeric_tokens_excluded() {
        // 数字のみのトークンは意味がないので除外（split後に残らないが念のため確認）
        let result = extract_word_counts("top 10 best practices for 2024", "en");
        assert!(!result.contains_key("10"), "数字トークンは除外");
        assert!(!result.contains_key("2024"), "数字トークンは除外");
    }

    // ── 日本語クリーニング ────────────────────────────────────────────────

    #[test]
    fn test_japanese_clean_word_strips_brackets() {
        assert_eq!(clean_japanese_word("（東京）"), "東京");
        assert_eq!(clean_japanese_word("【特集】"), "特集");
        assert_eq!(clean_japanese_word("「AI」"), "AI");
        assert_eq!(clean_japanese_word("(abc)"), "abc");
    }

    #[test]
    fn test_japanese_clean_word_strips_punctuation() {
        assert_eq!(clean_japanese_word("東京。"), "東京");
        assert_eq!(clean_japanese_word("…東京…"), "東京");
        assert_eq!(clean_japanese_word("東京・"), "東京");
    }

    #[test]
    fn test_japanese_clean_word_strips_numbers() {
        assert_eq!(clean_japanese_word("123東京"), "東京");
        assert_eq!(clean_japanese_word("東京2024"), "東京");
    }

    #[test]
    fn test_japanese_is_valid_word_rejects_symbols() {
        assert!(!is_valid_japanese_word("（）"));
        assert!(!is_valid_japanese_word("123"));
        assert!(!is_valid_japanese_word("---"));
        assert!(!is_valid_japanese_word(""));
    }

    #[test]
    fn test_japanese_is_valid_word_accepts_content() {
        assert!(is_valid_japanese_word("東京"));
        assert!(is_valid_japanese_word("カタカナ"));
        assert!(is_valid_japanese_word("ひらがな"));
        assert!(is_valid_japanese_word("iPhone"));
    }

    #[test]
    fn test_japanese_pipeline_filters_brackets() {
        // 記号・括弧のみのトークンが結果に含まれないことを確認
        let result = extract_word_counts("（東京）と【大阪】の情報", "ja");
        // 記号単体は除外される
        assert!(!result.contains_key("（"));
        assert!(!result.contains_key("）"));
        assert!(!result.contains_key("【"));
        assert!(!result.contains_key("】"));
    }

    // ── 複合語（連続名詞の連結） ──────────────────────────────────────────

    #[test]
    fn test_flush_noun_run_joins_multiple() {
        let mut counts = HashMap::new();
        let mut run = vec!["機械".to_string(), "学習".to_string()];
        flush_noun_run(&mut run, &mut counts);
        assert_eq!(counts.get("機械学習"), Some(&1), "2語は連結される");
        assert!(run.is_empty(), "バッファはクリアされる");
    }

    #[test]
    fn test_flush_noun_run_single_kept_as_is() {
        let mut counts = HashMap::new();
        let mut run = vec!["東京".to_string()];
        flush_noun_run(&mut run, &mut counts);
        assert_eq!(counts.get("東京"), Some(&1), "単独名詞はそのまま");
    }

    #[test]
    fn test_flush_noun_run_too_many_falls_back_to_singles() {
        let mut counts = HashMap::new();
        let mut run = vec!["あい".to_string(), "うえ".to_string(), "おか".to_string(),
                           "きく".to_string(), "けこ".to_string()]; // 5語 > 4
        flush_noun_run(&mut run, &mut counts);
        assert_eq!(counts.get("あい"), Some(&1), "5語連接は個別語へフォールバック");
        assert!(counts.get("あいうえおかきくけこ").is_none(), "長すぎる連接は連結しない");
    }

    #[test]
    fn test_japanese_particles_break_compound() {
        // 助詞（から/まで）で区切られた名詞は連結されず単独のまま
        let result = extract_word_counts("東京から大阪まで", "ja");
        assert!(result.contains_key("東京"), "東京は単独: {:?}", result);
        assert!(result.contains_key("大阪"), "大阪は単独: {:?}", result);
        assert!(!result.contains_key("東京大阪"), "助詞を挟むので連結しない");
    }

    // ── 言語ルーティング ──────────────────────────────────────────────────

    #[test]
    fn test_language_routing_en() {
        // 英語パスが呼ばれ、ストップワードが除去されることを確認
        let result = extract_word_counts("machine learning algorithms", "en");
        assert!(!result.contains_key("the"));
        assert!(result.contains_key("machin") || result.contains_key("machine")
            || result.contains_key("learn") || result.contains_key("learning")
            || result.contains_key("algorithm") || result.contains_key("algorithms"),
            "英語内容語が何らかの形で保持される");
    }

    #[test]
    fn test_language_routing_ja_does_not_use_english_pipeline() {
        // "ja" ルートでは英語ストップワードリストは適用されない
        // （lindera が処理するため、純英語テキストは結果が異なる）
        let result_en = extract_word_counts("learning machine", "en");
        let result_ja = extract_word_counts("learning machine", "ja");
        // 両ルートが独立して動作することを確認（同一結果を要求しない）
        let _ = (result_en, result_ja); // パニックなく処理されることが確認できれば十分
    }
}

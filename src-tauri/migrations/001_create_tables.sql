PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS articles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL UNIQUE,
  title           TEXT,
  content         TEXT,
  content_html    TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','extracting','ready','error','queued','played')),
  error_message   TEXT,
  registered_at   TEXT    NOT NULL,
  extracted_at    TEXT,
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  language        TEXT    NOT NULL DEFAULT 'ja'
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_registered_at ON articles(registered_at DESC);

CREATE TABLE IF NOT EXISTS queue_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  added_at    TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_position ON queue_items(position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_article_id ON queue_items(article_id);

CREATE TABLE IF NOT EXISTS playback_history (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id           INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  started_at           TEXT,
  completed_at         TEXT    NOT NULL,
  duration_seconds     INTEGER NOT NULL,
  last_sentence_index  INTEGER,
  sentence_count       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_history_completed_at ON playback_history(completed_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('voicevox_speaker_id', '3'),
  ('voicevox_port', '50021'),
  ('playback_speed', '1.0');

CREATE TABLE IF NOT EXISTS article_keywords (
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  word        TEXT    NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (article_id, word)
);
CREATE INDEX IF NOT EXISTS idx_article_keywords_word ON article_keywords(word);

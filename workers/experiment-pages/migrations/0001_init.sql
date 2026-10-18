-- 実験ランディングページ（構造化された文面のみ。生の HTML は保存しない）
CREATE TABLE pages (
  slug TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

-- 日次の集計（個人を特定しない数だけ。保持期間なし）
CREATE TABLE daily_stats (
  slug TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  cta_clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);

-- 日次の重複除外用ハッシュ（HMAC(ip+ua+日付)。2日を過ぎたら削除）
CREATE TABLE seen_hashes (
  slug TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('view', 'cta')),
  hash TEXT NOT NULL,
  PRIMARY KEY (slug, day, kind, hash)
);
CREATE INDEX seen_hashes_day ON seen_hashes (day);

-- 関心表明（個人情報を含む。180日を過ぎたら削除）
CREATE TABLE interests (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX interests_slug_created ON interests (slug, created_at);
CREATE INDEX interests_created ON interests (created_at);

-- 送信回数の制限（固定窓のカウンタ。期限を過ぎたら削除）
CREATE TABLE rate_counters (
  key TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (key, bucket)
);
CREATE INDEX rate_counters_expires ON rate_counters (expires_at);

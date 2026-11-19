-- ユーザー・ログイン・指摘・チームの表（D1）。時刻はすべてミリ秒の整数。トークンとコードはハッシュだけを置く

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- メールで送った6桁のコード（HMAC だけ）。1つのアドレスに1つ。新しく送ると置き換わる
CREATE TABLE login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ログインのセッション（トークンの SHA-256 だけ）。app は Bearer、web は cookie
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('app', 'web')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- 指摘を送ってくる PC（1人に devicesPerUser まで）
CREATE TABLE devices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- 指摘。PC ごとに置き換えで送られる。at は ISO 8601（無ければ NULL）
CREATE TABLE entries (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key TEXT NOT NULL,
  project TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT,
  at TEXT,
  text TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, key),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id) ON DELETE CASCADE
);
CREATE INDEX entries_user_at ON entries(user_id, at);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);

-- まだ受けていない招待（トークンの SHA-256 だけ）。1チームの1アドレスに1つ
CREATE TABLE team_invites (
  token_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, email)
);

-- 指摘の画像。中身は R2（MEDIA）の img/<hash>。D1 には誰が上げたか（持ち主）と、どの指摘が指しているかだけを置く

-- 画像の持ち主。中身を上げた人だけがなる（hash を知っているだけでは読めない）。type は中身を確かめた形式
CREATE TABLE image_owners (
  hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('png', 'jpeg', 'webp', 'svg')),
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hash, user_id)
);
CREATE INDEX image_owners_user ON image_owners(user_id);
CREATE INDEX image_owners_created ON image_owners(created_at);

-- 指摘に付いた画像（CloudImage[] の JSON。無ければ NULL）。読むときはこれをそのまま返す
ALTER TABLE entries ADD COLUMN images TEXT;

-- どの指摘がどの画像を指しているか（掃除で「誰からも指されていない」を索引で引くため）。指摘と一緒に置き換える
CREATE TABLE entry_images (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, key, hash)
);
CREATE INDEX entry_images_user_hash ON entry_images(user_id, hash);

-- 001_initial.sql — Oculus v1 schema

-- One row per stored media file. Deduped globally by content hash.
CREATE TABLE photos (
  id                INTEGER PRIMARY KEY,
  hash              TEXT    NOT NULL UNIQUE,          -- content hash; basis for dedup + on-disk filename
  rel_path          TEXT,                             -- e.g. 2026/06/<hash>.jpg on the Maingear; NULL until stored
  original_filename TEXT,                             -- preserved as metadata only
  kind              TEXT    NOT NULL DEFAULT 'image', -- 'image' | 'video'
  format            TEXT,                             -- jpeg, png, heic, mp4, ...
  width             INTEGER,
  height            INTEGER,
  file_size         INTEGER,
  duration          REAL,                             -- seconds; videos only
  taken_at          TEXT,                             -- EXIF capture time (ISO 8601); app falls back to file time
  imported_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  camera_make       TEXT,
  camera_model      TEXT,
  gps_lat           REAL,
  gps_lon           REAL,
  sync_status       TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'synced'
  staged            INTEGER NOT NULL DEFAULT 0          -- 1 if the original is currently on VPS staging
);

CREATE INDEX idx_photos_taken_at    ON photos (taken_at);
CREATE INDEX idx_photos_imported_at ON photos (imported_at);
CREATE INDEX idx_photos_sync_status ON photos (sync_status);

-- Tags are the sole organizing primitive (a tag is also an "album").
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

-- Many-to-many photo <-> tag. "Untagged" = a photo with no rows here.
CREATE TABLE photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);

-- tag_id lookups; the (photo_id, tag_id) PK already covers photo_id-leading queries.
CREATE INDEX idx_photo_tags_tag ON photo_tags (tag_id);

-- Work queue for the VPS<->Maingear sync layer.
CREATE TABLE sync_queue (
  id         INTEGER PRIMARY KEY,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  op         TEXT    NOT NULL,                       -- 'upload' | 'delete'
  status     TEXT    NOT NULL DEFAULT 'pending',     -- 'pending' | 'done' | 'failed'
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sync_queue_status ON sync_queue (status);

-- Single-row settings singleton (consistent with the other apps).
CREATE TABLE settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL DEFAULT '{}',             -- JSON blob
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO settings (id) VALUES (1);

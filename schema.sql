-- D1 schema for cf_ai_vndb-agent
-- Subset of VNDB: top ~10k VNs by vote count plus their tags, producers, releases.

DROP TABLE IF EXISTS vn;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS tags_vn;
DROP TABLE IF EXISTS producers;
DROP TABLE IF EXISTS vn_producers;
DROP TABLE IF EXISTS vn_relations;

CREATE TABLE vn (
  id           INTEGER PRIMARY KEY,         -- numeric VN id (the digits of v123)
  title        TEXT NOT NULL,               -- preferred display title
  latin        TEXT,                        -- romanised title if available
  olang        TEXT,                        -- original language
  released     TEXT,                        -- earliest release date YYYY-MM-DD or partial
  length       INTEGER,                     -- 1=very short .. 5=very long, NULL unknown
  rating       REAL,                        -- c_rating (bayesian, 0-100)
  votecount    INTEGER,                     -- c_votecount
  average      REAL,                        -- c_average
  languages    TEXT,                        -- JSON array of release languages
  platforms    TEXT,                        -- JSON array of release platforms
  description  TEXT
);

CREATE INDEX idx_vn_title    ON vn(title);
CREATE INDEX idx_vn_latin    ON vn(latin);
CREATE INDEX idx_vn_rating   ON vn(rating DESC);
CREATE INDEX idx_vn_released ON vn(released);

CREATE TABLE tags (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  cat         TEXT,        -- 'cont' | 'ero' | 'tech'
  description TEXT
);
CREATE INDEX idx_tags_name ON tags(name);

CREATE TABLE tags_vn (
  vid    INTEGER NOT NULL,
  tag    INTEGER NOT NULL,
  rating REAL,             -- aggregated tag strength (-3 .. 3)
  PRIMARY KEY (vid, tag)
);
CREATE INDEX idx_tags_vn_tag ON tags_vn(tag);

CREATE TABLE producers (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  lang TEXT
);

CREATE TABLE vn_producers (
  vid INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  developer INTEGER NOT NULL DEFAULT 0,
  publisher INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vid, pid)
);
CREATE INDEX idx_vn_producers_pid ON vn_producers(pid);

CREATE TABLE vn_relations (
  vid1 INTEGER NOT NULL,
  vid2 INTEGER NOT NULL,
  relation TEXT,
  official INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (vid1, vid2, relation)
);

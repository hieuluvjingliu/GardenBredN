PRAGMA foreign_keys = ON;

/* ========== Core ========== */
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT UNIQUE NOT NULL,
  coins              INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,

  -- Gacha state
  gacha_total_pulls  INTEGER NOT NULL DEFAULT 0,
  pity10_after       INTEGER NOT NULL DEFAULT 0,
  pity90_after       INTEGER NOT NULL DEFAULT 0,
  gacha_step         INTEGER NOT NULL DEFAULT 0,

  -- Compat với code đang dùng tên gacha_pity10/gacha_pity90
  gacha_pity10       INTEGER NOT NULL DEFAULT 0,
  gacha_pity90       INTEGER NOT NULL DEFAULT 0
);


CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS floors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  idx        INTEGER NOT NULL DEFAULT 1,
  unlocked   INTEGER NOT NULL DEFAULT 1,
  trap_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* ========== Gacha logs ========== */
CREATE TABLE IF NOT EXISTS gacha_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  consumed_cls  TEXT    NOT NULL,   -- class tiêu hao (current.class)
  consumed_cnt  INTEGER NOT NULL,   -- cost lẻ: 1,3,5,7,...
  out_class     TEXT    NOT NULL,   -- class trúng
  out_mutation  TEXT,               -- NULL | green/blue/.../rainbow
  out_base      INTEGER NOT NULL,   -- (pull_index * 100000)
  pull_index    INTEGER NOT NULL,
  pity10_after  INTEGER NOT NULL,
  pity90_after  INTEGER NOT NULL,
  step_after    INTEGER NOT NULL,   -- step sau khi roll (0 nếu ra rainbow)
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* ========== Plots / Inventory ========== */
CREATE TABLE IF NOT EXISTS plots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_id    INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  pot_id      INTEGER,
  pot_type    TEXT,
  seed_id     INTEGER,
  class       TEXT,
  stage       TEXT NOT NULL DEFAULT 'empty',
  planted_at  INTEGER,
  mature_at   INTEGER,
  mutation    TEXT DEFAULT NULL,    -- mutation tier cho seed đang trồng
  FOREIGN KEY(floor_id) REFERENCES floors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory_pots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  type        TEXT NOT NULL,
  speed_mult  REAL NOT NULL,
  yield_mult  REAL NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory_seeds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  class       TEXT NOT NULL,
  base_price  INTEGER NOT NULL,
  is_mature   INTEGER NOT NULL DEFAULT 0,
  mutation    TEXT DEFAULT NULL,    -- mutation tier cho seed trong kho
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS seed_catalog (
  class       TEXT PRIMARY KEY,
  base_price  INTEGER NOT NULL
);

/* ========== Market ========== */
CREATE TABLE IF NOT EXISTS market_listings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id   INTEGER NOT NULL,
  item_type   TEXT NOT NULL,   -- 'seed'
  item_id     INTEGER NOT NULL, -- escrow id in inventory (deleted from inv until sold)
  class       TEXT NOT NULL,
  base_price  INTEGER NOT NULL,
  ask_price   INTEGER NOT NULL,
  status      TEXT NOT NULL,   -- 'open' | 'sold'
  created_at  INTEGER NOT NULL,
  mutation    TEXT DEFAULT NULL, -- mutation tier giữ màu/multiplier khi rao bán
  FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE CASCADE
);

/* ========== Logs ========== */
CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER,
  action   TEXT NOT NULL,
  payload  TEXT,
  at       INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* ========== Indexes ========== */
CREATE UNIQUE INDEX IF NOT EXISTS floors_user_idx_unique ON floors(user_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS plots_floor_slot_unique ON plots(floor_id, slot);

CREATE INDEX IF NOT EXISTS gacha_logs_user_created_idx ON gacha_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS plots_floor_stage_idx ON plots(floor_id, stage);
CREATE INDEX IF NOT EXISTS inv_seeds_user_idx ON inventory_seeds(user_id);
CREATE INDEX IF NOT EXISTS inv_pots_user_idx  ON inventory_pots(user_id);
CREATE INDEX IF NOT EXISTS market_status_created_idx ON market_listings(status, created_at);

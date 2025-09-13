/**
 * server.js (ESM) — GardenBred: Express + WS + SQLite + safe backup/restore + Gacha
 */
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

// ==== MUTATION TIERS ====
const MUTATION_TIERS = [
  { key: 'green',   mult: 1.20, p: 0.10 },
  { key: 'blue',    mult: 1.50, p: 0.05 },
  { key: 'yellow',  mult: 2.00, p: 0.025 },
  { key: 'pink',    mult: 3.00, p: 0.0125 },
  { key: 'red',     mult: 4.00, p: 0.01 },
  { key: 'gold',    mult: 6.00, p: 0.0075 },
  { key: 'rainbow', mult: 11.0, p: 0.005 }
];
function rollMutationTier() {
  const r = Math.random();
  let acc = 0;
  for (const t of MUTATION_TIERS) {
    acc += t.p;
    if (r < acc) return t;
  }
  return { key: null, mult: 1.0, p: 1 - acc };
}
function mutationMultiplier(key) {
  return (MUTATION_TIERS.find(t => t.key === key)?.mult) ?? 1.0;
}

/* ====== GACHA FIXED RATES (NEW) ====== */
const GACHA_RATES = Object.freeze({
  coins: 0.30,
  seed_planted: 0.30,
  seed_mature: 0.30,
  redgold: 0.09,
  rainbow: 0.01
});
function pickGachaOutcome() {
  const order = [
    ['coins',        GACHA_RATES.coins],
    ['seed_planted', GACHA_RATES.seed_planted],
    ['seed_mature',  GACHA_RATES.seed_mature],
    ['redgold',      GACHA_RATES.redgold],
    ['rainbow',      GACHA_RATES.rainbow],
  ];
  let r = Math.random();
  for (const [k, p] of order) {
    if ((r -= p) <= 0) return k;
  }
  return 'seed_planted';
}
function randIntInclusive(min, max){
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ==== Paths / constants ====
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const TOOLS_DIR  = path.join(ROOT_DIR, 'tools');

// DB file ở root (có thể override qua ENV)
const DB_PATH = process.env.DB_PATH || path.join(ROOT_DIR, 'game.db');



// ==== Auto-migration helpers (idempotent) ====
let db; // (đặt sớm để helpers dùng được)

function hasColumn(table, name) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(c => c.name === name);
  } catch {
    return false;
  }
}
function ensureColumn(table, name, defSql) {
  if (!hasColumn(table, name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${defSql}`);
    console.log(`[MIGRATE] Added column ${table}.${name}`);
  }
}
function ensureGachaColumns() {
  // các cột đã dùng trong code + biến thể "_after" để tương thích
  ensureColumn('users', 'gacha_total_pulls', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'gacha_step',        'INTEGER NOT NULL DEFAULT 0');

  // Tên ngắn đang được code tham chiếu
  ensureColumn('users', 'gacha_pity10',      'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'gacha_pity90',      'INTEGER NOT NULL DEFAULT 0');

  // Queue JSON cho preview/step (bổ sung để SELECT/UPDATE không lỗi)
  ensureColumn('users', 'gacha_queue_json',  'TEXT NOT NULL DEFAULT "[]"');

  // Nếu bạn vẫn giữ schema.sql cũ có *_after*, vẫn thêm cho đủ để không lỗi nơi khác
  ensureColumn('users', 'pity10_after',      'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'pity90_after',      'INTEGER NOT NULL DEFAULT 0');
}
// NEW: đảm bảo cột lock cho plots
function ensurePlotColumns() {
  ensureColumn('plots', 'locked', 'INTEGER NOT NULL DEFAULT 0');
}


// SCHEMA & CLASS_WEIGHTS trong tools/
const SCHEMA_PATH = process.env.SCHEMA_PATH || path.join(TOOLS_DIR, 'schema.sql');
const CLASS_WEIGHTS_PATH = process.env.CLASS_WEIGHTS_PATH || path.join(TOOLS_DIR, 'class_weights.json');

function loadClassWeights() {
  try {
    const raw = fs.readFileSync(CLASS_WEIGHTS_PATH, 'utf8');
    const obj = JSON.parse(raw);          // { className: weightNumber }
    const entries = Object.entries(obj)
      .map(([k, v]) => [String(k).toLowerCase(), Number(v)])
      .filter(([, w]) => Number.isFinite(w) && w > 0);

    if (!entries.length) throw new Error('no positive weights');
    return Object.fromEntries(entries);
  } catch (e) {
    console.error('[CLASS_WEIGHTS] load failed:', e.message || e);
    return { fire: 1, water: 1, wind: 1, earth: 1 };
  }
}
let CLASS_WEIGHTS = loadClassWeights();

try {
  fs.watchFile(CLASS_WEIGHTS_PATH, { interval: 1000 }, () => {
    try {
      CLASS_WEIGHTS = loadClassWeights();
      console.log('[CLASS_WEIGHTS] reloaded');
    } catch (e) {
      console.error('[CLASS_WEIGHTS] reload failed:', e.message || e);
    }
  });
} catch { /* optional */ }

function pickWeightedClass(weightsObj) {
  const items = Object.entries(weightsObj);
  const total = items.reduce((s, [, w]) => s + w, 0);
  if (!(total > 0)) return 'fire';
  let r = Math.random() * total;
  for (const [k, w] of items) {
    if ((r -= w) <= 0) return k;
  }
  return items[items.length - 1][0];
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(cookieParser());

// ===== Static (serve từ public/, không lộ game.db) =====
function sendPublic(res, relPath) {
  res.sendFile(path.join(PUBLIC_DIR, relPath), { headers: { 'Cache-Control': 'no-store' } });
}
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, {
    fallthrough: true,
    index: false,
    dotfiles: 'ignore',
    maxAge: 0,
  }));
}
app.get('/', (_req, res) => sendPublic(res, 'index.html'));
app.get('/index.html', (_req, res) => sendPublic(res, 'index.html'));
app.get('/client.js', (_req, res) => sendPublic(res, 'client.js'));
app.get('/style.css', (_req, res) => sendPublic(res, 'style.css'));

// Nếu có public/assets thì expose
const PUBLIC_ASSETS = path.join(PUBLIC_DIR, 'assets');
if (fs.existsSync(PUBLIC_ASSETS)) {
  app.use('/assets', express.static(PUBLIC_ASSETS, {
    fallthrough: true,
    index: false,
    dotfiles: 'ignore',
    maxAge: 0,
  }));
}

// ==== BACKUP (download) ====
app.get('/admin/download-db', (req, res) => {
  if ((req.query.token || '') !== (process.env.ADMIN_TOKEN || '')) {
    return res.sendStatus(403);
  }
  res.download(DB_PATH, 'game.db');
});

// ==== DB open + migrations (safe) ====
let restoring = false;
function safeDbReady() { return db && db.open === true && !restoring; }

function openDb() { db = new Database(DB_PATH); }
function runMigrations() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql); // tạo bảng nếu chưa có (gacha_logs, v.v.)

  // Đảm bảo các cột Gacha trên bảng users (idempotent, không crash nếu đã tồn tại)
  ensureColumn('users', 'gacha_total_pulls', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'pity10_after',      'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'pity90_after',      'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'gacha_step',        'INTEGER NOT NULL DEFAULT 0');

  // NEW: đảm bảo cột lock cho plots
  ensurePlotColumns();
}

function integrityOk(dbFilePath) {
  const t = new Database(dbFilePath);
  try {
    const r = t.prepare('PRAGMA integrity_check').get();
    return r?.integrity_check === 'ok';
  } finally { t.close(); }
}

// ==== Prepared statements ====
let upsertUserStmt, getUserStmt, getUserByIdStmt, insertSessionStmt, getSessionStmt;
let getStateStmt, getFloorsStmt, getFloorsCountStmt, ensureFloorStmt;
let getPlotsByFloorStmt, ensurePlotStmt, getPlotByIdStmt, setPlotLockStmt;
let seedBasePriceStmt, upsertSeedCatalogStmt;
let addCoinsStmt, subCoinsStmt;
let invAddSeedStmt, invListSeedsStmt, invGetSeedStmt, invDelSeedStmt;
let invAddPotStmt, invListPotsStmt, invGetPotStmt, invDelPotStmt;
let setPlotPotStmt, setPlotAfterPlantStmt, setPlotStageStmt, clearPlotSeedOnlyStmt, clearPlotAllStmt;
let listUsersOnlineStmt, addTrapToFloorStmt, useTrapOnFloorStmt, listFloorsByUserStmt, getFloorByIdStmt;
let marketCreateStmt, marketOpenStmt, marketGetStmt, marketCloseStmt;
let logStmt;

// ==== Gacha statements ====
let getGachaUserStmt, updateGachaStmt, updateGachaQueueStmt;
let invCountMatureByClassStmt, invPickMatureByClassStmt;
let gachaLogStmt;

function prepareAll() {
  // users/sessions
  upsertUserStmt = db.prepare(
    `INSERT INTO users (username, coins, created_at) VALUES (?, 10000, ?)
     ON CONFLICT(username) DO NOTHING`
  );
  getUserStmt = db.prepare(`SELECT * FROM users WHERE username = ?`);
  getUserByIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
  insertSessionStmt = db.prepare(`INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)`); 
  getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

  // state/floors/plots
  getStateStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
  getFloorsStmt = db.prepare(`SELECT * FROM floors WHERE user_id = ? ORDER BY idx ASC`);
  getFloorsCountStmt = db.prepare(`SELECT COUNT(*) as cnt FROM floors WHERE user_id = ? AND unlocked = 1`);
  ensureFloorStmt = db.prepare(`INSERT OR IGNORE INTO floors (user_id, idx, unlocked, trap_count) VALUES (?, ?, 1, 0)`);
  getPlotsByFloorStmt = db.prepare(`SELECT * FROM plots WHERE floor_id = ? ORDER BY slot ASC`);
  ensurePlotStmt = db.prepare(`INSERT OR IGNORE INTO plots (floor_id, slot, stage) VALUES (?, ?, 'empty')`);
  getPlotByIdStmt = db.prepare(`SELECT * FROM plots WHERE id = ?`);
  setPlotLockStmt = db.prepare(`UPDATE plots SET locked = ? WHERE id = ?`);

  // seed catalog
  seedBasePriceStmt = db.prepare(`SELECT class as class_name, base_price FROM seed_catalog WHERE class = ?`);
  upsertSeedCatalogStmt = db.prepare(
    `INSERT INTO seed_catalog(class, base_price) VALUES (?, ?)
     ON CONFLICT(class) DO UPDATE SET base_price = excluded.base_price`
  );

  // coins
  addCoinsStmt = db.prepare(`UPDATE users SET coins = coins + ? WHERE id = ?`);
  subCoinsStmt = db.prepare(`UPDATE users SET coins = MAX(0, coins - ?) WHERE id = ?`);

  // inventory seeds  (PATCH: thêm mutation)
  invAddSeedStmt  = db.prepare(`INSERT INTO inventory_seeds (user_id, class, base_price, is_mature, mutation) VALUES (?, ?, ?, ?, ?)`); 
  invListSeedsStmt = db.prepare(`SELECT * FROM inventory_seeds WHERE user_id = ?`);
  invGetSeedStmt   = db.prepare(`SELECT * FROM inventory_seeds WHERE id = ? AND user_id = ?`);
  invDelSeedStmt   = db.prepare(`DELETE FROM inventory_seeds WHERE id = ? AND user_id = ?`);

  // inventory pots
  invAddPotStmt  = db.prepare(`INSERT INTO inventory_pots (user_id, type, speed_mult, yield_mult) VALUES (?, ?, ?, ?)`);
  invListPotsStmt = db.prepare(`SELECT * FROM inventory_pots WHERE user_id = ?`);
  invGetPotStmt   = db.prepare(`SELECT * FROM inventory_pots WHERE id = ? AND user_id = ?`);
  invDelPotStmt   = db.prepare(`DELETE FROM inventory_pots WHERE id = ? AND user_id = ?`);

  // plots update (PATCH: thêm mutation)
  setPlotPotStmt = db.prepare(`UPDATE plots SET pot_id=?, pot_type=? WHERE id=?`);
  setPlotAfterPlantStmt = db.prepare(
    `UPDATE plots
     SET seed_id=?, class=?, mutation=?, stage='planted', planted_at=?, mature_at=?
     WHERE id=?`
  );
  setPlotStageStmt = db.prepare(`UPDATE plots SET stage=? WHERE id=?`);
  clearPlotSeedOnlyStmt = db.prepare(
    `UPDATE plots SET seed_id=NULL, class=NULL, mutation=NULL, stage='empty', planted_at=NULL, mature_at=NULL WHERE id=?`
  );
  clearPlotAllStmt = db.prepare(
    `UPDATE plots SET pot_id=NULL, pot_type=NULL, seed_id=NULL, class=NULL, mutation=NULL, stage='empty', planted_at=NULL, mature_at=NULL WHERE id=?`
  );

  // online / floors helpers
  listUsersOnlineStmt = db.prepare(`SELECT id, username FROM users ORDER BY id DESC LIMIT 50`);
  addTrapToFloorStmt  = db.prepare(`UPDATE floors SET trap_count = trap_count + 1 WHERE id = ?`);
  useTrapOnFloorStmt  = db.prepare(`UPDATE floors SET trap_count = trap_count - 1 WHERE id = ? AND trap_count > 0`);
  listFloorsByUserStmt = db.prepare(`SELECT * FROM floors WHERE user_id = ? ORDER BY idx ASC`);
  getFloorByIdStmt     = db.prepare(`SELECT * FROM floors WHERE id = ?`);

  // market (PATCH: thêm mutation)
  marketCreateStmt = db.prepare(
    `INSERT INTO market_listings (seller_id, item_type, item_id, class, base_price, mutation, ask_price, status, created_at)
     VALUES (?, 'seed', ?, ?, ?, ?, ?, 'open', ?)`
  );
  marketOpenStmt = db.prepare(`SELECT * FROM market_listings WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`);
  marketGetStmt  = db.prepare(`SELECT * FROM market_listings WHERE id = ?`);
  marketCloseStmt = db.prepare(`UPDATE market_listings SET status='sold' WHERE id = ?`);

  // logs
  logStmt = db.prepare(`INSERT INTO logs (user_id, action, payload, at) VALUES (?, ?, ?, ?)`);

  // ===== GACHA =====
  getGachaUserStmt = db.prepare(`
    SELECT id, username,
           COALESCE(gacha_total_pulls,0) AS total_pulls,
           COALESCE(gacha_pity10,0)      AS pity10,
           COALESCE(gacha_pity90,0)      AS pity90,
           COALESCE(gacha_step,0)        AS step,
           COALESCE(gacha_queue_json,'[]') AS queue_json
    FROM users WHERE id = ?
  `);
  updateGachaStmt = db.prepare(`
    UPDATE users
    SET gacha_total_pulls = ?,
        gacha_pity10      = ?,
        gacha_pity90      = ?,
        gacha_step        = ?,
        gacha_queue_json  = ?
    WHERE id = ?
  `);
  updateGachaQueueStmt = db.prepare(`UPDATE users SET gacha_queue_json = ? WHERE id = ?`);
  invCountMatureByClassStmt = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM inventory_seeds
    WHERE user_id = ? AND is_mature = 1 AND class = ?
  `);
  invPickMatureByClassStmt = db.prepare(`
    SELECT id FROM inventory_seeds
    WHERE user_id = ? AND is_mature = 1 AND class = ?
    LIMIT ?
  `);
  gachaLogStmt = db.prepare(`
    INSERT INTO gacha_logs (user_id, consumed_cls, consumed_cnt, out_class, out_mutation, out_base, pull_index, pity10_after, pity90_after, step_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
}

try {
  openDb();
  if (!integrityOk(DB_PATH)) throw new Error('Integrity check failed on boot');
  runMigrations();       
  ensureGachaColumns();   // ✅ thêm dòng gọi ensureGachaColumns trong luồng khởi động chính
  ensurePlotColumns();    // ✅ đảm bảo cột locked cho plots
  prepareAll();
  console.log('[DB] ready');
  console.log('[PATHS]', { ROOT_DIR, PUBLIC_DIR, TOOLS_DIR, DB_PATH, SCHEMA_PATH, CLASS_WEIGHTS_PATH });
} catch (e) {
  console.error('[DB] startup failed:', e);
  process.exit(1);
}

// ==== Logging (file + table) ====
const LOG_DIR = path.join(ROOT_DIR, 'log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logLine(level, msg, extra = {}) {
  const line = JSON.stringify({ t: Date.now(), level, msg, ...extra });
  console.log(line);
  const f = path.join(LOG_DIR, new Date().toISOString().slice(0, 10) + '.log');
  fs.appendFile(f, line + '\n', () => {});
}

// === log helpers ===
function logAction(userId, action, payloadObj) {
  const payload = JSON.stringify(payloadObj ?? {});
  try { logStmt.run(userId ?? null, action, payload, Date.now()); } catch {}
  logLine('action', action, { userId, ...payloadObj });
}

// ==== Helpers ====
function now() { return Date.now(); }
function floorPriceBase(className) {
  const basics = ['fire', 'water', 'wind', 'earth'];
  return basics.includes(className)
    ? 100
    : (seedBasePriceStmt.get(className)?.base_price ?? 100);
}
function calcBreedBase(aPrice, bPrice) { return Math.floor((aPrice + bPrice) * 0.8); }
function sellToShopAmount(base) { return Math.floor(base * 1.1); }
function marketMin(base) { return Math.floor(base * 0.9); }
function marketMax(base) { return Math.floor(base * 1.5); }
function userFloorsCount(userId) { return getFloorsCountStmt.get(userId).cnt; }
function trapPriceForUser(userId) { return 1000 * userFloorsCount(userId); }
function trapMaxForUser(userId) { return userFloorsCount(userId) * 5; }

// ==== HTTP access log ====
app.use((req, _res, next) => {
  logLine('http', `${req.method} ${req.path}`, { ip: req.ip, body: req.body || null });
  next();
});

// ==== Auth ====
app.post('/auth/login', (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 2) return res.status(400).json({ error: 'Invalid username' });

  upsertUserStmt.run(username, now());
  const user = getUserStmt.get(username);

  // Đảm bảo có floor 1 + 10 plot
  ensureFloorStmt.run(user.id, 1);
  const floor = db.prepare(`SELECT * FROM floors WHERE user_id = ? AND idx = 1`).get(user.id);
  for (let i = 1; i <= 10; i++) ensurePlotStmt.run(floor.id, i);

  const sid = uuidv4();
  insertSessionStmt.run(sid, user.id, now());
  res.cookie('sid', sid, { httpOnly: true });

  // Init gacha queue nếu chưa có
  try { ensureGachaQueue(user.id, 24); } catch {}

  logAction(user.id, 'auth_login', { username });
  res.json({ userId: user.id, username: user.username, coins: user.coins });
});

function auth(req, res, next) {
  const sid = req.cookies.sid;
  if (!sid) return res.status(401).json({ error: 'No session' });
  const s = getSessionStmt.get(sid);
  if (!s) return res.status(401).json({ error: 'Invalid session' });
  req.userId = s.user_id;
  next();
}

// ====== Gacha helpers ======
function parseJSONSafe(s, fallback){
  try{ return JSON.parse(s); }catch{ return fallback; }
}
// cost cho step hiện tại: 1,3,5,7,...
function gachaCostForStep(step){ return (2 * step) + 1; }
// luôn đảm bảo queue đủ dài (cần N phần tử từ chỉ số step hiện tại)
function ensureGachaQueue(userId, needLen=24){
  const row = getGachaUserStmt.get(userId);
  let q = parseJSONSafe(row.queue_json, []);
  const targetLen = Math.max(needLen, (row.step||0) + 16);
  while (q.length < targetLen){
    q.push(pickWeightedClass(CLASS_WEIGHTS));
  }
  if (q.length !== parseJSONSafe(row.queue_json, []).length){
    updateGachaQueueStmt.run(JSON.stringify(q), userId);
  }
  return q;
}
function getGachaState(userId, preview=11){
  const info = getGachaUserStmt.get(userId);
  const q = ensureGachaQueue(userId, (info.step||0) + preview + 4);
  const step = info.step || 0;

  const currentCls = q[step] || pickWeightedClass(CLASS_WEIGHTS);
  const currentCnt = gachaCostForStep(step);

  // trả cả 2 dạng key: class/count và cls/cnt để client cũ/mới đều đọc được
  const current = {
    class: currentCls, count: currentCnt,
    cls:   currentCls, cnt:   currentCnt
  };

  const list = [];
  for (let i=1; i<=preview; i++){
    const idx = step + i;
    const cls = q[idx] || pickWeightedClass(CLASS_WEIGHTS);
    const cnt = gachaCostForStep(idx);
    list.push({
      class: cls, count: cnt,
      cls,   cnt
    });
  }

  const counts = {};
  try {
    const rows = db.prepare(`
      SELECT class, COUNT(*) AS c FROM inventory_seeds
      WHERE user_id = ? AND is_mature = 1
      GROUP BY class
    `).all(userId);
    for (const r of rows) counts[r.class] = r.c;
  } catch {}

  return {
    totalPulls: info.total_pulls || 0,
    pity10: info.pity10 || 0,
    pity90: info.pity90 || 0,
    step,
    current,
    next: list,
    invCounts: counts
  };
}

// chọn mutation theo pity rule (10 -> red/gold, 90 -> rainbow)
function pickGachaMutation(p10, p90){
  if ((p90+1) >= 90) return { key:'rainbow', mult: mutationMultiplier('rainbow') };
  if ((p10+1) >= 10) {
    const key = Math.random()<0.5 ? 'red' : 'gold';
    return { key, mult: mutationMultiplier(key) };
  }
  return rollMutationTier(); // có thể trả về {key:null} -> normal
}

// ==== State ====
app.get('/me/state', auth, (req, res) => {
  const me = getStateStmt.get(req.userId);
  const floors = getFloorsStmt.all(req.userId);
  const plots = floors.map(f => ({
    floor: f,
    plots: getPlotsByFloorStmt.all(f.id).map(p =>
      p.class ? { ...p, base_price: floorPriceBase(p.class) } : p
    )
  }));
  const potInv = invListPotsStmt.all(req.userId);
  const seedInv = invListSeedsStmt.all(req.userId);
  const market = marketOpenStmt.all();
  const gacha = getGachaState(req.userId, 11);
  logAction(req.userId, 'state_fetch', {});
  res.json({
    me, floors, plots, potInv, seedInv, market,
    trapPrice: trapPriceForUser(req.userId),
    trapMax: trapMaxForUser(req.userId),
    gacha
  });
});

// ==== Shop ====
app.post('/shop/buy', auth, (req, res) => {
  const { itemType, classOrType, qty = 1 } = req.body;
  if (qty < 1 || qty > 50) return res.status(400).json({ error: 'qty out of range' });

  if (itemType === 'seed') {
    const base = floorPriceBase(classOrType);
    const cost = base * qty;
    if (getUserByIdStmt.get(req.userId).coins < cost) {
      return res.status(400).json({ error: 'Not enough coins' });
    }
    subCoinsStmt.run(cost, req.userId);
    for (let i = 0; i < qty; i++) invAddSeedStmt.run(req.userId, classOrType, base, 0, null);
    logAction(req.userId, 'shop_buy_seed', { class: classOrType, qty, cost });
    return res.json({ ok: true });
  }

  if (itemType === 'pot') {
    const TYPE_MAP = {
      basic: { price: 100, speed_mult: 1.0, yield_mult: 1.0 },
      gold:  { price: 300, speed_mult: 1.0, yield_mult: 1.5 },
      timeskip: { price: 300, speed_mult: 0.67, yield_mult: 1.0 }
    };
    const cfg = TYPE_MAP[classOrType];
    if (!cfg) return res.status(400).json({ error: 'invalid pot type' });
    const cost = cfg.price * qty;
    if (getUserByIdStmt.get(req.userId).coins < cost) {
      return res.status(400).json({ error: 'Not enough coins' });
    }
    subCoinsStmt.run(cost, req.userId);
    for (let i = 0; i < qty; i++) invAddPotStmt.run(req.userId, classOrType, cfg.speed_mult, cfg.yield_mult);
    logAction(req.userId, 'shop_buy_pot', { type: classOrType, qty, cost });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'invalid itemType' });
});

app.post('/shop/buy-trap', auth, (req, res) => {
  const qtyRaw = parseInt(req.body?.qty, 10);
  const qty = Number.isFinite(qtyRaw) ? Math.min(50, Math.max(1, qtyRaw)) : 1;

  const priceEach = trapPriceForUser(req.userId);
  const floors = listFloorsByUserStmt.all(req.userId);
  const capacityLeft = floors.reduce((sum, f) => sum + Math.max(0, 5 - (f.trap_count || 0)), 0);

  if (capacityLeft <= 0) return res.status(400).json({ error: 'Trap capacity reached' });
  if (qty > capacityLeft) return res.status(400).json({ error: 'Not enough capacity', capacityLeft });

  const totalCost = priceEach * qty;
  const coins = getUserByIdStmt.get(req.userId).coins;
  if (coins < totalCost) return res.status(400).json({ error: 'Not enough coins', need: totalCost, have: coins });

  const tx = db.transaction(() => {
    subCoinsStmt.run(totalCost, req.userId);
    let remaining = qty;
    for (const f of floors) {
      if (remaining <= 0) break;
      const room = Math.max(0, 5 - (f.trap_count || 0));
      if (room > 0) {
        const add = Math.min(room, remaining);
        db.prepare(`UPDATE floors SET trap_count = trap_count + ? WHERE id = ?`).run(add, f.id);
        remaining -= add;
      }
    }
  });
  tx();

  logAction(req.userId, 'shop_buy_trap', { qty, priceEach, totalCost });
  res.json({ ok: true, qty, paid: totalCost });
});

// ==== Plot actions ====
app.post('/plot/place-pot', auth, (req, res) => {
  try {
    const { floorId, slot, potId } = req.body || {};
    if (!floorId || !slot || !potId) return res.status(400).json({ error: 'missing params' });

    const pot = invGetPotStmt.get(potId, req.userId);
    if (!pot) return res.status(400).json({ error: 'invalid pot' });

    const floor = getFloorByIdStmt.get(floorId);
    if (!floor || floor.user_id !== req.userId) return res.status(403).json({ error: 'not your floor' });

    const plot = getPlotsByFloorStmt.all(floorId).find(p => p.slot === Number(slot));
    if (!plot) return res.status(404).json({ error: 'plot not found' });
    if (plot.pot_id) return res.status(400).json({ error: 'plot already has a pot' });

    setPlotPotStmt.run(pot.id, pot.type, plot.id);
    invDelPotStmt.run(potId, req.userId);

    logAction(req.userId, 'place_pot', { floorId, slot, potId, type: pot.type });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/plot/plant', auth, (req, res) => {
  const { floorId, slot, seedId, mutation } = req.body;
  const seed = invGetSeedStmt.get(seedId, req.userId);
  if (!seed || seed.is_mature !== 0) return res.status(400).json({ error: 'seed must be not-planted' });

  const floor = getFloorByIdStmt.get(floorId);
  if (!floor || floor.user_id !== req.userId) return res.status(403).json({ error: 'not your floor' });

  const plot = getPlotsByFloorStmt.all(floorId).find(p => p.slot === Number(slot));
  if (!plot) return res.status(404).json({ error: 'plot not found' });
  if (!plot.pot_id) return res.status(400).json({ error: 'plot has no pot' });
  if (plot.stage !== 'empty') return res.status(400).json({ error: 'plot busy' });

  const baseTimeMap = { fire: 5 * 60e3, water: 5 * 60e3, wind: 5 * 60e3, earth: 5 * 60e3 };
  const base = baseTimeMap[seed.class] ?? 10 * 60e3;
  const speed = plot.pot_type === 'timeskip' ? 0.67 : 1.0;
  const growTime = Math.floor(base * speed);
  const mAt = now() + growTime;

  const mutFinal = req.body.mutation || seed.mutation || null;

  setPlotAfterPlantStmt.run(seedId, seed.class, mutFinal, now(), mAt, plot.id);
  invDelSeedStmt.run(seedId, req.userId);

  logAction(req.userId, 'plant', {
    floorId, slot, seedId, class: seed.class,
    mutation: mutFinal, mature_at: mAt
  });
  res.json({ ok: true, mature_at: mAt, mutation: mutFinal });
});

app.post('/plot/remove', auth, (req, res) => {
  try {
    const userId = req.userId;
    const { floorId, slot } = req.body || {};
    if (!floorId || !slot) {
      return res.status(400).json({ error: 'floorId và slot là bắt buộc' });
    }

    const plot = db.prepare(`
      SELECT p.id
      FROM plots p
      JOIN floors f ON f.id = p.floor_id
      WHERE f.user_id = ? AND f.id = ? AND p.slot = ?
    `).get(userId, floorId, slot);

    if (!plot) {
      return res.status(404).json({ error: 'Plot không tồn tại hoặc không thuộc user' });
    }

    db.prepare(`
      UPDATE plots
      SET pot_id = NULL,
          pot_type = NULL,
          seed_id = NULL,
          class = NULL,
          mutation = NULL,
          planted_at = NULL,
          mature_at = NULL,
          stage = 'empty',
          locked = 0
      WHERE id = ?
    `).run(plot.id);

    return res.json({ ok: true, plotId: plot.id });
  } catch (e) {
    console.error('[plot/remove] fail', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// NEW: toggle lock plot
app.post('/plot/lock', auth, (req, res) => {
  try {
    const { plotId, locked } = req.body || {};
    if (!Number.isInteger(plotId) || (locked !== 0 && locked !== 1)) {
      return res.status(400).json({ error: 'Invalid params' });
    }
    const p = getPlotByIdStmt.get(plotId);
    if (!p) return res.status(404).json({ error: 'plot not found' });
    const floor = getFloorByIdStmt.get(p.floor_id);
    if (!floor || floor.user_id !== req.userId) return res.status(403).json({ error: 'not your plot' });
    setPlotLockStmt.run(locked, plotId);
    logAction(req.userId, 'plot_lock', { plotId, locked });
    return res.json({ ok: true, plotId, locked });
  } catch (e) {
    console.error('[plot/lock] fail', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// tick: planted -> growing -> mature
setInterval(() => {
  if (!safeDbReady()) return;
  try {
    const rows = db.prepare(`SELECT * FROM plots WHERE stage IN ('planted','growing')`).all();
    const t = now();
    for (const r of rows) {
      if (r.stage === 'planted') {
        const half = r.planted_at + Math.floor((r.mature_at - r.planted_at) / 2);
        if (t >= half) setPlotStageStmt.run('growing', r.id);
      }
      if (r.stage === 'growing' && t >= r.mature_at) setPlotStageStmt.run('mature', r.id);
    }
  } catch (e) {
    console.error('[tick] error:', e);
  }
}, 2000);

app.post('/plot/harvest', auth, (req, res) => {
  const { plotId } = req.body;
  const p = db.prepare(`SELECT * FROM plots WHERE id = ?`).get(plotId);
  if (!p) return res.status(404).json({ error: 'plot not found' });
  if (p.stage !== 'mature') return res.status(400).json({ error: 'not mature yet' });
  if (p.locked) return res.status(409).json({ error: 'Plot is locked' });
  const base = floorPriceBase(p.class);
  invAddSeedStmt.run(req.userId, p.class, base, 1, p.mutation || null);
  clearPlotSeedOnlyStmt.run(plotId);
  logAction(req.userId, 'harvest', { plotId, class: p.class, base, mutation: p.mutation || null });
  res.json({ ok: true });
});

app.post('/plot/harvest-all', auth, (req, res) => {
  const floors = getFloorsStmt.all(req.userId);
  let count = 0;
  for (const f of floors) {
    const plots = getPlotsByFloorStmt.all(f.id);
    for (const p of plots) {
      if (p.stage === 'mature' && !p.locked) {
        const base = floorPriceBase(p.class);
        invAddSeedStmt.run(req.userId, p.class, base, 1, p.mutation || null);
        clearPlotSeedOnlyStmt.run(p.id);
        count++;
      }
    }
  }
  logAction(req.userId, 'harvest_all', { harvested: count });
  res.json({ ok: true, harvested: count });
});

// ==== Breed (mature only) ====
app.post('/breed', auth, (req, res) => {
  const { seedAId, seedBId } = req.body;
  const A = invGetSeedStmt.get(seedAId, req.userId);
  const B = invGetSeedStmt.get(seedBId, req.userId);
  if (!A || !B || A.is_mature !== 1 || B.is_mature !== 1) {
    return res.status(400).json({ error: 'seeds must be mature' });
  }

  const outClass = pickWeightedClass(CLASS_WEIGHTS);
  const baseOut = calcBreedBase(A.base_price, B.base_price);
  const mut = rollMutationTier(); // { key, mult }
  upsertSeedCatalogStmt.run(outClass, baseOut);
  invAddSeedStmt.run(req.userId, outClass, baseOut, 0, mut.key);
  invDelSeedStmt.run(seedAId, req.userId);
  invDelSeedStmt.run(seedBId, req.userId);

  logAction(req.userId, 'breed', {
    in: [A.class, B.class],
    out: outClass,
    base: baseOut,
    mutation: mut.key,
    weights_snapshot: CLASS_WEIGHTS
  });
  res.json({ ok: true, outClass, base: baseOut, mutation: mut.key, multiplier: mut.mult });
});

// ==== Sell to shop (mature only) ====
app.post('/sell/shop', auth, (req, res) => {
  const { seedId } = req.body;
  const S = invGetSeedStmt.get(seedId, req.userId);
  if (!S) return res.status(404).json({ error: 'seed not found' });
  if (S.is_mature !== 1) return res.status(400).json({ error: 'only mature seeds can be sold' });
  const mult = mutationMultiplier(S.mutation);
  const pay = sellToShopAmount(Math.floor(S.base_price * mult));
  invDelSeedStmt.run(seedId, req.userId);
  addCoinsStmt.run(pay, req.userId);
  logAction(req.userId, 'sell_shop', { seedId, class: S.class, paid: pay, mutation: S.mutation, multiplier: mult });
  res.json({ ok: true, paid: pay });
});

// ==== Market (mature only) ====
app.post('/market/list', auth, (req, res) => {
  const { seedId, askPrice } = req.body;
  const S = invGetSeedStmt.get(seedId, req.userId);
  if (!S) return res.status(404).json({ error: 'seed not found' });
  if (S.is_mature !== 1) return res.status(400).json({ error: 'only mature seeds can be listed' });

  const eff = Math.max(1, Math.floor(S.base_price * mutationMultiplier(S.mutation)));
  const min = marketMin(eff), max = marketMax(eff);
  if (askPrice < min || askPrice > max) {
    return res.status(400).json({ error: `ask must be within ${min}-${max}` });
  }
  marketCreateStmt.run(req.userId, seedId, S.class, S.base_price, S.mutation || null, askPrice, now());
  invDelSeedStmt.run(seedId, req.userId); // escrow
  logAction(req.userId, 'market_list', { seedId, class: S.class, askPrice, mutation: S.mutation || null });
  res.json({ ok: true });
});

app.post('/market/buy', auth, (req, res) => {
  const { listingId } = req.body;
  const L = marketGetStmt.get(listingId);
  if (!L || L.status !== 'open') return res.status(404).json({ error: 'listing not found' });
  const buyer = getUserByIdStmt.get(req.userId);
  if (buyer.coins < L.ask_price) return res.status(400).json({ error: 'not enough coins' });
  subCoinsStmt.run(L.ask_price, req.userId);
  addCoinsStmt.run(L.ask_price, L.seller_id);
  invAddSeedStmt.run(req.userId, L.class, L.base_price, 1, L.mutation || null); // mua về là mature
  marketCloseStmt.run(listingId);
  logAction(req.userId, 'market_buy', {
    listingId, class: L.class, base: L.base_price, paid: L.ask_price, seller: L.seller_id, mutation: L.mutation || null
  });
  res.json({ ok: true });
});

// ----- BUY FLOOR -----
app.post('/floors/buy', auth, (req, res) => {
  try {
    const userId = req.userId;
    const { maxIdx } = db.prepare(
      `SELECT COALESCE(MAX(idx), 0) AS maxIdx FROM floors WHERE user_id = ?`
    ).get(userId);
    const nextIdx = (maxIdx || 0) + 1;

    // Giá: tầng 1 miễn phí, các tầng sau = idx * 1000
    const price = (nextIdx === 1) ? 0 : nextIdx * 1000;

    const me = getUserByIdStmt.get(userId);
    if (!me) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (me.coins < price) {
      return res.status(400).json({ error: 'NOT_ENOUGH_COINS', need: price, have: me.coins });
    }

    const tx = db.transaction(() => {
      subCoinsStmt.run(price, userId);
      const info = db.prepare(
        `INSERT INTO floors (user_id, idx, unlocked, trap_count) VALUES (?, ?, 1, 0)`
      ).run(userId, nextIdx);
      const floorId = info.lastInsertRowid;
      for (let slot = 1; slot <= 10; slot++) {
        ensurePlotStmt.run(floorId, slot);
      }
    });
    tx();

    logAction(userId, 'buy_floor', { nextIdx, paid: price });
    return res.json({ ok: true, nextIdx, paid: price });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'BUY_FLOOR_FAILED' });
  }
});
app.get('/floors/buy', (_req, res) => res.status(405).json({ error: 'USE_POST' }));

/* ===================== GACHA API ===================== */
app.get('/gacha/state', auth, (req, res) => {
  try {
    const gacha = getGachaState(req.userId, 11);
    return res.json({ ok: true, gacha });
  } catch (e) {
    console.error('[gacha/state]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ====== NEW /gacha/roll WITH FIXED RATES ======
app.post('/gacha/roll', auth, (req, res) => {
  try {
    const u = getGachaUserStmt.get(req.userId);
    const queue = ensureGachaQueue(req.userId, (u.step||0) + 16);
    const step = u.step || 0;
    const needCnt = gachaCostForStep(step);
    const needCls = queue[step] || pickWeightedClass(CLASS_WEIGHTS);

    // check đủ nguyên liệu (mature seeds)
    const have = invCountMatureByClassStmt.get(req.userId, needCls)?.cnt || 0;
    if (have < needCnt) {
      return res.status(400).json({ error: 'NOT_ENOUGH_MATERIALS', need: { cls: needCls, cnt: needCnt }, have });
    }

    // Pick ids để đốt
    const ids = invPickMatureByClassStmt.all(req.userId, needCls, needCnt).map(r=>r.id);
    if (ids.length < needCnt) {
      return res.status(400).json({ error: 'INV_CHANGED_RETRY' });
    }

    // Gacha result (fixed rates)
    const nextPullIndex = (u.total_pulls || 0) + 1;
    const outcome = pickGachaOutcome();

    let rewardType;           // 'coins' | 'seed_planted' | 'seed_mature'
    let outClass = null;
    let outMutation = null;   // null | 'red' | 'gold' | 'rainbow'
    let outBase = null;       // base or coin amount for logs
    let coinAmount = null;

    if (outcome === 'rainbow') {
      // 1%: seed mature + rainbow, base = pulls × 100000
      rewardType = 'seed_mature';
      outClass = pickWeightedClass(CLASS_WEIGHTS);
      outMutation = 'rainbow';
      outBase = nextPullIndex * 100000;
    } else if (outcome === 'redgold') {
      // 9%: seed mature + red/gold, base = pulls × 10000
      rewardType = 'seed_mature';
      outClass = pickWeightedClass(CLASS_WEIGHTS);
      outMutation = (Math.random() < 0.5) ? 'red' : 'gold';
      outBase = nextPullIndex * 10000;
    } else if (outcome === 'coins') {
      // 30%: coins 1..1,000,000
      rewardType = 'coins';
      coinAmount = randIntInclusive(1, 1_000_000);
      outClass = 'coins';
      outBase = coinAmount;
      outMutation = null;
    } else if (outcome === 'seed_mature') {
      // 30%: seed mature, base = pulls × 10000 (no forced mutation)
      rewardType = 'seed_mature';
      outClass = pickWeightedClass(CLASS_WEIGHTS);
      outMutation = null;
      outBase = nextPullIndex * 10000;
    } else {
      // 30%: seed_planted, base = base chuẩn theo class
      rewardType = 'seed_planted';
      outClass = pickWeightedClass(CLASS_WEIGHTS);
      outMutation = null;
      outBase = floorPriceBase(outClass);
    }

    // Counters after (pity tăng bình thường, reset khi dính red/gold/rainbow)
    let pity10 = (u.pity10 || 0) + 1;
    let pity90 = (u.pity90 || 0) + 1;
    if (outMutation === 'red' || outMutation === 'gold' || outMutation === 'rainbow') pity10 = 0;
    if (outMutation === 'rainbow') pity90 = 0;

    let newStep = step + 1;
    let newQueue = queue.slice();
    // (giữ behavior) Nếu ra rainbow: reset step về 0 và random lại queue
    if (outMutation === 'rainbow') {
      newStep = 0;
      newQueue = [];
      const N = 32;
      for (let i=0;i<N;i++) newQueue.push(pickWeightedClass(CLASS_WEIGHTS));
    }

    const tx = db.transaction(() => {
      // consume
      for (const id of ids) invDelSeedStmt.run(id, req.userId);

      // reward
      if (rewardType === 'coins') {
        addCoinsStmt.run(coinAmount, req.userId);
      } else {
        upsertSeedCatalogStmt.run(outClass, outBase);
        const isMature = (rewardType === 'seed_mature') ? 1 : 0;
        invAddSeedStmt.run(req.userId, outClass, outBase, isMature, outMutation || null);
      }

      // update user gacha fields
      updateGachaStmt.run(
        nextPullIndex, pity10, pity90, newStep, JSON.stringify(newQueue), req.userId
      );

      // log
      gachaLogStmt.run(
        req.userId,
        needCls, needCnt,
        outClass, (outMutation || null), outBase, nextPullIndex,
        pity10, pity90, newStep
      );
    });
    tx();

    logAction(req.userId, 'gacha_roll', {
      consumed: { cls: needCls, cnt: needCnt, ids },
      reward: (rewardType === 'coins')
        ? { type:'coins', amount: coinAmount }
        : { type:rewardType, class: outClass, mutation: outMutation, base: outBase },
      totals_after: { pulls: nextPullIndex, pity10, pity90, step: newStep }
    });

    // Build response with new state pieces
    const gacha = getGachaState(req.userId, 11);
    return res.json({
      ok: true,
      reward_type: rewardType,
      out_class: outClass,
      out_mutation: outMutation,
      out_base: outBase,
      pull_index: nextPullIndex,
      consumed: { class: needCls, count: needCnt },
      reward: (rewardType === 'coins')
        ? { type:'coins', amount: coinAmount }
        : { type:rewardType, class: outClass, mutation: outMutation, base: outBase },
      totals: { pulls: nextPullIndex, pity10, pity90, step: newStep },
      gacha
    });
  } catch (e) {
    console.error('[gacha/roll]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ==== Online / Visit ====
app.get('/online', auth, (req, res) => {
  const rows = listUsersOnlineStmt.all();
  logAction(req.userId, 'online_list', { count: rows.length });
  res.json({ users: rows });
});

app.get('/visit/floors', auth, (req, res) => {
  const uid = parseInt(req.query.userId, 10);
  if (!uid) return res.status(400).json({ error: 'missing userId' });
  const floors = listFloorsByUserStmt.all(uid);
  res.json({ floors });
});

app.get('/visit/floor', auth, (req, res) => {
  const floorId = parseInt(req.query.floorId, 10);
  if (!floorId) return res.status(400).json({ error: 'missing floorId' });
  const floor = getFloorByIdStmt.get(floorId);
  if (!floor) return res.status(404).json({ error: 'floor not found' });

  const plotsRaw = getPlotsByFloorStmt.all(floorId);
  const plots = plotsRaw.map(p =>
    p.class ? { ...p, base_price: floorPriceBase(p.class) } : p
  );

  logAction(req.userId, 'visit_floor_view', { floorId, owner: floor.user_id, plots: plots.length });
  res.json({
    floor: { id: floor.id, idx: floor.idx, trap_count: floor.trap_count, user_id: floor.user_id },
    plots
  });
});

// ==== Visit: steal ====
app.post('/visit/steal-plot', auth, (req, res) => {
  const { targetUserId, floorId, plotId } = req.body;
  if (!targetUserId || !floorId || !plotId) return res.status(400).json({ error: 'missing params' });
  if (targetUserId === req.userId) return res.status(400).json({ error: 'cannot steal yourself' });

  const floor = getFloorByIdStmt.get(floorId);
  if (!floor || floor.user_id !== targetUserId) return res.status(404).json({ error: 'floor not found' });

  const used = useTrapOnFloorStmt.run(floorId).changes;
  if (used > 0) {
    const attacker = getUserByIdStmt.get(req.userId);
    const penalty = Math.max(1, Math.floor(attacker.coins * 0.05));
    subCoinsStmt.run(penalty, req.userId);
    logAction(req.userId, 'trap_triggered', { targetUserId, floorId, penalty, plotId });
    return res.json({ ok: false, trap: true, penalty });
  }

  const p = db.prepare(`SELECT * FROM plots WHERE id = ?`).get(plotId);
  if (!p || p.floor_id !== floorId) return res.status(404).json({ error: 'plot not found' });
  if (p.stage !== 'mature') {
    logAction(req.userId, 'steal_fail', { targetUserId, floorId, plotId, reason: 'not mature' });
    return res.json({ ok: false, reason: 'not mature' });
  }
  const base = floorPriceBase(p.class);
  invAddSeedStmt.run(req.userId, p.class, base, 1, p.mutation || null);
  clearPlotSeedOnlyStmt.run(p.id);
  logAction(req.userId, 'steal_success', { targetUserId, floorId, plotId: p.id, class: p.class, mutation: p.mutation || null });
  res.json({ ok: true, class: p.class, mutation: p.mutation || null });
});

// ==== RESTORE (upload) — safe: integrity + backup + rollback ====
const upload = multer({ storage: multer.memoryStorage() });
app.post('/admin/upload-db', upload.single('db'), (req, res) => {
  if ((req.headers['x-admin-token'] || '') !== (process.env.ADMIN_TOKEN || '')) {
    return res.sendStatus(403);
  }
  if (!req.file) return res.status(400).json({ error: 'missing file field "db"' });

  const TMP = DB_PATH + '.restore';
  const BAK = DB_PATH + '.bak';

  try { fs.writeFileSync(TMP, req.file.buffer); }
  catch (e) { return res.status(500).json({ error: 'write tmp failed', detail: String(e) }); }

  // pre-check integrity
  try {
    const t = new Database(TMP);
    const r = t.prepare('PRAGMA integrity_check').get();
    t.close();
    if (!r || r.integrity_check !== 'ok') {
      fs.unlinkSync(TMP);
      return res.status(400).json({ error: 'integrity_check != ok' });
    }
  } catch (e) {
    try { fs.unlinkSync(TMP); } catch {}
    return res.status(500).json({ error: 'integrity probe failed', detail: String(e) });
  }

  restoring = true;
  try {
    try { db?.close(); } catch {}
    try { if (fs.existsSync(DB_PATH)) fs.renameSync(DB_PATH, BAK); } catch {}
    fs.renameSync(TMP, DB_PATH);

    // mở thử + chạy schema để sync code hiện tại
    const test = new Database(DB_PATH);
    try {
      const r2 = test.prepare('PRAGMA integrity_check').get();
      if (!r2 || r2.integrity_check !== 'ok') throw new Error('integrity after swap != ok');
      const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
      test.exec(sql);
    } finally { test.close(); }

    // mở lại DB chính
    openDb();
    if (!integrityOk(DB_PATH)) throw new Error('Integrity check failed on boot');
    runMigrations();       // đọc schema.sql
    ensureGachaColumns();  // ✅ tự thêm cột còn thiếu (an toàn, idempotent)
    ensurePlotColumns();   // ✅ đảm bảo cột locked tồn tại
    prepareAll();   

    try { fs.unlinkSync(BAK); } catch {}
    logLine('restore', 'success');
    restoring = false;
    return res.json({ ok: true, restarted: false });
  } catch (e) {
    // rollback
    logLine('restore', 'failed, rollback', { err: String(e) });
    try {
      if (fs.existsSync(BAK)) {
        try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch {}
        fs.renameSync(BAK, DB_PATH);
      }
      openDb(); runMigrations(); ensureGachaColumns(); ensurePlotColumns(); prepareAll();
    } catch {}
    try { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); } catch {}
    restoring = false;
    return res.status(500).json({ error: 'restore failed (rolled back)', detail: String(e) });
  }
});

// ==== WebSocket push state ====
const sockets = new Map(); // userId -> ws
wss.on('connection', (ws, req) => {
  const cookies = (req.headers.cookie || '').split(';').map(v => v.trim());
  const sid = (cookies.find(c => c.startsWith('sid=')) || 'sid=').split('=')[1];
  const sess = sid ? getSessionStmt.get(sid) : null;
  if (!sess) { ws.close(); return; }
  sockets.set(sess.user_id, ws);
  ws.on('close', () => sockets.delete(sess.user_id));
  logLine('ws', 'connected', { userId: sess.user_id });
});

function pushState(userId) {
  if (!safeDbReady()) return;
  const ws = sockets.get(userId);
  if (!ws || ws.readyState !== 1) return;

  const me = getStateStmt.get(userId);
  const floors = getFloorsStmt.all(userId);
  const plots = floors.map(f => ({
    floor: f,
    plots: getPlotsByFloorStmt.all(f.id).map(p =>
      p.class ? { ...p, base_price: floorPriceBase(p.class) } : p
    )
  }));
  const potInv = invListPotsStmt.all(userId);
  const seedInv = invListSeedsStmt.all(userId);
  const market = marketOpenStmt.all();
  const gacha = getGachaState(userId, 11);

  ws.send(JSON.stringify({
    type: 'state:update',
    payload: {
      me, floors, plots, potInv, seedInv, market,
      trapPrice: trapPriceForUser(userId),
      trapMax: trapMaxForUser(userId),
      gacha
    }
  }));
}
setInterval(() => { for (const uid of sockets.keys()) pushState(uid); }, 3000);

// ==== Start ====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Game running on port ' + PORT);
});

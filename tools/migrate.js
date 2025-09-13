// migrate.js (ESM, one-file) – init schema + patch Gacha columns safely
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import url from 'url';

// ---------- Paths ----------
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, 'game.db');  // mặc định tạo/upgrade file này

const SCHEMA_CANDIDATES = [
  path.join(__dirname, 'tools', 'schema.sql'),
  path.join(__dirname, 'schema.sql'),
];

function pickSchemaPath() {
  for (const p of SCHEMA_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`schema.sql not found. Tried:\n- ${SCHEMA_CANDIDATES.join('\n- ')}`);
}

// ---------- Small helpers ----------
function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}
function hasColumn(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}
function addCol(db, table, colDef) {
  const [col] = colDef.split(/\s+/);
  if (!hasColumn(db, table, col)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
    console.log(`✓ Added ${table}.${col}`);
  } else {
    console.log(`• Skip ${table}.${col} (exists)`);
  }
}

// ---------- Operations ----------
function runInitSchema(dbPath) {
  const schemaPath = pickSchemaPath();
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const db = openDb(dbPath);
  // ... sau khi mở DB
const hasLocked = db.prepare(`
  SELECT 1 FROM pragma_table_info('plots') WHERE name='locked'
`).get();
if (!hasLocked) {
  db.exec(`ALTER TABLE plots ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;`);
}

  try {
    db.exec(sql);
    const r = db.prepare('PRAGMA integrity_check').get();
    if (r?.integrity_check !== 'ok') throw new Error('PRAGMA integrity_check failed after migration');
    console.log(`[migrate:init] OK -> ${path.relative(__dirname, dbPath)} using ${path.relative(__dirname, schemaPath)}`);
  } finally {
    db.close();
  }
}

function runPatchGacha(dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.error('[migrate:patch] DB not found:', dbPath);
    process.exit(1);
  }
  const db = openDb(dbPath);
  try {
    db.transaction(() => {
      addCol(db, 'users', `gacha_total_pulls INTEGER NOT NULL DEFAULT 0`);
      addCol(db, 'users', `gacha_pity10      INTEGER NOT NULL DEFAULT 0`);
      addCol(db, 'users', `gacha_pity90      INTEGER NOT NULL DEFAULT 0`);
      addCol(db, 'users', `gacha_step        INTEGER NOT NULL DEFAULT 0`);   // reset về 0 khi ra rainbow
      addCol(db, 'users', `gacha_queue_json  TEXT    NOT NULL DEFAULT '[]'`); // queue {cost,class} hiện tại + 11 tiếp theo
    })();
    console.log('[migrate:patch] Gacha columns ensured for', path.relative(__dirname, dbPath));
  } finally {
    db.close();
  }
}

// ---------- CLI ----------
/*
  Cách dùng:
  - Khởi tạo schema mới (tạo file game.db nếu chưa có):
      node migrate.js --init
      node migrate.js --init --db ./path/to/your.db

  - Patch DB cũ để thêm cột Gacha:
      node migrate.js --patch --db ./path/to/old.db

  - Nếu không truyền --db, mặc định dùng ./game.db
*/
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
function getArgValue(flag, defVal) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return defVal;
}
const dbPath = getArgValue('--db', DEFAULT_DB_PATH);

if (has('--init')) {
  runInitSchema(dbPath);
} else if (has('--patch')) {
  runPatchGacha(dbPath);
} else {
  console.log('Nothing to do. Use one of:');
  console.log('  --init [--db path]   Initialize schema.sql into a DB file');
  console.log('  --patch [--db path]  Add/ensure Gacha columns on an existing DB');
  console.log('Example: node migrate.js --patch --db ./data.db');
}

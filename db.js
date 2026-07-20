/**
 * 数据层:SQLite(Node 内置 node:sqlite,零原生依赖)
 * - open():打开/建库(WAL+外键+schema 幂等)
 * - tx(db, fn):事务助手
 * - backup(db):WAL 检查点后按日期滚动备份,保留 30 份
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(__dirname, 'backups');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'tiangang.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT, criteria TEXT, year INTEGER DEFAULT 2026,
  progress INTEGER DEFAULT 0, status TEXT DEFAULT '未开始', sort REAL,
  notion_id TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  goal_id   INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind TEXT DEFAULT '个人成长',
  priority TEXT,
  status TEXT DEFAULT 'pool',
  month TEXT,
  start_date TEXT, end_date TEXT,
  sort REAL, note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  done_at TEXT,
  notion_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_month  ON tasks(month);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  text TEXT,
  date TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  notion_id TEXT,
  UNIQUE(task_id, date)
);
CREATE INDEX IF NOT EXISTS idx_exec_date ON executions(date);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts TEXT DEFAULT (datetime('now','localtime')),
  entity TEXT, entity_id INTEGER, action TEXT,
  before_json TEXT, after_json TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function open(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function backup(db, dbPath = DB_PATH) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const dest = path.join(BACKUP_DIR, `tiangang-${stamp}.db`);
    fs.copyFileSync(dbPath, dest);
    // 滚动保留 30 份
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    return dest;
  } catch (e) { console.error('备份失败:', e.message); return null; }
}

module.exports = { open, tx, backup, DB_PATH, SCHEMA };

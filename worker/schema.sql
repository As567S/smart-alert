-- smart-alert D1 表结构
-- 部署时执行一次即可 (Worker 首次运行时也会自动建表, 这份是给手动 wrangler d1 execute 用的):
--   wrangler d1 execute smart-alert --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, down_alerted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS disks (
  host TEXT NOT NULL, serial TEXT NOT NULL, model TEXT, kind TEXT,
  level INTEGER NOT NULL DEFAULT 0, temp_streak INTEGER NOT NULL DEFAULT 0,
  last_crit_remind INTEGER NOT NULL DEFAULT 0, metrics TEXT, updated INTEGER,
  PRIMARY KEY (host, serial));
CREATE TABLE IF NOT EXISTS history (
  host TEXT NOT NULL, serial TEXT NOT NULL, ts INTEGER NOT NULL,
  level INTEGER NOT NULL, passed INTEGER, temp INTEGER, metrics TEXT);
CREATE INDEX IF NOT EXISTS idx_history ON history (host, serial, ts);

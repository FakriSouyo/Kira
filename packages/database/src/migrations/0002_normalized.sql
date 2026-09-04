-- Normalized tables (Phase 9A) — vision Phase 7 jadi real, idempotent
CREATE TABLE IF NOT EXISTS financials_normalized (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  year INTEGER NOT NULL,
  revenue REAL,
  earnings REAL,
  roe REAL,
  net_margin REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ticker, year)
);
CREATE INDEX IF NOT EXISTS idx_financials_norm_ticker_year ON financials_normalized(ticker, year);

CREATE TABLE IF NOT EXISTS daily_normalized (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close_price REAL,
  volume INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_norm_ticker_date ON daily_normalized(ticker, date);

-- Durable, idempotent P&L ledger. Apply with: wrangler d1 migrations apply trading-pnl --remote
CREATE TABLE IF NOT EXISTS pnl_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broker TEXT NOT NULL CHECK (broker IN ('Zerodha','AngelOne','Groww','5Paisa','m.Stock')),
  execution_id TEXT NOT NULL,
  order_id TEXT,
  exchange_order_id TEXT,
  trade_time TEXT NOT NULL,
  trading_symbol TEXT NOT NULL,
  exchange TEXT,
  segment TEXT,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  gross_value REAL NOT NULL,
  broker_realised_pnl REAL,
  charges REAL,
  taxes REAL,
  raw_json TEXT NOT NULL,
  source_endpoint TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (broker, execution_id)
);
CREATE INDEX IF NOT EXISTS idx_pnl_exec_time ON pnl_executions(trade_time);
CREATE INDEX IF NOT EXISTS idx_pnl_exec_broker_time ON pnl_executions(broker, trade_time);
CREATE TABLE IF NOT EXISTS pnl_ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broker TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_duplicate INTEGER NOT NULL DEFAULT 0,
  coverage_start TEXT,
  coverage_end TEXT,
  source_endpoint TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_pnl_runs_started ON pnl_ingestion_runs(started_at);
CREATE TABLE IF NOT EXISTS pnl_baseline (
  baseline_key TEXT PRIMARY KEY,
  baseline_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pnl_reconciliation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  broker TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

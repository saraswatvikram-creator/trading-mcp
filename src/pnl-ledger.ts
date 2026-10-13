export type PnlBroker = "Zerodha" | "AngelOne" | "Groww" | "5Paisa" | "m.Stock";

export interface PnlExecution {
  broker: PnlBroker;
  executionId: string;
  orderId?: string | null;
  exchangeOrderId?: string | null;
  tradeTime: string;
  tradingSymbol: string;
  exchange?: string | null;
  segment?: string | null;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  brokerRealisedPnl?: number | null;
  charges?: number | null;
  taxes?: number | null;
  raw: unknown;
  sourceEndpoint: string;
}

export interface PnlDatabase {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface IngestResult {
  broker: PnlBroker;
  recordsSeen: number;
  recordsInserted: number;
  recordsDuplicate: number;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  error?: string;
}

/**
 * Persist broker executions idempotently. The unique broker/execution key is
 * the final duplicate guard; INSERT OR IGNORE means replaying a date range
 * cannot double-post a fill. Missing broker-reported realised P&L remains NULL:
 * this module deliberately does not infer realised P&L from positions or fills.
 */
export async function persistExecutions(
  db: PnlDatabase,
  broker: PnlBroker,
  executions: PnlExecution[],
  sourceEndpoint: string,
  coverageStart: string | null,
  coverageEnd: string | null,
  startedAt: string,
  completedAt: string,
  status: "SUCCESS" | "PARTIAL" | "FAILED" = "SUCCESS",
  error?: string,
): Promise<IngestResult> {
  const insertStatements = executions.map((e) => db.prepare(
    `INSERT OR IGNORE INTO pnl_executions
      (broker, execution_id, order_id, exchange_order_id, trade_time,
       trading_symbol, exchange, segment, side, quantity, price, gross_value,
       broker_realised_pnl, charges, taxes, raw_json, source_endpoint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    broker, e.executionId, e.orderId ?? null, e.exchangeOrderId ?? null,
    e.tradeTime, e.tradingSymbol, e.exchange ?? null, e.segment ?? null,
    e.side, e.quantity, e.price, e.quantity * e.price,
    e.brokerRealisedPnl ?? null, e.charges ?? null, e.taxes ?? null,
    JSON.stringify(e.raw), e.sourceEndpoint || sourceEndpoint,
  ));

  // Batch inserts are atomic within D1's batch transaction. Check total counts
  // before/after to calculate inserts without relying on driver-specific changes.
  const before = await db.prepare(
    "SELECT COUNT(*) AS n FROM pnl_executions WHERE broker = ?"
  ).bind(broker).first<{ n: number }>();
  if (insertStatements.length) await db.batch(insertStatements);
  const after = await db.prepare(
    "SELECT COUNT(*) AS n FROM pnl_executions WHERE broker = ?"
  ).bind(broker).first<{ n: number }>();
  const recordsInserted = Math.max(0, Number(after?.n ?? 0) - Number(before?.n ?? 0));
  const recordsSeen = executions.length;
  const recordsDuplicate = Math.max(0, recordsSeen - recordsInserted);

  await db.prepare(
    `INSERT INTO pnl_ingestion_runs
      (broker, started_at, completed_at, status, records_seen, records_inserted,
       records_duplicate, coverage_start, coverage_end, source_endpoint, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    broker, startedAt, completedAt, status, recordsSeen, recordsInserted,
    recordsDuplicate, coverageStart, coverageEnd, sourceEndpoint, error ?? null,
  ).run();

  return { broker, recordsSeen, recordsInserted, recordsDuplicate, status, ...(error ? { error } : {}) };
}

export async function getLedgerCoverage(db: PnlDatabase) {
  const result = await db.prepare(
    `SELECT broker, COUNT(*) AS executions,
       MIN(trade_time) AS first_execution, MAX(trade_time) AS last_execution,
       SUM(CASE WHEN broker_realised_pnl IS NOT NULL THEN 1 ELSE 0 END) AS rows_with_realised_pnl
     FROM pnl_executions GROUP BY broker ORDER BY broker`
  ).all();
  return result.results ?? [];
}

export async function getConfirmedRealisedPnl(
  db: PnlDatabase,
  startInclusive: string,
  endExclusive: string,
) {
  // Only sum explicit broker-supplied realised-P&L values. A null means
  // unknown, not zero. The returned known-row count exposes partial coverage.
  return db.prepare(
    `SELECT broker,
       SUM(broker_realised_pnl) AS realised_pnl,
       COUNT(*) AS executions,
       SUM(CASE WHEN broker_realised_pnl IS NOT NULL THEN 1 ELSE 0 END) AS confirmed_rows,
       SUM(CASE WHEN broker_realised_pnl IS NULL THEN 1 ELSE 0 END) AS unconfirmed_rows
     FROM pnl_executions
     WHERE trade_time >= ? AND trade_time < ?
     GROUP BY broker ORDER BY broker`
  ).bind(startInclusive, endExclusive).all();
}

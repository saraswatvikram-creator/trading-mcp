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

  // D1 batch is transactional. Use each INSERT's changes count rather than
  // table counts, which can be distorted by simultaneous ingestion runs.
  // Keep each D1 batch below the platform's statement-count limits while
  // preserving the database UNIQUE constraint as the authoritative replay guard.
  const insertResults: D1Result[] = [];
  for (let offset = 0; offset < insertStatements.length; offset += 50) {
    const chunk = insertStatements.slice(offset, offset + 50);
    insertResults.push(...await db.batch(chunk));
  }
  const recordsInserted = insertResults.reduce(
    (total, result) => total + Number((result as any)?.meta?.changes ?? 0),
    0,
  );
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


export interface LedgerExecutionRow {
  broker: PnlBroker;
  trade_time: string;
  trading_symbol: string;
  exchange: string | null;
  segment: string | null;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  charges: number | null;
  taxes: number | null;
  broker_realised_pnl: number | null;
}

export interface RealisedMatch {
  broker: PnlBroker;
  closeTime: string;
  tradingSymbol: string;
  quantity: number;
  grossPnl: number;
}

/**
 * Reconstruct realised gross P&L by FIFO matching of the durable execution
 * ledger. Open lots are deliberately excluded. This calculation is only as
 * complete as the underlying execution history; it cannot manufacture older
 * fills that a broker API did not return.
 */
export function calculateFifoRealisedPnl(rows: LedgerExecutionRow[]): {
  matches: RealisedMatch[];
  openLots: number;
  unmatchedCloseQuantity: number;
} {
  const ordered = [...rows].sort((a, b) =>
    a.trade_time.localeCompare(b.trade_time)
  );
  type Lot = { signedQty: number; price: number };
  const lotsByContract = new Map<string, Lot[]>();
  const matches: RealisedMatch[] = [];
  let unmatchedCloseQuantity = 0;

  for (const row of ordered) {
    const qty = Number(row.quantity);
    const price = Number(row.price);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) continue;
    const key = [row.broker, row.exchange ?? "", row.trading_symbol].join("|");
    const lots = lotsByContract.get(key) ?? [];
    let remaining = qty;
    const direction = row.side === "BUY" ? 1 : -1;

    while (remaining > 0 && lots.length > 0 && Math.sign(lots[0].signedQty) !== direction) {
      const lot = lots[0];
      const matched = Math.min(remaining, Math.abs(lot.signedQty));
      const grossPnl = lot.signedQty > 0
        ? (price - lot.price) * matched
        : (lot.price - price) * matched;
      matches.push({
        broker: row.broker,
        closeTime: row.trade_time,
        tradingSymbol: row.trading_symbol,
        quantity: matched,
        grossPnl,
      });
      remaining -= matched;
      lot.signedQty += direction * matched;
      if (Math.abs(lot.signedQty) < 1e-9) lots.shift();
    }

    // A close without an opening execution in the available ledger indicates
    // incomplete history; do not treat it as a fully reconstructed round trip.
    if (remaining > 0) {
      if (lots.length === 0 || Math.sign(lots[lots.length - 1].signedQty) === direction) {
        lots.push({ signedQty: direction * remaining, price });
      } else {
        unmatchedCloseQuantity += remaining;
      }
    }
    lotsByContract.set(key, lots);
  }

  const openLots = [...lotsByContract.values()].reduce((sum, lots) => sum + lots.length, 0);
  return { matches, openLots, unmatchedCloseQuantity };
}

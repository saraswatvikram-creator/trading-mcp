/**
 * Realised-P&L ledger primitives.
 *
 * This module intentionally does not call broker APIs or persist records. Broker
 * adapters must normalize their raw fills into this schema and provide verified
 * opening inventory before using the FIFO calculator. Missing opening inventory
 * must never be silently treated as zero.
 */

export type BrokerName = "Zerodha" | "AngelOne" | "Groww" | "5Paisa" | "m.Stock";
export type TradeSide = "BUY" | "SELL";

export interface ExecutionRecord {
  schema_version: 1;
  broker: BrokerName;
  broker_trade_id: string;
  broker_order_id: string | null;
  exchange: string | null;
  instrument: string;
  product: string | null;
  side: TradeSide;
  quantity: number;
  price: number;
  executed_at: string;
  source: string;
  raw_hash?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  record?: ExecutionRecord;
}

export interface InventoryLot {
  /** Positive quantity for a long lot; negative quantity for a short lot. */
  signed_quantity: number;
  price: number;
  opened_at?: string;
}

export interface RealisedMatch {
  instrument: string;
  closing_trade_id: string;
  closing_broker: BrokerName;
  matched_quantity: number;
  entry_price: number;
  exit_price: number;
  realised_gross_pnl: number;
  entry_side: TradeSide;
  exit_side: TradeSide;
}

export interface FifoResult {
  status: "COMPLETE_FOR_SUPPLIED_INVENTORY" | "INCOMPLETE_OPENING_INVENTORY";
  realised_gross_pnl: number;
  matches: RealisedMatch[];
  ending_inventory: Record<string, InventoryLot[]>;
  unmatched_closing_quantity: Record<string, number>;
  notes: string[];
}

const BROKERS = new Set<BrokerName>(["Zerodha", "AngelOne", "Groww", "5Paisa", "m.Stock"]);

/** Validate and normalize a raw fill after a broker-specific adapter maps fields. */
export function validateExecution(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { valid: false, errors: ["Execution must be an object."] };
  const r = input as Record<string, unknown>;

  if (!BROKERS.has(r.broker as BrokerName)) errors.push("broker is missing or unsupported");
  if (typeof r.broker_trade_id !== "string" || !r.broker_trade_id.trim()) errors.push("broker_trade_id is required");
  if (r.broker_order_id !== null && r.broker_order_id !== undefined && typeof r.broker_order_id !== "string") errors.push("broker_order_id must be a string or null");
  if (typeof r.instrument !== "string" || !r.instrument.trim()) errors.push("instrument is required");
  if (r.side !== "BUY" && r.side !== "SELL") errors.push("side must be BUY or SELL");
  if (typeof r.quantity !== "number" || !Number.isFinite(r.quantity) || r.quantity <= 0) errors.push("quantity must be a positive finite number");
  if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price < 0) errors.push("price must be a non-negative finite number");
  if (typeof r.executed_at !== "string" || !Number.isFinite(Date.parse(r.executed_at))) errors.push("executed_at must be a parseable timestamp");
  if (typeof r.source !== "string" || !r.source.trim()) errors.push("source is required");

  if (errors.length) return { valid: false, errors };
  const record: ExecutionRecord = {
    schema_version: 1,
    broker: r.broker as BrokerName,
    broker_trade_id: (r.broker_trade_id as string).trim(),
    broker_order_id: typeof r.broker_order_id === "string" ? r.broker_order_id : null,
    exchange: typeof r.exchange === "string" ? r.exchange : null,
    instrument: (r.instrument as string).trim(),
    product: typeof r.product === "string" ? r.product : null,
    side: r.side as TradeSide,
    quantity: r.quantity as number,
    price: r.price as number,
    executed_at: new Date(r.executed_at as string).toISOString(),
    source: (r.source as string).trim(),
    ...(typeof r.raw_hash === "string" ? { raw_hash: r.raw_hash } : {}),
  };
  return { valid: true, errors: [], record };
}

/**
 * Stable execution identity. Include the execution date because some broker trade
 * IDs are only unique within a trading session. Broker is always part of the key.
 */
export function executionKey(r: Pick<ExecutionRecord, "broker" | "broker_trade_id" | "executed_at">): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(r.executed_at));
  const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const executionDate = dateParts.year + "-" + dateParts.month + "-" + dateParts.day;
  return "realised-ledger:v1:trade:" + encodeURIComponent(r.broker) + ":" + executionDate + ":" + encodeURIComponent(r.broker_trade_id);
}

/**
 * Deduplicate fills by broker + trade ID. If the same identity has conflicting
 * economics, reject the conflict rather than silently choosing one version.
 */
export function deduplicateExecutions(records: ExecutionRecord[]): {
  records: ExecutionRecord[];
  duplicate_count: number;
  conflicts: string[];
} {
  const byKey = new Map<string, ExecutionRecord>();
  const conflicts: string[] = [];
  let duplicate_count = 0;
  for (const r of records) {
    const key = executionKey(r);
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, r);
      continue;
    }
    if (prior.quantity !== r.quantity || prior.price !== r.price || prior.side !== r.side ||
        prior.instrument !== r.instrument || prior.executed_at !== r.executed_at) {
      conflicts.push(key + " has conflicting fill details");
    } else {
      duplicate_count++;
    }
  }
  return { records: [...byKey.values()].sort((a, b) => Date.parse(a.executed_at) - Date.parse(b.executed_at)), duplicate_count, conflicts };
}

/**
 * Calculate gross realised P&L with FIFO matching.
 *
 * Opening inventory is required per broker + instrument. Executions from different
 * brokers are deliberately not netted together. Any fill that cannot be matched
 * against supplied inventory is reported as unmatched, not assumed to be a fresh
 * position. Charges, taxes and interest are excluded from this gross calculation.
 */
export function calculateFifoRealisedPnl(
  executions: ExecutionRecord[],
  openingInventory: Record<string, InventoryLot[]>,
  openingInventoryVerified: boolean,
): FifoResult {
  const lots: Record<string, InventoryLot[]> = {};
  for (const [key, values] of Object.entries(openingInventory)) {
    lots[key] = values.map((lot) => ({ ...lot }));
  }
  const matches: RealisedMatch[] = [];
  const unmatched: Record<string, number> = {};
  const ordered = [...executions].sort((a, b) => Date.parse(a.executed_at) - Date.parse(b.executed_at));

  for (const trade of ordered) {
    const key = trade.broker + "|" + trade.instrument;
    const inventory = lots[key] ?? (lots[key] = []);
    let remaining = trade.quantity;
    const incomingSigned = trade.side === "BUY" ? remaining : -remaining;

    while (remaining > 0 && inventory.length > 0) {
      const lot = inventory[0];
      if (Math.sign(lot.signed_quantity) === Math.sign(incomingSigned)) break;
      const matched = Math.min(remaining, Math.abs(lot.signed_quantity));
      const entrySide: TradeSide = lot.signed_quantity > 0 ? "BUY" : "SELL";
      const entryPrice = lot.price;
      const pnl = entrySide === "BUY"
        ? (trade.price - entryPrice) * matched
        : (entryPrice - trade.price) * matched;
      matches.push({
        instrument: trade.instrument,
        closing_trade_id: trade.broker_trade_id,
        closing_broker: trade.broker,
        matched_quantity: matched,
        entry_price: entryPrice,
        exit_price: trade.price,
        realised_gross_pnl: Number(pnl.toFixed(2)),
        entry_side: entrySide,
        exit_side: trade.side,
      });
      lot.signed_quantity += incomingSigned > 0 ? matched : -matched;
      remaining -= matched;
      if (Math.abs(lot.signed_quantity) < 1e-9) inventory.shift();
    }

    if (remaining > 1e-9) {
      // Only add a new lot when the caller explicitly attests that the supplied
      // opening inventory is complete. Otherwise the remaining quantity may
      // close an unprovided carry-forward lot and cannot be classified safely.
      if (openingInventoryVerified) {
        inventory.push({ signed_quantity: incomingSigned > 0 ? remaining : -remaining, price: trade.price, opened_at: trade.executed_at });
      } else {
        unmatched[key] = (unmatched[key] ?? 0) + remaining;
      }
    }
  }

  return {
    status: openingInventoryVerified ? "COMPLETE_FOR_SUPPLIED_INVENTORY" : "INCOMPLETE_OPENING_INVENTORY",
    realised_gross_pnl: Number(matches.reduce((sum, m) => sum + m.realised_gross_pnl, 0).toFixed(2)),
    matches,
    ending_inventory: lots,
    unmatched_closing_quantity: unmatched,
    notes: [
      "Gross realised P&L only; charges, STT, exchange fees, GST and interest are not deducted.",
      "Broker ledgers are isolated; identical instruments held at different brokers are not netted.",
      openingInventoryVerified
        ? "Caller attested that opening inventory is complete for the calculation window."
        : "Opening inventory is not verified; unmatched quantities are excluded and totals are not complete.",
    ],
  };
}

/** India financial year start (1 April) for a timestamp. */
export function indianFinancialYearStart(timestamp: string): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const startYear = month >= 3 ? year : year - 1;
  return startYear + "-04-01";
}

import {
  validateExecution,
  type ExecutionRecord,
  type ValidationResult,
} from "./realised-ledger.ts";

function normalizeBrokerTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  // Broker tradebook timestamps are India-local when no UTC offset is supplied.
  // Attach the explicit IST offset so runtime timezone cannot change interpretation.
  const hasZone = /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(trimmed);
  const normalized = hasZone ? trimmed : trimmed.replace(" ", "T") + "+05:30";
  return Number.isFinite(Date.parse(normalized)) ? new Date(normalized).toISOString() : "";
}

export interface AdapterResult {
  records: ExecutionRecord[];
  rejected: Array<{ index: number; errors: string[] }>;
}

/**
 * Normalize the documented shape returned by Zerodha Kite's current-day
 * GET /trades endpoint. This adapter only maps executed trade rows; it does
 * not call the broker API and does not infer opening inventory.
 */
export function normalizeZerodhaTrades(payload: unknown): AdapterResult {
  const root = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : null;
  const rows = Array.isArray(root?.data) ? root.data : null;
  if (!rows) {
    return { records: [], rejected: [{ index: -1, errors: ["Zerodha trade response must contain a data array."] }] };
  }

  const records: ExecutionRecord[] = [];
  const rejected: AdapterResult["rejected"] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      rejected.push({ index, errors: ["Trade row must be an object."] });
      return;
    }
    const raw = row as Record<string, unknown>;
    const tradeId = raw.trade_id;
    const orderId = raw.order_id;
    const timestamp = raw.fill_timestamp ?? raw.exchange_timestamp ?? raw.order_timestamp;
    const instrument = raw.tradingsymbol;
    const side = raw.transaction_type;
    const quantity = raw.quantity;
    const price = raw.average_price ?? raw.price;

    const candidate = {
      schema_version: 1,
      broker: "Zerodha",
      broker_trade_id: typeof tradeId === "string" || typeof tradeId === "number" ? String(tradeId) : "",
      broker_order_id: typeof orderId === "string" || typeof orderId === "number" ? String(orderId) : null,
      exchange: typeof raw.exchange === "string" ? raw.exchange : null,
      instrument: typeof instrument === "string" ? instrument : "",
      product: typeof raw.product === "string" ? raw.product : null,
      side,
      quantity: typeof quantity === "number" ? quantity : Number.NaN,
      price: typeof price === "number" ? price : Number.NaN,
      executed_at: normalizeBrokerTimestamp(timestamp),
      source: "zerodha_kite_trades",
    };
    const checked: ValidationResult = validateExecution(candidate);
    if (!checked.valid || !checked.record) {
      rejected.push({ index, errors: checked.errors });
      return;
    }
    records.push(checked.record);
  });
  return { records, rejected };
}

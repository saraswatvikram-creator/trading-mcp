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
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
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


/** Normalize documented Angel One SmartAPI getTradeBook rows for a known India trade date. */
export function normalizeAngelOneTradeBook(payload: unknown, indiaTradeDate: string): AdapterResult {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(indiaTradeDate) ||
      Number.isNaN(Date.parse(indiaTradeDate + "T00:00:00+05:30"))) {
    return { records: [], rejected: [{ index: -1, errors: ["Angel One trade date must be YYYY-MM-DD."] }] };
  }
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const rows = Array.isArray(root?.data) ? root.data : null;
  if (!rows) return { records: [], rejected: [{ index: -1, errors: ["Angel One trade response must contain a data array."] }] };
  const records: ExecutionRecord[] = [];
  const rejected: AdapterResult["rejected"] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      rejected.push({ index, errors: ["Trade row must be an object."] });
      return;
    }
    const raw = row as Record<string, unknown>;
    const fillTime = typeof raw.filltime === "string" ? raw.filltime.trim() : "";
    const timestamp = /^\\d{2}:\\d{2}:\\d{2}$/.test(fillTime)
      ? normalizeBrokerTimestamp(indiaTradeDate + "T" + fillTime + "+05:30")
      : normalizeBrokerTimestamp(raw.filltime);
    const candidate = {
      schema_version: 1,
      broker: "AngelOne",
      broker_trade_id: typeof raw.fillid === "string" || typeof raw.fillid === "number" ? String(raw.fillid) : "",
      broker_order_id: typeof raw.orderid === "string" || typeof raw.orderid === "number" ? String(raw.orderid) : null,
      exchange: typeof raw.exchange === "string" ? raw.exchange : null,
      instrument: typeof raw.tradingsymbol === "string" ? raw.tradingsymbol : "",
      product: typeof raw.producttype === "string" ? raw.producttype : null,
      side: typeof raw.transactiontype === "string" ? raw.transactiontype.toUpperCase() : "",
      quantity: typeof raw.fillsize === "number" ? raw.fillsize : Number(raw.fillsize),
      price: typeof raw.fillprice === "number" ? raw.fillprice : Number(raw.fillprice),
      executed_at: timestamp,
      source: "angelone_smartapi_tradebook",
    };
    const checked = validateExecution(candidate);
    if (!checked.valid || !checked.record) rejected.push({ index, errors: checked.errors });
    else records.push(checked.record);
  });
  return { records, rejected };
}

/** Normalize documented Groww Get Trades for Order response rows. */
export function normalizeGrowwOrderTrades(payload: unknown): AdapterResult {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const body = root?.payload && typeof root.payload === "object" ? root.payload as Record<string, unknown> : null;
  const rows = Array.isArray(body?.trade_list) ? body.trade_list : null;
  if (!rows) return { records: [], rejected: [{ index: -1, errors: ["Groww trade response must contain payload.trade_list."] }] };
  const records: ExecutionRecord[] = [];
  const rejected: AdapterResult["rejected"] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      rejected.push({ index, errors: ["Trade row must be an object."] });
      return;
    }
    const raw = row as Record<string, unknown>;
    if (raw.trade_status !== undefined && raw.trade_status !== "COMPLETED") {
      rejected.push({ index, errors: ["Trade row is not completed; it was not recorded as an execution."] });
      return;
    }
    const tradeId = raw.groww_trade_id ?? raw.exchange_trade_id;
    const timestamp = raw.trade_date_time ?? raw.created_at;
    const candidate = {
      schema_version: 1,
      broker: "Groww",
      broker_trade_id: typeof tradeId === "string" || typeof tradeId === "number" ? String(tradeId) : "",
      broker_order_id: typeof raw.groww_order_id === "string" || typeof raw.groww_order_id === "number" ? String(raw.groww_order_id) : null,
      exchange: typeof raw.exchange === "string" ? raw.exchange : null,
      instrument: typeof raw.trading_symbol === "string" ? raw.trading_symbol : "",
      product: typeof raw.product === "string" ? raw.product : null,
      side: typeof raw.transaction_type === "string" ? raw.transaction_type.toUpperCase() : "",
      quantity: typeof raw.quantity === "number" ? raw.quantity : Number(raw.quantity),
      price: typeof raw.price === "number" ? raw.price : Number(raw.price),
      executed_at: normalizeBrokerTimestamp(timestamp),
      source: "groww_order_trades",
    };
    const checked = validateExecution(candidate);
    if (!checked.valid || !checked.record) rejected.push({ index, errors: checked.errors });
    else records.push(checked.record);
  });
  return { records, rejected };
}

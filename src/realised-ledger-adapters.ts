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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(indiaTradeDate) ||
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
    const timestamp = /^\d{2}:\d{2}:\d{2}$/.test(fillTime)
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


function normalizeFivePaisaDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("/Date(") && trimmed.endsWith(")/")) {
    const inner = trimmed.slice(6, -2);
    const millisText = inner.match(/^-?\d+/)?.[0];
    const millis = millisText === undefined ? Number.NaN : Number(millisText);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : "";
  }
  return normalizeBrokerTimestamp(trimmed);
}

/** Normalize the documented 5Paisa Xstream V1 TradeBook response. */
export function normalizeFivePaisaTradeBook(payload: unknown): AdapterResult {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const body = root?.body && typeof root.body === "object" ? root.body as Record<string, unknown> : null;
  if (!body || !Array.isArray(body.TradeBookDetail)) {
    return { records: [], rejected: [{ index: -1, errors: ["5Paisa response must contain body.TradeBookDetail."] }] };
  }
  if (body.Status !== undefined && Number(body.Status) !== 0 && Number(body.Status) !== 1) {
    return { records: [], rejected: [{ index: -1, errors: ["5Paisa tradebook reported an API/session error; response was not treated as an empty tradebook."] }] };
  }
  const rows = body.TradeBookDetail;
  const records: ExecutionRecord[] = [];
  const rejected: AdapterResult["rejected"] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      rejected.push({ index, errors: ["Trade row must be an object."] });
      return;
    }
    const raw = row as Record<string, unknown>;
    const ex = String(raw.Exch ?? "").toUpperCase();
    const exType = String(raw.ExchType ?? "").toUpperCase();
    const exchange = exType === "D" ? (ex === "B" ? "BFO" : ex === "N" ? "NFO" : "") : ex === "B" ? "BSE" : ex === "N" ? "NSE" : ex === "M" ? "MCX" : "";
    const candidate = {
      schema_version: 1,
      broker: "5Paisa",
      broker_trade_id: typeof raw.ExchangeTradeID === "string" || typeof raw.ExchangeTradeID === "number" ? String(raw.ExchangeTradeID) : "",
      broker_order_id: typeof raw.ExchOrderID === "string" || typeof raw.ExchOrderID === "number" ? String(raw.ExchOrderID) : null,
      exchange: exchange || null,
      instrument: typeof raw.ScripName === "string" ? raw.ScripName : "",
      product: typeof raw.DelvIntra === "string" ? raw.DelvIntra : null,
      side: raw.BuySell === "B" ? "BUY" : raw.BuySell === "S" ? "SELL" : "",
      quantity: typeof raw.Qty === "number" ? raw.Qty : Number(raw.Qty),
      price: typeof raw.Rate === "number" ? raw.Rate : Number(raw.Rate),
      executed_at: normalizeFivePaisaDate(raw.ExchangeTradeTime),
      source: "fivepaisa_xstream_tradebook",
    };
    const checked = validateExecution(candidate);
    if (!checked.valid || !checked.record) rejected.push({ index, errors: checked.errors });
    else records.push(checked.record);
  });
  return { records, rejected };
}

function normalizeMStockTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const match = value.trim().match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (match) return normalizeBrokerTimestamp(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6]}`);
  return normalizeBrokerTimestamp(value);
}

/** Normalize the documented m.Stock Type A tradebook response. */
export function normalizeMStockTradeBook(payload: unknown): AdapterResult {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const rows = Array.isArray(root?.data) ? root.data : null;
  if (!rows) return { records: [], rejected: [{ index: -1, errors: ["m.Stock tradebook response must contain a data array."] }] };
  if (String(root?.status ?? "").toLowerCase() !== "success") {
    return { records: [], rejected: [{ index: -1, errors: ["m.Stock did not report a successful tradebook response."] }] };
  }
  const records: ExecutionRecord[] = [];
  const rejected: AdapterResult["rejected"] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      rejected.push({ index, errors: ["Trade row must be an object."] });
      return;
    }
    const raw = row as Record<string, unknown>;
    const candidate = {
      schema_version: 1,
      broker: "m.Stock",
      broker_trade_id: typeof raw.TRADE_NUMBER === "string" || typeof raw.TRADE_NUMBER === "number" ? String(raw.TRADE_NUMBER) : "",
      broker_order_id: typeof raw.EXCH_ORDER_NUMBER === "string" || typeof raw.EXCH_ORDER_NUMBER === "number" ? String(raw.EXCH_ORDER_NUMBER) : null,
      exchange: typeof raw.EXCHANGE === "string" ? raw.EXCHANGE : null,
      instrument: typeof raw.SYMBOL === "string" ? raw.SYMBOL : typeof raw.FULL_SYMBOL === "string" ? raw.FULL_SYMBOL : "",
      product: typeof raw.PRODUCT === "string" ? raw.PRODUCT : null,
      side: typeof raw.BUY_SELL === "string" && raw.BUY_SELL.toUpperCase() === "BUY" ? "BUY" :
        typeof raw.BUY_SELL === "string" && raw.BUY_SELL.toUpperCase() === "SELL" ? "SELL" : "",
      quantity: typeof raw.QUANTITY === "number" ? raw.QUANTITY : Number(raw.QUANTITY),
      price: typeof raw.PRICE === "number" ? raw.PRICE : Number(raw.PRICE),
      executed_at: normalizeMStockTimestamp(raw.ORDER_DATE_TIME),
      source: "mstock_typea_tradebook",
    };
    const checked = validateExecution(candidate);
    if (!checked.valid || !checked.record) rejected.push({ index, errors: checked.errors });
    else records.push(checked.record);
  });
  return { records, rejected };
}

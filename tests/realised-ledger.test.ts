import { test } from "node:test";
import { persistExecutions, readExecutionPartition, type LedgerKV } from "../src/realised-ledger-store.ts";
import assert from "node:assert/strict";
import {
  calculateFifoRealisedPnl,
  deduplicateExecutions,
  executionKey,
  inventoryKey,
  validateExecution,
  type ExecutionRecord,
} from "../src/realised-ledger.ts";

function fill(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    schema_version: 1,
    broker: "Zerodha",
    broker_trade_id: "T1",
    broker_order_id: "O1",
    exchange: "NFO",
    instrument: "NIFTY26OCT24000CE",
    product: "NRML",
    side: "SELL",
    quantity: 50,
    price: 100,
    executed_at: "2026-10-23T09:30:00.000Z",
    source: "test",
    ...overrides,
  };
}

test("validateExecution normalizes valid timestamps and rejects invalid quantities", () => {
  const good = validateExecution(fill());
  assert.equal(good.valid, true);
  assert.equal(good.record?.executed_at, "2026-10-23T09:30:00.000Z");
  const bad = validateExecution(fill({ quantity: 0 }));
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes("quantity")));
});

test("executionKey scopes identity by broker, date, and trade ID", () => {
  const a = fill();
  const sameOtherBroker = fill({ broker: "Groww" });
  const sameNextDay = fill({ executed_at: "2026-10-24T09:30:00.000Z" });
  assert.notEqual(executionKey(a), executionKey(sameOtherBroker));
  assert.notEqual(executionKey(a), executionKey(sameNextDay));
  // UTC date is still 23 Oct, but this timestamp is 24 Oct in India.
  const lateIndia = fill({ executed_at: "2026-10-23T20:00:00.000Z" });
  const sameIndiaDate = fill({ executed_at: "2026-10-24T01:00:00.000Z" });
  assert.equal(executionKey(lateIndia), executionKey(sameIndiaDate));
});

test("deduplicateExecutions removes identical duplicates and flags conflicting duplicates", () => {
  const a = fill();
  const exact = deduplicateExecutions([a, { ...a }]);
  assert.equal(exact.records.length, 1);
  assert.equal(exact.duplicate_count, 1);
  assert.equal(exact.conflicts.length, 0);

  const conflict = deduplicateExecutions([a, fill({ price: 101 })]);
  assert.equal(conflict.records.length, 1);
  assert.equal(conflict.conflicts.length, 1);
});

test("FIFO realises profit on closing a short option against verified opening inventory", () => {
  const sell = fill({ broker_trade_id: "SELL1", side: "SELL", quantity: 50, price: 100 });
  const buy = fill({ broker_trade_id: "BUY1", side: "BUY", quantity: 50, price: 40, executed_at: "2026-10-23T10:00:00.000Z" });
  const result = calculateFifoRealisedPnl([sell, buy], {}, true);
  assert.equal(result.status, "COMPLETE_FOR_SUPPLIED_INVENTORY");
  assert.equal(result.realised_gross_pnl, 3000);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].entry_side, "SELL");
  assert.equal(result.matches[0].exit_side, "BUY");
});

test("incomplete opening inventory is explicitly flagged and does not invent realised P&L", () => {
  const buy = fill({ broker_trade_id: "BUY1", side: "BUY", quantity: 50, price: 40 });
  const sell = fill({ broker_trade_id: "SELL1", side: "SELL", quantity: 50, price: 100, executed_at: "2026-10-23T10:00:00.000Z" });
  const result = calculateFifoRealisedPnl([buy, sell], {}, false);
  assert.equal(result.status, "INCOMPLETE_OPENING_INVENTORY");
  assert.equal(result.realised_gross_pnl, 0);
  assert.ok(Object.keys(result.unmatched_closing_quantity).length > 0);
  assert.ok(result.notes.some((n) => n.includes("not verified")));
});

test("FIFO does not net identical instruments across different brokers", () => {
  const open = fill({ broker: "Zerodha", broker_trade_id: "Z1", side: "SELL", quantity: 50, price: 100 });
  const close = fill({ broker: "Groww", broker_trade_id: "G1", side: "BUY", quantity: 50, price: 40, executed_at: "2026-10-23T10:00:00.000Z" });
  const result = calculateFifoRealisedPnl([open, close], {}, true);
  assert.equal(result.realised_gross_pnl, 0);
  assert.equal(result.matches.length, 0);
});

test("FIFO handles partial closes and leaves the residual short quantity open", () => {
  const sell = fill({ broker_trade_id: "SELL1", side: "SELL", quantity: 100, price: 100 });
  const buy = fill({ broker_trade_id: "BUY1", side: "BUY", quantity: 40, price: 60, executed_at: "2026-10-23T10:00:00.000Z" });
  const result = calculateFifoRealisedPnl([sell, buy], {}, true);
  assert.equal(result.realised_gross_pnl, 1600);
  assert.equal(result.matches.length, 1);
  assert.equal(result.ending_inventory["Zerodha|NFO|NRML|NIFTY26OCT24000CE"][0].signed_quantity, -60);
});

test("FIFO handles a position reversal after closing the existing long lot", () => {
  const openLong = fill({ broker_trade_id: "BUY1", side: "BUY", quantity: 30, price: 80 });
  const sellThroughZero = fill({ broker_trade_id: "SELL1", side: "SELL", quantity: 50, price: 100, executed_at: "2026-10-23T10:00:00.000Z" });
  const buyBack = fill({ broker_trade_id: "BUY2", side: "BUY", quantity: 20, price: 90, executed_at: "2026-10-23T11:00:00.000Z" });
  const result = calculateFifoRealisedPnl([openLong, sellThroughZero, buyBack], {}, true);
  assert.equal(result.realised_gross_pnl, 800);
  assert.equal(result.matches.length, 2);
  assert.equal(result.ending_inventory["Zerodha|NFO|NRML|NIFTY26OCT24000CE"].length, 0);
});

test("KV execution persistence is idempotent and partitions by broker and India trading date", async () => {
  class MemoryKV implements LedgerKV {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async put(key: string, value: string) { this.values.set(key, value); }
  }
  const kv = new MemoryKV();
  const a = fill({ executed_at: "2026-10-23T20:00:00.000Z" });
  const first = await persistExecutions(kv, [a]);
  assert.equal(first[0].accepted, 1);
  const second = await persistExecutions(kv, [a]);
  assert.equal(second[0].accepted, 0);
  assert.equal(second[0].duplicate_count, 1);
  assert.equal((await readExecutionPartition(kv, "Zerodha", "2026-10-24")).length, 1);
  assert.equal((await readExecutionPartition(kv, "Groww", "2026-10-24")).length, 0);
});

test("KV execution persistence refuses conflicting duplicate identity without overwriting", async () => {
  class MemoryKV implements LedgerKV {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async put(key: string, value: string) { this.values.set(key, value); }
  }
  const kv = new MemoryKV();
  const a = fill();
  await persistExecutions(kv, [a]);
  const key = [...kv.values.keys()][0];
  const before = kv.values.get(key);
  const conflict = await persistExecutions(kv, [fill({ price: 999 })]);
  assert.ok(conflict[0].conflicts.length > 0);
  assert.equal(kv.values.get(key), before);
});


test("KV persistence refuses to overwrite a corrupt existing partition", async () => {
  class MemoryKV implements LedgerKV {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async put(key: string, value: string) { this.values.set(key, value); }
  }
  const kv = new MemoryKV();
  const key = "realised-ledger:v1:partition:Zerodha:2026-10-23";
  kv.values.set(key, "{not-json");
  const result = await persistExecutions(kv, [fill()]);
  assert.equal(result[0].accepted, 0);
  assert.match(result[0].rejected[0].errors[0], /corrupt/i);
  assert.equal(kv.values.get(key), "{not-json");
});

test("KV read rejects invalid date syntax and invalid records in stored partitions", async () => {
  class MemoryKV implements LedgerKV {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async put(key: string, value: string) { this.values.set(key, value); }
  }
  const kv = new MemoryKV();
  await assert.rejects(() => readExecutionPartition(kv, "Zerodha", "2026/10/23"), /YYYY-MM-DD/);
  const key = "realised-ledger:v1:partition:Zerodha:2026-10-23";
  kv.values.set(key, JSON.stringify([{ ...fill(), quantity: -1 }]));
  await assert.rejects(() => readExecutionPartition(kv, "Zerodha", "2026-10-23"), /invalid records/i);
});


test("KV reader rejects valid-looking records stored under the wrong broker/date partition", async () => {
  class MemoryKV implements LedgerKV {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async put(key: string, value: string) { this.values.set(key, value); }
  }
  const kv = new MemoryKV();
  const key = "realised-ledger:v1:partition:Zerodha:2026-10-23";
  kv.values.set(key, JSON.stringify([fill({ broker: "Groww" })]));
  await assert.rejects(
    () => readExecutionPartition(kv, "Zerodha", "2026-10-23"),
    /partition identity mismatch/i,
  );
});

import { normalizeZerodhaTrades, normalizeAngelOneTradeBook, normalizeGrowwOrderTrades, normalizeFivePaisaTradeBook, normalizeMStockTradeBook } from "../src/realised-ledger-adapters.ts";

test("Zerodha adapter normalizes executed trades and rejects malformed rows without dropping valid fills", () => {
  const result = normalizeZerodhaTrades({
    status: "success",
    data: [
      {
        trade_id: 12345,
        order_id: 67890,
        exchange: "NFO",
        tradingsymbol: "NIFTY26OCT24000CE",
        product: "NRML",
        transaction_type: "SELL",
        quantity: 65,
        average_price: 102.5,
        fill_timestamp: "2026-10-23 09:30:00",
      },
      {
        trade_id: "BAD",
        order_id: "BADORDER",
        exchange: "NFO",
        tradingsymbol: "NIFTY26OCT24000CE",
        transaction_type: "BUY",
        quantity: 0,
        average_price: 20,
        fill_timestamp: "2026-10-23 09:31:00",
      },
    ],
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].broker, "Zerodha");
  assert.equal(result.records[0].broker_trade_id, "12345");
  assert.equal(result.records[0].side, "SELL");
  assert.equal(result.records[0].quantity, 65);
  assert.equal(result.records[0].executed_at, "2026-10-23T04:00:00.000Z");
  assert.equal(result.rejected.length, 1);
});

test("Zerodha adapter refuses payloads without a data array", () => {
  const result = normalizeZerodhaTrades({ status: "success", data: null });
  assert.equal(result.records.length, 0);
  assert.equal(result.rejected.length, 1);
});


test("FIFO inventory key separates exchange and product for the same symbol", () => {
  const base = fill();
  assert.notEqual(inventoryKey(base), inventoryKey({ ...base, product: "MIS" }));
  assert.notEqual(inventoryKey(base), inventoryKey({ ...base, exchange: "BSE" }));
  const first = fill({ side: "SELL", price: 100, product: "NRML" });
  const otherProduct = fill({ side: "BUY", price: 40, product: "MIS", executed_at: "2026-10-23T10:00:00.000Z" });
  const result = calculateFifoRealisedPnl([first, otherProduct], {}, true);
  assert.equal(result.matches.length, 0);
  assert.equal(result.realised_gross_pnl, 0);
});


test("Zerodha adapter preserves explicit timestamp offsets instead of treating them as IST", () => {
  const result = normalizeZerodhaTrades({
    data: [{
      trade_id: "OFFSET1",
      order_id: "ORDER1",
      exchange: "NFO",
      tradingsymbol: "NIFTY26OCT24000CE",
      product: "NRML",
      transaction_type: "BUY",
      quantity: 65,
      price: 25,
      fill_timestamp: "2026-10-23T09:30:00+05:30",
    }],
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].executed_at, "2026-10-23T04:00:00.000Z");
  assert.equal(result.rejected.length, 0);
});

test("FIFO rejects invalid opening inventory rather than calculating from corrupted lots", () => {
  const trade = fill({ side: "BUY", broker_trade_id: "BUY1" });
  const key = inventoryKey(trade);
  assert.throws(
    () => calculateFifoRealisedPnl([trade], { [key]: [{ signed_quantity: 0, price: 100 }] }, true),
    /Invalid opening inventory lot/i,
  );
  assert.throws(
    () => calculateFifoRealisedPnl([trade], { [key]: [{ signed_quantity: 10, price: Number.NaN }] }, true),
    /Invalid opening inventory lot/i,
  );
});


test("Angel One adapter normalizes documented tradebook fields using an explicit India trade date", () => {
  const result = normalizeAngelOneTradeBook({
    status: true,
    data: [{
      exchange: "NFO",
      producttype: "CARRYFORWARD",
      tradingsymbol: "NIFTY26OCT24000CE",
      transactiontype: "SELL",
      fillprice: "102.50",
      fillsize: "65",
      orderid: "ORDER-A1",
      fillid: "FILL-A1",
      filltime: "13:27:53",
    }],
  }, "2026-10-23");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].broker, "AngelOne");
  assert.equal(result.records[0].broker_trade_id, "FILL-A1");
  assert.equal(result.records[0].quantity, 65);
  assert.equal(result.records[0].price, 102.5);
  assert.equal(result.records[0].executed_at, "2026-10-23T07:57:53.000Z");
});

test("Angel One adapter refuses to infer the trade date", () => {
  const result = normalizeAngelOneTradeBook({ data: [] }, "");
  assert.equal(result.records.length, 0);
  assert.match(result.rejected[0].errors[0], /trade date/i);
});

test("Groww adapter normalizes completed documented trade rows and rejects non-completed rows", () => {
  const result = normalizeGrowwOrderTrades({
    status: "SUCCESS",
    payload: {
      trade_list: [
        {
          price: 75.25,
          quantity: 65,
          groww_order_id: "ORDER-G1",
          groww_trade_id: "TRADE-G1",
          trade_status: "COMPLETED",
          trading_symbol: "NIFTY26OCT24000CE",
          exchange: "NFO",
          segment: "FNO",
          product: "NRML",
          transaction_type: "BUY",
          trade_date_time: "2026-10-23T10:15:00+05:30",
        },
        {
          price: 75.25,
          quantity: 65,
          groww_order_id: "ORDER-G2",
          groww_trade_id: "TRADE-G2",
          trade_status: "PENDING",
          trading_symbol: "NIFTY26OCT24000CE",
          exchange: "NFO",
          product: "NRML",
          transaction_type: "BUY",
          trade_date_time: "2026-10-23T10:16:00+05:30",
        },
      ],
    },
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].broker, "Groww");
  assert.equal(result.records[0].broker_trade_id, "TRADE-G1");
  assert.equal(result.records[0].executed_at, "2026-10-23T04:45:00.000Z");
  assert.equal(result.rejected.length, 1);
});


test("5Paisa adapter normalizes documented Xstream tradebook fields and epoch timestamp", () => {
  const result = normalizeFivePaisaTradeBook({
    body: {
      Status: 0,
      TradeBookDetail: [{
        BuySell: "S",
        DelvIntra: "I",
        Exch: "N",
        ExchType: "D",
        ExchOrderID: "EXORDER-5P",
        ExchangeTradeID: "EXTRADE-5P",
        ExchangeTradeTime: "/Date(1707364850000+0530)/",
        Qty: 50,
        Rate: 2.55,
        ScripName: "NIFTY 08 Feb 2024 CE 22300.00",
      }],
    },
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].broker, "5Paisa");
  assert.equal(result.records[0].broker_trade_id, "EXTRADE-5P");
  assert.equal(result.records[0].exchange, "NFO");
  assert.equal(result.records[0].side, "SELL");
  assert.equal(result.records[0].quantity, 50);
  assert.equal(result.records[0].executed_at, "2024-02-08T08:00:50.000Z");
});

test("5Paisa adapter does not mistake invalid sessions for an empty tradebook", () => {
  const result = normalizeFivePaisaTradeBook({ body: { Status: 9, Message: "Invalid Session", TradeBookDetail: [] } });
  assert.equal(result.records.length, 0);
  assert.match(result.rejected[0].errors[0], /session error/i);
});

test("m.Stock adapter normalizes documented Type A tradebook fields", () => {
  const result = normalizeMStockTradeBook({
    status: "success",
    data: [{
      BUY_SELL: "Sell",
      EXCHANGE: "NFO",
      EXCH_ORDER_NUMBER: "ORDER-MS1",
      ORDER_DATE_TIME: "23-10-2026 13:08:42",
      PRICE: 6.98,
      PRODUCT: "NRML",
      QUANTITY: 65,
      SYMBOL: "NIFTY26OCT24000CE",
      TRADE_NUMBER: "TRADE-MS1",
    }],
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].broker, "m.Stock");
  assert.equal(result.records[0].broker_trade_id, "TRADE-MS1");
  assert.equal(result.records[0].side, "SELL");
  assert.equal(result.records[0].exchange, "NFO");
  assert.equal(result.records[0].executed_at, "2026-10-23T07:38:42.000Z");
});

test("m.Stock adapter rejects unsuccessful payloads instead of returning an empty ledger", () => {
  const result = normalizeMStockTradeBook({ status: "error", data: null });
  assert.equal(result.records.length, 0);
  assert.match(result.rejected[0].errors[0], /successful tradebook/i);
});

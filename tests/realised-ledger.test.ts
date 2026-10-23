import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateFifoRealisedPnl,
  deduplicateExecutions,
  executionKey,
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

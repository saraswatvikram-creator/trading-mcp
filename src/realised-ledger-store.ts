import {
  deduplicateExecutions,
  executionKey,
  validateExecution,
  type BrokerName,
  type ExecutionRecord,
} from "./realised-ledger.ts";

export interface LedgerKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface PersistResult {
  accepted: number;
  duplicate_count: number;
  rejected: Array<{ index: number; errors: string[] }>;
  conflicts: string[];
  key: string;
  total_records: number;
}

const MAX_RECORDS_PER_PARTITION = 2500;
const PREFIX = "realised-ledger:v1:partition:";

function indiaDate(timestamp: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}

function partitionKey(broker: BrokerName, date: string): string {
  return PREFIX + encodeURIComponent(broker) + ":" + date;
}

function partitionIdentity(key: string): { broker: string; date: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const suffix = key.slice(PREFIX.length);
  const separator = suffix.lastIndexOf(":");
  if (separator < 1) return null;
  try {
    return { broker: decodeURIComponent(suffix.slice(0, separator)), date: suffix.slice(separator + 1) };
  } catch {
    return null;
  }
}

function recordsMatchPartition(records: ExecutionRecord[], key: string): boolean {
  const identity = partitionIdentity(key);
  return !!identity && records.every((record) => record.broker === identity.broker && indiaDate(record.executed_at) === identity.date);
}

/**
 * Persist normalized fills in broker/day partitions. The per-partition cap keeps
 * an unusually large day from growing one KV value without bound. This is an
 * idempotent snapshot upsert, not a transactionally locked database: concurrent
 * writes may race, so callers should serialize collection per broker/day.
 */
export async function persistExecutions(
  kv: LedgerKV,
  inputs: unknown[],
): Promise<PersistResult[]> {
  const grouped = new Map<string, ExecutionRecord[]>();
  const rejected: Array<{ index: number; errors: string[] }> = [];
  inputs.forEach((input, index) => {
    const result = validateExecution(input);
    if (!result.valid || !result.record) {
      rejected.push({ index, errors: result.errors });
      return;
    }
    const record = result.record;
    const date = indiaDate(record.executed_at);
    const key = partitionKey(record.broker, date);
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  });

  const results: PersistResult[] = [];
  for (const [key, incoming] of grouped) {
    const currentText = await kv.get(key);
    let current: ExecutionRecord[] = [];
    if (currentText) {
      try {
        const parsed: unknown = JSON.parse(currentText);
        if (!Array.isArray(parsed)) throw new Error("partition is not an array");
        const checked = parsed.map(validateExecution);
        if (checked.some((x) => !x.valid || !x.record)) throw new Error("partition contains invalid records");
        current = checked.map((x) => x.record as ExecutionRecord);
        if (!recordsMatchPartition(current, key)) throw new Error("partition identity mismatch");
      } catch {
        results.push({
          accepted: 0, duplicate_count: 0,
          rejected: [{ index: -1, errors: ["Existing ledger partition is corrupt; left unchanged."] }],
          conflicts: [], key, total_records: 0,
        });
        continue;
      }
    }

    const combined = deduplicateExecutions([...current, ...incoming]);
    if (combined.conflicts.length) {
      results.push({
        accepted: 0, duplicate_count: combined.duplicate_count,
        rejected: [{ index: -1, errors: ["Conflicting duplicate execution identity; partition not changed."] }],
        conflicts: combined.conflicts, key, total_records: current.length,
      });
      continue;
    }
    if (combined.records.length > MAX_RECORDS_PER_PARTITION) {
      results.push({
        accepted: 0, duplicate_count: combined.duplicate_count,
        rejected: [{ index: -1, errors: ["Partition record limit exceeded; partition not changed."] }],
        conflicts: [], key, total_records: current.length,
      });
      continue;
    }

    const oldKeys = new Set(current.map(executionKey));
    const accepted = combined.records.filter((record) => !oldKeys.has(executionKey(record))).length;
    await kv.put(key, JSON.stringify(combined.records));
    results.push({
      accepted, duplicate_count: incoming.length - accepted,
      rejected: [], conflicts: [], key, total_records: combined.records.length,
    });
  }

  if (rejected.length) {
    results.push({ accepted: 0, duplicate_count: 0, rejected, conflicts: [], key: "validation", total_records: 0 });
  }
  return results;
}

export async function readExecutionPartition(
  kv: LedgerKV,
  broker: BrokerName,
  indiaTradingDate: string,
): Promise<ExecutionRecord[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(indiaTradingDate)) throw new Error("Trading date must be YYYY-MM-DD");
  const text = await kv.get(partitionKey(broker, indiaTradingDate));
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Ledger partition is corrupt.");
  const checked = parsed.map(validateExecution);
  if (checked.some((x) => !x.valid || !x.record)) throw new Error("Ledger partition contains invalid records.");
  const records = checked.map((x) => x.record as ExecutionRecord);
  if (!recordsMatchPartition(records, partitionKey(broker, indiaTradingDate))) throw new Error("Ledger partition identity mismatch.");
  return records;
}


export interface LedgerKVListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

export interface LedgerKVWithList extends LedgerKV {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<LedgerKVListResult>;
}

/**
 * Read a broker's persisted executions across a date range.
 *
 * This requires a KV implementation with list support (Cloudflare KV has it).
 * It reads only the selected broker's partition prefix, follows every cursor,
 * validates each partition, and never treats missing dates as proof of coverage.
 * Coverage evidence must be evaluated separately before publishing P&L.
 */
export async function readExecutionRange(
  kv: LedgerKVWithList,
  broker: BrokerName,
  startDate: string,
  endDate: string,
): Promise<ExecutionRecord[]> {
  const validDate = (value: string) => {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error("Execution range requires valid YYYY-MM-DD dates with startDate <= endDate.");
  }

  const prefix = PREFIX + encodeURIComponent(broker) + ":";
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.keys)) throw new Error("Ledger KV list returned an invalid response.");
    for (const item of page.keys) {
      if (typeof item?.name === "string") keys.push(item.name);
    }
    if (page.list_complete) break;
    if (!page.cursor || page.cursor === cursor) throw new Error("Ledger KV list pagination did not advance.");
    cursor = page.cursor;
  } while (true);

  const selected = keys
    .map((key) => ({ key, identity: partitionIdentity(key) }))
    .filter((item) => item.identity?.broker === broker
      && validDate(item.identity.date)
      && item.identity.date >= startDate
      && item.identity.date <= endDate)
    .sort((a, b) => (a.identity?.date ?? "").localeCompare(b.identity?.date ?? ""));

  const all: ExecutionRecord[] = [];
  for (const item of selected) {
    const records = await readExecutionPartition(kv, broker, item.identity!.date);
    all.push(...records);
  }
  return all.sort((a, b) => a.executed_at.localeCompare(b.executed_at)
    || a.broker_trade_id.localeCompare(b.broker_trade_id));
}

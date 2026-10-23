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

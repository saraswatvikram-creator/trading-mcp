/**
 * Publication gate for realised-P&L reporting.
 *
 * A broker's current-day tradebook is not evidence of complete historical
 * coverage. This module makes the requested reporting window explicit and
 * blocks publication when coverage, opening inventory, reconciliation, or
 * charge/tax evidence is missing. It does not collect data or calculate P&L.
 */
import type { BrokerName } from "./realised-ledger.ts";

export type CoveragePeriod = {
  startDate: string;
  endDate: string;
};

export interface BrokerCoverageEvidence {
  broker: BrokerName;
  coveredFrom: string | null;
  coveredThrough: string | null;
  sourceVerified: boolean;
  openingInventoryVerified: boolean;
  reconciliationComplete: boolean;
  unmatchedExecutionCount: number;
  conflictCount: number;
  chargesAndTaxesVerified: boolean;
  evidenceNote?: string;
}

export interface BrokerCoverageDecision {
  broker: BrokerName;
  publishGross: boolean;
  publishNet: boolean;
  blockers: string[];
}

const BROKERS: BrokerName[] = ["Zerodha", "AngelOne", "Groww", "5Paisa", "m.Stock"];

function validDate(value: string | null): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z"));
}

export function evaluateBrokerCoverage(
  period: CoveragePeriod,
  evidence: BrokerCoverageEvidence[],
): BrokerCoverageDecision[] {
  if (!validDate(period.startDate) || !validDate(period.endDate) || period.startDate > period.endDate) {
    throw new Error("Coverage period requires valid YYYY-MM-DD startDate/endDate with startDate <= endDate.");
  }

  const byBroker = new Map<BrokerName, BrokerCoverageEvidence>();
  for (const item of evidence) {
    if (byBroker.has(item.broker)) throw new Error(`Duplicate coverage evidence for ${item.broker}.`);
    byBroker.set(item.broker, item);
  }

  return BROKERS.map((broker) => {
    const item = byBroker.get(broker);
    const blockers: string[] = [];
    if (!item) {
      blockers.push("No coverage evidence supplied.");
      return { broker, publishGross: false, publishNet: false, blockers };
    }

    if (!item.sourceVerified) blockers.push("Broker source/response schema is not verified.");
    if (!validDate(item.coveredFrom) || !validDate(item.coveredThrough)) {
      blockers.push("Coverage dates are missing or invalid.");
    } else {
      if (item.coveredFrom > period.startDate) blockers.push("Coverage starts after the requested period begins.");
      if (item.coveredThrough < period.endDate) blockers.push("Coverage ends before the requested period ends.");
    }
    if (!item.openingInventoryVerified) blockers.push("Opening inventory is not verified.");
    if (!item.reconciliationComplete) blockers.push("Execution/position reconciliation is incomplete.");
    if (!Number.isInteger(item.unmatchedExecutionCount) || item.unmatchedExecutionCount < 0) {
      blockers.push("Unmatched execution count is invalid.");
    } else if (item.unmatchedExecutionCount > 0) {
      blockers.push("Unmatched executions remain.");
    }
    if (!Number.isInteger(item.conflictCount) || item.conflictCount < 0) {
      blockers.push("Conflict count is invalid.");
    } else if (item.conflictCount > 0) {
      blockers.push("Conflicting execution identities remain.");
    }

    const grossBlockers = blockers.length > 0;
    const netBlockers = grossBlockers || !item.chargesAndTaxesVerified;
    if (!item.chargesAndTaxesVerified) blockers.push("Charges and taxes are not verified.");
    if (item.evidenceNote) blockers.push("Evidence note: " + item.evidenceNote);

    return {
      broker,
      publishGross: !grossBlockers,
      publishNet: !netBlockers,
      blockers,
    };
  });
}

/** Consolidated output is publishable only if every required broker passes. */
export function canPublishConsolidated(
  decisions: BrokerCoverageDecision[],
  basis: "gross" | "net",
): boolean {
  if (decisions.length !== BROKERS.length) return false;
  const expected = new Set(BROKERS);
  if (decisions.some((d) => !expected.has(d.broker)) || expected.size !== decisions.length) return false;
  return decisions.every((d) => basis === "gross" ? d.publishGross : d.publishNet);
}

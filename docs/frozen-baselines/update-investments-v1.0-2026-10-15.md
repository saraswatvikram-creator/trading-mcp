# Frozen Baseline — Update Investments v1.0

- **Freeze date:** 2026-10-15
- **Baseline branch:** `frozen/update-investments-2026-10-15`
- **Source commit captured:** `9ff950d2d5ddde17d44874e1ea21f93346871e0a`
- **Production endpoint:** `https://trading-mcp.saraswat-vikram.workers.dev`
- **Command/tool:** `update_investments`
- **Preceding command:** `update_auth`
- **Scope:** Five brokers — Zerodha, Angel One, Groww, 5Paisa, and m.Stock. Equity and ETFs represented by equity holdings; Zerodha Coin mutual funds are included.
- **Safety:** Read-only. No order placement, modification, cancellation, conversion, or square-off.

## Freeze policy

This branch is the reference snapshot for the Update Investments report and its associated MCP implementation as of the freeze date. Preserve its report sections, labels, ordering, calculations, broker scope, status conventions, margin reporting, and read-only behavior. Do not change the frozen baseline or its report design unless the user explicitly asks for a revision. Implement any authorized future change as a new revision so this baseline remains available for comparison.

This is a versioned baseline, not a claim that every edge case has been certified. The live run recorded below succeeded for all five brokers.

## Frozen report structure

1. **Title and as-of timestamp** — “Investments Dashboard”, local IST display time.
2. **Live status** — overall data status and connected-broker count.
3. **Portfolio summary cards** — total invested, current value, unrealised P&L, overall return.
4. **Broker-wise investment summary** — broker, invested value, new investments since last update, current value, P&L, return; total row.
5. **Available margin for options** — consolidated total, broker-level available-for-options values, explicit warning if negative or incomplete.
6. **Authentication and data status** — authentication, holdings, and margin status for each of the five brokers.
7. **Completion notes** — baseline persistence, new-investment detection, asset scope, and read-only confirmation.

### Calculation and data rules

- Consolidated investment totals are based on the live holdings returned by each broker.
- P&L = current value minus investment/cost basis; percentage return = P&L divided by investment value.
- “New investments” means change in cost basis since the previous successful five-broker update; market-price/NAV movement is not a new investment.
- Advance the investment baseline only when all five broker holdings calls return valid numeric investment values. On a partial run, keep the previous baseline.
- A broker failure must not block successful brokers; unavailable values must be null/marked unavailable, not silently shown as zero.
- Margin is fetched independently from holdings. Show the consolidated available-for-options total only when all five margin APIs return numeric available amounts. Preserve broker-level values and sources because field definitions differ.
- Negative margin must be called out clearly; do not treat it as a recommendation to trade.
- Keep Investments separate from the F&O Trading Desk and Historical P&L ledger.
- Run `update_auth` first in the daily workflow. The captured run validated all five brokers before calling `update_investments`.

## Captured live report — 2026-10-15 11:17 IST

**Holdings status:** LIVE — 5/5 brokers succeeded  
**Investment baseline:** UPDATED in server-side KV  
**New investment since previous successful update:** ₹0

| Broker | Invested | Current value | P&L | Return |
|---|---:|---:|---:|---:|
| Zerodha | ₹1.060 Cr | ₹1.429 Cr | +₹36.89 L | +34.80% |
| Angel One | ₹1.759 Cr | ₹1.733 Cr | −₹2.59 L | −1.47% |
| Groww | ₹4.90 L | ₹5.04 L | +₹13.82 K | +2.82% |
| 5Paisa | ₹43.65 L | ₹43.44 L | −₹21.21 K | −0.49% |
| m.Stock | ₹4.08 L | ₹3.76 L | −₹31.95 K | −7.84% |
| **TOTAL** | **₹3.345 Cr** | **₹3.684 Cr** | **+₹33.90 L** | **+10.14%** |

### Captured available-for-options margin

| Broker | Available for options |
|---|---:|
| Zerodha | −₹5,25,090 |
| Angel One | −₹4,23,837 |
| Groww | ₹35,301 |
| 5Paisa | ₹1,56,772 |
| m.Stock | ₹1,579 |
| **TOTAL** | **−₹7,55,275** |

**Operational warning:** the reported consolidated available-for-options margin is negative. Verify the broker figures before considering new spreads.

## Associated implementation captured

- `src/server.ts` — registers `update_auth` and `update_investments`; holdings retrieval, baseline persistence, summary calculation, margin retrieval, and response schema.
- `src/auth.ts` — five-broker authentication/readiness workflow and authentication routes.
- `wrangler.jsonc` — Worker entry point and `ZERODHA_TOKEN_STORE` KV binding.
- `README.md` — daily workflow and margin-source documentation.

### Known implementation limitation at freeze

The current `update_investments` response has an overall `status: "LIVE"` literal even when one or more holdings calls fail, and it does not explicitly call `update_auth` internally. Per-broker statuses are generated separately. The successful captured run had all five brokers live, and `update_auth` was invoked immediately beforehand. Do not represent these two edge cases as fixed; any remediation should be a separately authorized revision that preserves this frozen report contract.

## Change control

- Do not overwrite this baseline branch.
- No report-layout or calculation changes without an explicit user request.
- For authorized changes, create a new version/branch and compare its output against this baseline.
- A successful live tool call alone does not prove that ChatGPT's tool catalogue was refreshed or that a new production deployment occurred.

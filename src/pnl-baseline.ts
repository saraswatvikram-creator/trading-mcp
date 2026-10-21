/**
 * User-provided Google Sheets historical P&L snapshot as of 2026-10-20.
 * Values are ₹ lakh. This is an aggregate reporting baseline, not a substitute
 * for transaction-level execution records. Keep its as-of date explicit so
 * subsequent execution-ledger activity can be added only after that cutoff.
 */
export const PNL_SNAPSHOT_AS_OF = "2026-10-20";

export const PNL_YEARLY_BASELINE = [
  { fy: 2020, gross: -0.86, chargesTaxes: -0.16, interest: -0.52, incomeTax: 0, net: -1.54 },
  { fy: 2021, gross: 0.09, chargesTaxes: -0.50, interest: -0.07, incomeTax: 0, net: -0.48 },
  { fy: 2022, gross: 15.01, chargesTaxes: -0.79, interest: -0.08, incomeTax: -3.54, net: 10.61 },
  { fy: 2023, gross: -14.35, chargesTaxes: -0.82, interest: 0.25, incomeTax: 0, net: -14.92 },
  { fy: 2024, gross: 9.24, chargesTaxes: -0.31, interest: -5.07, incomeTax: -0.97, net: 2.90 },
  { fy: 2025, gross: 0.30, chargesTaxes: -4.55, interest: -7.48, incomeTax: 0, net: -11.73 },
  { fy: 2026, gross: 6.60, chargesTaxes: -6.90, interest: -4.86, incomeTax: 0, net: -5.17 },
] as const;

export const PNL_BROKER_BASELINE = {
  Zerodha: [
    { fy: 2020, gross: -0.86, chargesTaxes: -0.16, interest: -0.52, net: -1.54 },
    { fy: 2021, gross: 0.34, chargesTaxes: -0.39, interest: -0.07, net: -0.12 },
    { fy: 2022, gross: 6.09, chargesTaxes: -0.28, interest: -0.08, net: 5.73 },
    { fy: 2023, gross: -1.31, chargesTaxes: -0.17, interest: 0, net: -1.48 },
    { fy: 2024, gross: 9.11, chargesTaxes: -0.19, interest: -3.62, net: 5.30 },
    { fy: 2025, gross: -13.54, chargesTaxes: -2.53, interest: -3.26, net: -19.33 },
    { fy: 2026, gross: 0.19, chargesTaxes: -2.90, interest: -3.43, net: -6.14 },
  ],
  AngelOne: [
    { fy: 2020, gross: 0, chargesTaxes: 0, interest: 0, net: 0 },
    { fy: 2021, gross: 0, chargesTaxes: 0, interest: 0, net: 0 },
    { fy: 2022, gross: 0, chargesTaxes: 0, interest: 0, net: 0 },
    { fy: 2023, gross: -0.07, chargesTaxes: -0.02, interest: 0, net: -0.09 },
    { fy: 2024, gross: -0.35, chargesTaxes: -0.10, interest: -1.45, net: -1.90 },
    { fy: 2025, gross: 14.18, chargesTaxes: -1.81, interest: -4.22, net: 8.15 },
    { fy: 2026, gross: 7.18, chargesTaxes: -2.17, interest: -1.40, net: 3.61 },
  ],
  "5Paisa": [
    { fy: 2020, gross: 0, chargesTaxes: 0, interest: 0, net: 0 },
    { fy: 2021, gross: -0.25, chargesTaxes: -0.11, interest: 0, net: -0.36 },
    { fy: 2022, gross: 8.92, chargesTaxes: -0.51, interest: 0, net: 8.41 },
    { fy: 2023, gross: -12.97, chargesTaxes: -0.63, interest: 0.25, net: -13.35 },
    { fy: 2024, gross: 0.48, chargesTaxes: -0.02, interest: 0, net: 0.46 },
    { fy: 2025, gross: -0.34, chargesTaxes: -0.21, interest: 0, net: -0.55 },
    { fy: 2026, gross: -2.53, chargesTaxes: -1.70, interest: 0, net: -4.23 },
  ],
  Groww: [{ fy: 2026, gross: 1.47, chargesTaxes: -0.11, interest: 0, net: 1.36 }],
  "m.Stock": [{ fy: 2026, gross: 0.29, chargesTaxes: -0.02, interest: -0.03, net: 0.24 }],
} as const;

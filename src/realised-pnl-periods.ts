export interface ReportPeriod {
  label: "Today" | "This Week" | "This Month" | "FY 2026–27";
  startDate: string;
  endDate: string;
}

function indiaDateParts(now: Date): { year: number; month: number; day: number } {
  if (!Number.isFinite(now.getTime())) throw new Error("Reference time must be a valid date.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function dateString(year: number, month: number, day: number): string {
  return String(year).padStart(4, "0") + "-"
    + String(month).padStart(2, "0") + "-"
    + String(day).padStart(2, "0");
}

function shiftDate(date: string, days: number): string {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Resolve report windows using India calendar dates, independent of Worker UTC. */
export function resolveRealisedPnlPeriods(now = new Date()): ReportPeriod[] {
  const { year, month, day } = indiaDateParts(now);
  const today = dateString(year, month, day);
  const weekday = new Date(today + "T00:00:00Z").getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const weekStart = shiftDate(today, mondayOffset);
  const monthStart = dateString(year, month, 1);
  const fyStartYear = month >= 4 ? year : year - 1;
  const fyStart = dateString(fyStartYear, 4, 1);

  return [
    { label: "Today", startDate: today, endDate: today },
    { label: "This Week", startDate: weekStart, endDate: today },
    { label: "This Month", startDate: monthStart, endDate: today },
    { label: "FY 2026–27", startDate: fyStart, endDate: today },
  ];
}

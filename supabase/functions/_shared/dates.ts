// League dates are plain YYYY-MM-DD strings. The "game day" is Central time with a
// 3am rollover so late West Coast games count toward the day they tipped off. This
// deliberately ignores the server's timezone (Proxmox containers usually run UTC).
// Keep in sync with public.current_game_day() in the migrations.

export const LEAGUE_TIMEZONE = "America/Chicago";
export const DAY_ROLLOVER_HOURS = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function gameDay(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - DAY_ROLLOVER_HOURS * 60 * 60 * 1000);
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LEAGUE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of dates from start to end. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

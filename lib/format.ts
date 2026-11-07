// Display helpers shared by server and client components. Times are always shown
// in league (Central) time so server and browser render identical markup.

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatPoints(n: number | null | undefined): string {
  return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export function formatSigned(n: number): string {
  return n > 0 ? `+${formatPoints(n)}` : formatPoints(n);
}

export function withRank(name: string, rank: number | null | undefined): string {
  return rank ? `${name} (${rank})` : name;
}

export function formatTime(iso: string | null | undefined): string {
  return iso ? `${timeFormat.format(new Date(iso))} CT` : '';
}

type StatusFields = {
  game_state: string | null;
  current_period?: string | null;
  contest_clock?: string | null;
  start_time: string | null;
};

export function isLive(game: StatusFields): boolean {
  return game.game_state === 'live';
}

export function isPre(game: StatusFields): boolean {
  return !game.game_state || game.game_state === 'pre';
}

/** "7:00 PM CT", "2nd half 4:12", "Halftime", "OT 1:05", "Final", "Final - OT" */
export function gameStatus(game: StatusFields): string {
  if (isPre(game)) return formatTime(game.start_time) || 'Scheduled';
  const period = (game.current_period ?? '').trim();
  if (game.game_state === 'final') {
    return period ? period.charAt(0) + period.slice(1).toLowerCase() : 'Final';
  }
  const clock = (game.contest_clock ?? '').trim().replace(/^0(\d:)/, '$1'); // "05:13" -> "5:13"
  if (/^half/i.test(period)) return 'Halftime';
  return [periodLabel(period), clock].filter(Boolean).join(' ') || 'Live';
}

const toNumber = (n: number | string | null | undefined) =>
  n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? null : Number(n);

/** "-4.5", "+4.5", or "PK" for a pick'em; "" when there's no spread. */
export function formatSpread(n: number | string | null | undefined): string {
  const v = toNumber(n);
  if (v === null) return '';
  return v === 0 ? 'PK' : v > 0 ? `+${v}` : String(v);
}

/** American moneyline: "+750", "-1200"; "" when missing. */
export function formatMoneyline(n: number | string | null | undefined): string {
  const v = toNumber(n);
  if (v === null) return '';
  return v > 0 ? `+${v}` : String(v);
}

/** One team's line, e.g. "-18.5 (-1800)", or "" if there's none. */
export function formatLine(spread: number | string | null | undefined, moneyline: number | string | null | undefined): string {
  const s = formatSpread(spread);
  const ml = formatMoneyline(moneyline);
  return s && ml ? `${s} (${ml})` : s || ml;
}

/** The API's "1ST" / "2ND" / "OT" / "2OT" as "1st half" / "2nd half" / "OT" / "2OT". */
function periodLabel(period: string): string {
  if (/^[12](st|nd)$/i.test(period)) return `${period.toLowerCase()} half`;
  return period.toUpperCase().includes('OT') ? period.toUpperCase() : period;
}

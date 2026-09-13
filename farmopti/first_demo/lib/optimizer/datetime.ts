/**
 * All timestamps in the original Python pipeline are naive (timezone-less)
 * pandas Timestamps. We represent them here as epoch-millisecond numbers
 * computed purely via Date.UTC, so host timezone / DST never leaks in.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function parseDateOnly(value: string): string {
  return value.trim().slice(0, 10);
}

export function addDays(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return dateOnlyOf(t);
}

export function compareDateOnly(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function dateOnlyToTimestamp(dateOnly: string): number {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function dateOnlyOf(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parses "HH:MM" (or "HH:MM:SS") combined with a "YYYY-MM-DD" date into a UTC timestamp. */
export function combineDateAndTime(dateOnly: string, time: string): number {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const parts = time.trim().split(":").map(Number);
  const [h, min, s] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  return Date.UTC(y, m - 1, d, h, min, s);
}

/** Parses "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS" / "YYYY-MM-DD" as UTC. */
export function parseTimestamp(value: string): number {
  const trimmed = value.trim();
  const [datePart, timePart] = trimmed.includes("T")
    ? trimmed.split("T")
    : trimmed.split(" ");
  return combineDateAndTime(datePart, timePart ?? "00:00:00");
}

export function addHours(ts: number, hours: number): number {
  return ts + hours * MS_PER_HOUR;
}

export function diffHours(a: number, b: number): number {
  return (a - b) / MS_PER_HOUR;
}

export function floorToHour(ts: number): number {
  return Math.floor(ts / MS_PER_HOUR) * MS_PER_HOUR;
}

export function ceilToHour(ts: number): number {
  return Math.ceil(ts / MS_PER_HOUR) * MS_PER_HOUR;
}

export function formatIso(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}:${s}`;
}

export function formatCsvTimestamp(ts: number): string {
  return formatIso(ts).replace("T", " ");
}

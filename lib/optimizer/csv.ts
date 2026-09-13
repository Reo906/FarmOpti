import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export type RawRow = Record<string, string>;

export function readCsv(filePath: string): RawRow[] {
  const text = fs.readFileSync(filePath, "utf-8");
  return parse(text, { columns: true, skip_empty_lines: true }) as RawRow[];
}

/** Writes back a table of raw string rows, preserving column order from the first row. */
export function writeRawCsv(filePath: string, rows: RawRow[]): void {
  if (rows.length === 0) {
    fs.writeFileSync(filePath, "");
    return;
  }
  const header = Object.keys(rows[0]);
  const text = stringify(rows, { header: true, columns: header });
  fs.writeFileSync(filePath, text);
}

export function numOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return Number(value);
}

export function num(value: string | undefined, fallback = 0): number {
  const n = numOrNull(value);
  return n === null ? fallback : n;
}

export function strOrEmpty(value: string | undefined): string {
  return value === undefined || value === null ? "" : value;
}

export function boolFrom01(value: string | undefined): boolean {
  return num(value, 0) === 1;
}

/**
 * Formats a number the way Python's float repr / pandas to_csv does:
 * shortest round-tripping decimal, but integral values keep a trailing ".0".
 */
export function formatPyFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

export function formatPyBool(value: boolean): string {
  return value ? "True" : "False";
}

export interface CsvColumn<T> {
  header: string;
  get: (row: T) => string;
}

export function writeCsv<T>(filePath: string, rows: T[], columns: CsvColumn<T>[]): void {
  const header = columns.map((c) => c.header);
  const records = rows.map((row) => columns.map((c) => c.get(row)));
  const text = stringify([header, ...records]);
  fs.writeFileSync(filePath, text);
}

/** Writes an empty file with just the header, mirroring pandas' empty-DataFrame.to_csv(). */
export function writeEmptyCsv<T>(filePath: string, columns: CsvColumn<T>[]): void {
  const text = stringify([columns.map((c) => c.header)]);
  fs.writeFileSync(filePath, text);
}

import { parse } from "csv-parse/sync";
import type { RawRow } from "./csv";

export const HISTORY_REQUIRED_COLUMNS = [
  "season_id",
  "field_id",
  "timestamp",
  "operation",
  "soil_moisture",
  "nitrogen_index",
  "weed_pressure",
  "pest_pressure",
  "disease_pressure",
  "next_soil_moisture",
  "next_nitrogen_index",
  "next_weed_pressure",
  "next_pest_pressure",
  "next_disease_pressure",
] as const;

export function parseHistoryCsv(text: string): RawRow[] {
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true }) as RawRow[];
}

export function validateHistoryCsv(text: string): { rows: RawRow[]; error?: string } {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { rows: [], error: "history.csv is empty." };

  let rows: RawRow[];
  try {
    rows = parseHistoryCsv(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid CSV";
    return { rows: [], error: `Could not parse history.csv: ${message}` };
  }

  if (rows.length === 0) {
    return { rows: [], error: "history.csv has a header but no data rows." };
  }

  const headers = new Set(Object.keys(rows[0] ?? {}).map((header) => header.trim()));
  const missing = HISTORY_REQUIRED_COLUMNS.filter((column) => !headers.has(column));
  if (missing.length > 0) {
    return { rows: [], error: `history.csv is missing columns: ${missing.join(", ")}` };
  }

  return { rows };
}

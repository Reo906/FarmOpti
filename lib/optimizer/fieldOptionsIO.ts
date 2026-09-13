import fs from "node:fs";
import { readDataFile } from "./bundledData";
import { formatIso, parseTimestamp } from "./datetime";
import { FIELD_OPTIONS_PATH } from "./paths";
import type { FieldOption, OptionAction } from "./types";

function serializeAction(action: OptionAction): Record<string, unknown> {
  return {
    ...action,
    start_time: formatIso(action.start_time),
    end_time: formatIso(action.end_time),
    work_segments: (action.work_segments ?? []).map((segment) => ({
      ...segment,
      start_time: formatIso(segment.start_time),
      end_time: formatIso(segment.end_time),
    })),
  };
}

export function saveFieldOptions(options: FieldOption[], path: string = FIELD_OPTIONS_PATH): void {
  const serializable = {
    options: options.map((option) => ({
      ...option,
      actions: option.actions.map(serializeAction),
    })),
  };
  fs.writeFileSync(path, JSON.stringify(serializable, null, 2));
}

function deserializeAction(raw: any): OptionAction {
  return {
    ...raw,
    start_time: parseTimestamp(raw.start_time),
    end_time: parseTimestamp(raw.end_time),
    workload_hours: Number(raw.workload_hours ?? raw.duration_hours ?? 0),
    work_segments: Array.isArray(raw.work_segments)
      ? raw.work_segments.map((segment: any) => ({
          date: String(segment.date),
          start_time: parseTimestamp(segment.start_time),
          end_time: parseTimestamp(segment.end_time),
          work_hours: Number(segment.work_hours),
        }))
      : [],
    eligible_machine_ids: Array.isArray(raw.eligible_machine_ids)
      ? raw.eligible_machine_ids
      : String(raw.eligible_machine_ids ?? "")
          .split(",")
          .filter(Boolean),
  };
}

export function loadFieldOptions(path: string = FIELD_OPTIONS_PATH): FieldOption[] {
  const raw = JSON.parse(readDataFile(path));
  return raw.options.map((option: any) => ({
    ...option,
    actions: option.actions.map(deserializeAction),
  }));
}

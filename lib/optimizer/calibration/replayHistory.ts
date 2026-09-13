import { readCsv, type RawRow } from "../csv";
import { sprayPressureKey } from "../genericTransitions";
import { applyGenericOperation, type ReplayState } from "./genericReplay";
import type { SupportCounts } from "./types";

function num(value: string | undefined, fallback = 0): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: string | undefined): string {
  return (value ?? "").trim();
}

export function loadHistory(path: string): RawRow[] {
  return readCsv(path);
}

export function rowState(row: RawRow): ReplayState {
  return {
    crop: text(row.crop).toLowerCase(),
    growth_stage: text(row.growth_stage),
    soil_moisture: num(row.soil_moisture),
    nitrogen_index: num(row.nitrogen_index),
    weed_pressure: num(row.weed_pressure),
    pest_pressure: num(row.pest_pressure),
    disease_pressure: num(row.disease_pressure),
    expected_yield_t_ha: 0.0,
    seedbed_readiness: 0.8,
    soil_temperature_c: 16.0,
    planted: Boolean(text(row.crop)),
    harvested: false,
  };
}

/** Groups rows by season_id after sorting by (season_id, timestamp), preserving first-appearance order of each group -- matching pandas' sort_values + groupby(sort=False). */
function groupBySeasonInOrder(rows: RawRow[]): RawRow[][] {
  const sorted = [...rows].sort((a, b) => {
    const seasonCmp = a.season_id < b.season_id ? -1 : a.season_id > b.season_id ? 1 : 0;
    if (seasonCmp !== 0) return seasonCmp;
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
  });

  const order: string[] = [];
  const groups = new Map<string, RawRow[]>();
  for (const row of sorted) {
    if (!groups.has(row.season_id)) {
      groups.set(row.season_id, []);
      order.push(row.season_id);
    }
    groups.get(row.season_id)!.push(row);
  }
  return order.map((id) => groups.get(id)!);
}

export interface ReplayDatasets {
  irrigation: Record<string, string | number>[];
  fertiliser: Record<string, string | number>[];
  spray: Record<string, string | number>[];
  yield: Record<string, string | number>[];
}

export function replayResiduals(history: RawRow[], config: any): ReplayDatasets {
  const irrigation: Record<string, string | number>[] = [];
  const fertiliser: Record<string, string | number>[] = [];
  const spray: Record<string, string | number>[] = [];
  const yieldRows: Record<string, string | number>[] = [];

  for (const season of groupBySeasonInOrder(history)) {
    let replayState: ReplayState | null = null;
    let harvestYield: number | null = null;
    const seasonYieldRows: Record<string, string | number>[] = [];

    for (const row of season) {
      const operation = text(row.operation).toLowerCase();
      const fieldId = text(row.field_id);
      const crop = text(row.crop).toLowerCase() || text(row.next_crop).toLowerCase();
      const before = rowState(row);

      if (replayState === null) {
        replayState = { ...before };
      } else {
        replayState = {
          ...replayState,
          crop: before.crop || replayState.crop || "",
          growth_stage: before.growth_stage || replayState.growth_stage || "",
          soil_moisture: before.soil_moisture,
          nitrogen_index: before.nitrogen_index,
          weed_pressure: before.weed_pressure,
          pest_pressure: before.pest_pressure,
          disease_pressure: before.disease_pressure,
        };
      }

      const genericNext = applyGenericOperation(replayState, operation, row, config);

      if (operation === "irrigate") {
        irrigation.push({
          field_id: fieldId,
          crop,
          growth_stage: before.growth_stage,
          soil_moisture: before.soil_moisture,
          generic_next_soil_moisture: genericNext.soil_moisture,
          residual: num(row.next_soil_moisture) - genericNext.soil_moisture,
        });
      } else if (operation === "fertilise") {
        fertiliser.push({
          field_id: fieldId,
          crop,
          growth_stage: before.growth_stage,
          nitrogen_index: before.nitrogen_index,
          generic_next_nitrogen_index: genericNext.nitrogen_index,
          residual: num(row.next_nitrogen_index) - genericNext.nitrogen_index,
        });
      } else if (operation === "spray") {
        const pressureKey = sprayPressureKey(row.spray_target);
        if (pressureKey) {
          spray.push({
            field_id: fieldId,
            crop,
            growth_stage: before.growth_stage,
            spray_target: text(row.spray_target).toLowerCase().replace("_control", ""),
            current_target_pressure: (before as any)[pressureKey],
            generic_next_target_pressure: (genericNext as any)[pressureKey],
            residual: num(row[`next_${pressureKey}`]) - (genericNext as any)[pressureKey],
          });
        }
      }

      if (operation !== "harvest") {
        seasonYieldRows.push({
          field_id: fieldId,
          crop,
          growth_stage: before.growth_stage || replayState.growth_stage || "",
          soil_moisture: before.soil_moisture,
          nitrogen_index: before.nitrogen_index,
          weed_pressure: before.weed_pressure,
          pest_pressure: before.pest_pressure,
          disease_pressure: before.disease_pressure,
          generic_expected_yield_t_ha: genericNext.expected_yield_t_ha,
        });
      }

      const actual = row.actual_yield_t_ha;
      if (operation === "harvest" && actual !== undefined && actual.trim() !== "") {
        harvestYield = Number(actual);
        const genericAtHarvest = num(String(replayState.expected_yield_t_ha ?? 0));
        seasonYieldRows.push({
          field_id: fieldId,
          crop,
          growth_stage: before.growth_stage,
          soil_moisture: before.soil_moisture,
          nitrogen_index: before.nitrogen_index,
          weed_pressure: before.weed_pressure,
          pest_pressure: before.pest_pressure,
          disease_pressure: before.disease_pressure,
          generic_expected_yield_t_ha: genericAtHarvest,
        });
      }

      replayState = genericNext;
    }

    if (harvestYield !== null) {
      for (const item of seasonYieldRows) {
        item.residual = harvestYield - Number(item.generic_expected_yield_t_ha);
        yieldRows.push(item);
      }
    }
  }

  return { irrigation, fertiliser, spray, yield: yieldRows };
}

export function supportCounts(history: RawRow[]): Record<string, SupportCounts> {
  const mapping: Record<string, string> = { irrigate: "irrigate", fertilise: "fertilise", spray: "spray", harvest: "yield" };
  const counts: Record<string, SupportCounts> = {};

  for (const [source, key] of Object.entries(mapping)) {
    const rows = history.filter((row) => text(row.operation).toLowerCase() === source);
    const byFieldCrop: Record<string, number> = {};
    const byCrop: Record<string, number> = {};

    for (const row of rows) {
      const fieldId = text(row.field_id);
      const crop = text(row.crop).toLowerCase() || text(row.next_crop).toLowerCase();
      const fieldCropKey = `${fieldId}|${crop}`;
      byFieldCrop[fieldCropKey] = (byFieldCrop[fieldCropKey] ?? 0) + 1;
      byCrop[crop] = (byCrop[crop] ?? 0) + 1;
    }

    counts[key] = { all: rows.length, by_crop: byCrop, by_field_crop: byFieldCrop };
  }

  return counts;
}

import assert from "node:assert/strict";
import test from "node:test";
import { validateHistoryCsv } from "./historyCsv.ts";

const HEADER = "season_id,field_id,timestamp,crop,growth_stage,soil_moisture,nitrogen_index,weed_pressure,pest_pressure,disease_pressure,operation,spray_target,next_crop,next_growth_stage,next_soil_moisture,next_nitrogen_index,next_weed_pressure,next_pest_pressure,next_disease_pressure,actual_yield_t_ha";
const ROW = "2024_F1,F1,2024-04-11 07:00,,fallow,0.272,0.295,0.205,0.086,0.108,plant,,wheat,planted,0.272,0.295,0.205,0.086,0.108,";

test("validateHistoryCsv accepts a complete history file", () => {
  const result = validateHistoryCsv(`${HEADER}\n${ROW}\n`);
  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.field_id, "F1");
});

test("validateHistoryCsv rejects a missing required column", () => {
  const result = validateHistoryCsv("season_id,field_id,operation\n2024_F1,F1,plant\n");
  assert.match(result.error ?? "", /missing columns/);
  assert.equal(result.rows.length, 0);
});

test("validateHistoryCsv rejects an empty file", () => {
  const result = validateHistoryCsv("   ");
  assert.equal(result.error, "history.csv is empty.");
});

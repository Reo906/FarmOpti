import fs from "node:fs";
import path from "node:path";
import { trainGradientBoosting } from "./gradientBoostingTrain";
import { predictResidual } from "./predict";
import type { RawRow } from "../csv";
import type { FarmCalibrationMetadata, GradientBoostingModel, SupportCounts } from "./types";
import type { ReplayDatasets } from "./replayHistory";

export const MIN_SAMPLES = 5;

interface ModelSpec {
  filename: string;
  categorical: string[];
  numeric: string[];
}

export const MODEL_SPECS: Record<string, ModelSpec> = {
  irrigation: {
    filename: "irrigation_model",
    categorical: ["field_id", "crop", "growth_stage"],
    numeric: ["soil_moisture", "generic_next_soil_moisture"],
  },
  fertiliser: {
    filename: "fertiliser_model",
    categorical: ["field_id", "crop", "growth_stage"],
    numeric: ["nitrogen_index", "generic_next_nitrogen_index"],
  },
  spray: {
    filename: "spray_model",
    categorical: ["field_id", "crop", "growth_stage", "spray_target"],
    numeric: ["current_target_pressure", "generic_next_target_pressure"],
  },
  yield: {
    filename: "yield_model",
    categorical: ["field_id", "crop", "growth_stage"],
    numeric: ["soil_moisture", "nitrogen_index", "weed_pressure", "pest_pressure", "disease_pressure", "generic_expected_yield_t_ha"],
  },
};

export interface FitStats {
  samples: number;
  generic_mae: number;
  generic_bias: number;
  calibrated_mae: number;
  mae_improvement: number;
  mean_correction: number;
}

export function evaluateFit(
  model: GradientBoostingModel | null,
  rows: Record<string, string | number>[],
  spec: ModelSpec,
): FitStats | null {
  if (rows.length === 0) return null;

  const residuals = rows.map((row) => Number(row.residual));
  const genericMae = residuals.reduce((s, v) => s + Math.abs(v), 0) / residuals.length;
  const genericBias = residuals.reduce((s, v) => s + v, 0) / residuals.length;

  if (model === null) {
    return { samples: rows.length, generic_mae: genericMae, generic_bias: genericBias, calibrated_mae: genericMae, mae_improvement: 0, mean_correction: 0 };
  }

  const predicted = rows.map((row) => predictResidual(model, row));
  const calibratedErrors = residuals.map((residual, i) => residual - predicted[i]);
  const calibratedMae = calibratedErrors.reduce((s, v) => s + Math.abs(v), 0) / calibratedErrors.length;
  const meanCorrection = predicted.reduce((s, v) => s + v, 0) / predicted.length;
  const improvement = genericMae === 0 ? 0 : (genericMae - calibratedMae) / genericMae;

  return {
    samples: rows.length,
    generic_mae: genericMae,
    generic_bias: genericBias,
    calibrated_mae: calibratedMae,
    mae_improvement: improvement,
    mean_correction: meanCorrection,
  };
}

export function trainResidualModel(
  rows: Record<string, string | number>[],
  spec: ModelSpec,
  minSamples: number = MIN_SAMPLES,
): GradientBoostingModel | null {
  if (rows.length < minSamples) return null;
  const y = rows.map((row) => Number(row.residual));
  return trainGradientBoosting(rows, spec.categorical, spec.numeric, y);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((v) => v !== "").sort();
}

export function saveFarmCalibration(
  outputDir: string,
  farmId: string,
  history: RawRow[],
  datasets: ReplayDatasets,
  support: Record<string, SupportCounts>,
  confidenceK: number,
  minSamples: number = MIN_SAMPLES,
): FarmCalibrationMetadata {
  fs.mkdirSync(outputDir, { recursive: true });

  const trained: Record<string, GradientBoostingModel | null> = {};
  const fit: Record<string, FitStats> = {};
  const featureNames: Record<string, string[]> = {};

  const seasonIds = new Set(history.map((row) => row.season_id));
  const sampleCounts = {
    irrigation: datasets.irrigation.length,
    fertiliser: datasets.fertiliser.length,
    spray: datasets.spray.length,
    yield_rows: datasets.yield.length,
    yield_seasons: seasonIds.size,
  };

  for (const [name, spec] of Object.entries(MODEL_SPECS)) {
    const rows = datasets[name as keyof ReplayDatasets];
    const model = trainResidualModel(rows, spec, minSamples);
    trained[name] = model;
    featureNames[name] = [...spec.categorical, ...spec.numeric];

    const stats = evaluateFit(model, rows, spec);
    if (stats !== null) fit[name] = stats;
    if (model === null) continue;

    fs.writeFileSync(path.join(outputDir, `${spec.filename}.json`), JSON.stringify(model, null, 2));
  }

  const fields = uniqueSorted(history.map((row) => row.field_id ?? ""));
  const crops = uniqueSorted([...history.map((row) => (row.crop ?? "").toLowerCase()), ...history.map((row) => (row.next_crop ?? "").toLowerCase())]);

  const metadata: FarmCalibrationMetadata = {
    farm_id: farmId,
    training_rows: history.length,
    fields,
    crops,
    model_version: 1,
    trained_at: new Date().toISOString(),
    samples: sampleCounts,
    support,
    feature_names: featureNames,
    confidence_k: confidenceK,
    trained_models: Object.entries(trained).filter(([, model]) => model !== null).map(([name]) => name),
    skipped_models: Object.entries(trained).filter(([, model]) => model === null).map(([name]) => name),
    fit,
  };

  fs.writeFileSync(path.join(outputDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  return metadata;
}

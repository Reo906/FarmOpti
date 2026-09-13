import fs from "node:fs";
import path from "node:path";
import { OPTIMIZER_ROOT } from "../paths";
import type { FarmCalibration, FarmCalibrationMetadata, ResidualPredictor } from "./types";

let cached: { key: string; value: FarmCalibration | null } | null = null;

export function farmCalibrationConfig(config: any): {
  enabled: boolean;
  modelDir: string;
  confidenceK: number;
} {
  const raw = config?.simulator?.farm_calibration ?? {};
  const modelDir = String(raw.model_dir ?? "data/farm_history");
  return {
    enabled: raw.enabled === true,
    modelDir: path.isAbsolute(modelDir) ? modelDir : path.resolve(OPTIMIZER_ROOT, "..", modelDir),
    confidenceK: Number(raw.confidence_k ?? 5),
  };
}

function readPredictor(modelDir: string, filename: string): ResidualPredictor | null {
  const filePath = path.join(modelDir, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ResidualPredictor;
}

export function loadFarmCalibrationFromDir(modelDir: string): FarmCalibration | null {
  const metadataPath = path.join(modelDir, "metadata.json");
  if (!fs.existsSync(metadataPath)) return null;
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as FarmCalibrationMetadata;
  return {
    metadata,
    irrigation: readPredictor(modelDir, "irrigation_model.json"),
    fertiliser: readPredictor(modelDir, "fertiliser_model.json"),
    spray: readPredictor(modelDir, "spray_model.json"),
    yield: readPredictor(modelDir, "yield_model.json"),
  };
}

export function loadFarmCalibration(config: any): FarmCalibration | null {
  const settings = farmCalibrationConfig(config);
  if (!settings.enabled) return null;
  const key = settings.modelDir;
  if (cached && cached.key === key) return cached.value;
  try {
    const value = loadFarmCalibrationFromDir(settings.modelDir);
    cached = { key, value };
    return value;
  } catch {
    cached = { key, value: null };
    return null;
  }
}

export function resetFarmCalibrationCache(): void {
  cached = null;
}
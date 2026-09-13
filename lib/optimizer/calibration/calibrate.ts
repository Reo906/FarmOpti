import { loadConfig } from "../config";
import { CONFIG_PATH } from "../paths";
import { farmCalibrationConfig, resetFarmCalibrationCache } from "./load";
import { loadHistory, replayResiduals, supportCounts } from "./replayHistory";
import { saveFarmCalibration } from "./trainModels";
import type { FarmCalibrationMetadata } from "./types";

export interface CalibrateFromHistoryOptions {
  historyPath: string;
  farmId: string;
  outputDir: string;
  configPath?: string;
  confidenceK?: number;
  minSamples?: number;
}

export function calibrateFromHistory(options: CalibrateFromHistoryOptions): FarmCalibrationMetadata {
  const history = loadHistory(options.historyPath);
  const config = loadConfig(options.configPath ?? CONFIG_PATH);
  const settings = farmCalibrationConfig(config);
  const minSamples = options.minSamples ?? Number(config?.simulator?.farm_calibration?.min_training_samples ?? 5);
  const metadata = saveFarmCalibration(
    options.outputDir,
    options.farmId,
    history,
    replayResiduals(history, config),
    supportCounts(history),
    options.confidenceK ?? settings.confidenceK,
    minSamples,
  );
  resetFarmCalibrationCache();
  return metadata;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calibrateFromHistory } from "./calibration/calibrate";
import { farmCalibrationConfig } from "./calibration/load";
import type { FarmCalibrationMetadata } from "./calibration/types";
import { loadConfig } from "./config";
import { validateHistoryCsv } from "./historyCsv";
import { FARM_HISTORY_DIR, HISTORY_PATH, SCHEDULE_PATH, SUMMARY_PATH } from "./paths";
import { runPipeline } from "./pipeline";
import type { OptimizationSummary } from "./types";

export interface TrainAndOptimizeResult {
  calibration: FarmCalibrationMetadata;
  summary: OptimizationSummary;
  scheduleCsv: string;
}

export async function trainAndOptimize(
  historyCsv: string,
  options: { farmId?: string } = {},
): Promise<TrainAndOptimizeResult> {
  const { error } = validateHistoryCsv(historyCsv);
  if (error) throw new Error(error);

  fs.mkdirSync(FARM_HISTORY_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_PATH, historyCsv.endsWith("\n") ? historyCsv : `${historyCsv}\n`);

  const config = loadConfig();
  const settings = farmCalibrationConfig(config);
  const calibration = calibrateFromHistory({
    historyPath: HISTORY_PATH,
    farmId: options.farmId ?? "demo_farm",
    outputDir: settings.modelDir,
    confidenceK: settings.confidenceK,
    minSamples: Number(config?.simulator?.farm_calibration?.min_training_samples ?? 5),
  });

  await runPipeline();

  return {
    calibration,
    summary: JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf-8")) as OptimizationSummary,
    scheduleCsv: fs.readFileSync(SCHEDULE_PATH, "utf-8"),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const csv = fs.readFileSync(process.argv[2] ?? HISTORY_PATH, "utf-8");
  const farmId = process.argv[3];
  trainAndOptimize(csv, farmId ? { farmId } : {})
    .then((result) => {
      console.log(`Trained ${result.calibration.training_rows} historical events`);
      console.log(`Scheduled ${result.summary.num_scheduled_actions} actions`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

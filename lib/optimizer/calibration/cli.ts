import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";
import { loadHistory, replayResiduals, supportCounts } from "./replayHistory";
import { saveFarmCalibration, type FitStats } from "./trainModels";
import type { FarmCalibrationMetadata } from "./types";

interface Args {
  history: string;
  farmId: string;
  output: string;
  config: string;
  confidenceK: number;
  minSamples: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const history = get("--history");
  const farmId = get("--farm-id");
  const output = get("--output");
  if (!history) throw new Error("--history is required");
  if (!farmId) throw new Error("--farm-id is required");
  if (!output) throw new Error("--output is required");

  return {
    history,
    farmId,
    output,
    config: get("--config") ?? "data/config.yaml",
    confidenceK: Number(get("--confidence-k") ?? 5.0),
    minSamples: Number(get("--min-samples") ?? 5),
  };
}

const LABELS: Record<string, string> = {
  irrigation: "Irrigation (soil moisture)",
  fertiliser: "Fertiliser (nitrogen index)",
  spray: "Spray (target pressure)",
  yield: "Yield (t/ha)",
};

function printFitReport(fit: Record<string, FitStats>): void {
  if (Object.keys(fit).length === 0) return;

  console.log("\nHow much the generic simulator differed from history");
  console.log("  (MAE = mean |actual - generic|; calibrated applies the learned residual)");

  for (const [name, stats] of Object.entries(fit)) {
    const label = LABELS[name] ?? name;
    const sign = stats.generic_bias >= 0 ? "+" : "";
    const improvement = stats.mae_improvement * 100;
    console.log(`\n  ${label}  n=${stats.samples}`);
    console.log(`    generic MAE:     ${stats.generic_mae.toFixed(4)}`);
    console.log(`    calibrated MAE:  ${stats.calibrated_mae.toFixed(4)}  (${improvement.toFixed(0)}% lower error)`);
    console.log(`    mean residual:   ${sign}${stats.generic_bias.toFixed(4)}   (actual - generic)`);
    console.log(`    mean correction: ${stats.mean_correction >= 0 ? "+" : ""}${stats.mean_correction.toFixed(4)}`);
  }
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);

  const history = loadHistory(args.history);
  const config = loadConfig(args.config);
  const datasets = replayResiduals(history, config);
  const support = supportCounts(history);
  const metadata: FarmCalibrationMetadata = saveFarmCalibration(
    args.output,
    args.farmId,
    history,
    datasets,
    support,
    args.confidenceK,
    args.minSamples,
  );

  console.log(`Loaded ${metadata.training_rows} historical events`);
  console.log(`Irrigation samples: ${metadata.samples.irrigation}`);
  console.log(`Fertiliser samples: ${metadata.samples.fertiliser}`);
  console.log(`Spray samples: ${metadata.samples.spray}`);
  console.log(`Yield seasons: ${metadata.samples.yield_seasons}`);
  printFitReport(metadata.fit as Record<string, FitStats>);
  if (metadata.skipped_models.length > 0) {
    console.log(`Skipped models with insufficient samples: ${metadata.skipped_models.join(", ")}`);
  }
  console.log(`\nSaved farm calibration to ${args.output}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}

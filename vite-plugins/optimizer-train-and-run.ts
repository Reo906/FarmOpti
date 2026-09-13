import { spawn } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const TRAIN_PATH = "/api/optimizer/train-and-run";
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;
const HISTORY_REQUIRED_COLUMNS = [
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
];

function historyCsvError(text: string): string | null {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return "history.csv is empty.";
  const header = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const columns = new Set(header.split(",").map((column) => column.trim()));
  const missing = HISTORY_REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) return `history.csv is missing columns: ${missing.join(", ")}`;
  if (!trimmed.includes("\n")) return "history.csv has a header but no data rows.";
  return null;
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Uploaded history.csv is larger than 5 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function runTrainAndOptimize(root: string, historyPath: string, farmId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
    const script = path.join(root, "lib/optimizer/trainAndOptimize.ts");
    const child = spawn(process.execPath, [tsxCli, script, historyPath, farmId], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error((stderr || stdout || `Training process exited with code ${code}`).trim()));
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readBody(req, MAX_HISTORY_BYTES);
    let historyCsv = raw;
    let farmId = "demo_farm";
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType.includes("application/json")) {
      const body = JSON.parse(raw) as { historyCsv?: unknown; farmId?: unknown };
      if (typeof body.historyCsv !== "string") {
        sendJson(res, 400, { error: "Send history.csv as { historyCsv: string }." });
        return;
      }
      historyCsv = body.historyCsv;
      if (typeof body.farmId === "string" && body.farmId.trim()) farmId = body.farmId.trim();
    } else if (!historyCsv.trim()) {
      sendJson(res, 400, { error: "Upload a history.csv file." });
      return;
    }

    const root = projectRoot();
    const error = historyCsvError(historyCsv);
    if (error) {
      sendJson(res, 400, { error });
      return;
    }

    const historyPath = path.join(root, "data/farm_history/history.csv");
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, historyCsv.endsWith("\n") ? historyCsv : `${historyCsv}\n`);

    await runTrainAndOptimize(root, historyPath, farmId);

    const summary = JSON.parse(fs.readFileSync(path.join(root, "data/outputs/optimization_summary.json"), "utf-8"));
    const scheduleCsv = fs.readFileSync(path.join(root, "data/outputs/optimal_schedule.csv"), "utf-8");
    const calibration = JSON.parse(fs.readFileSync(path.join(root, "data/farm_history/metadata.json"), "utf-8"));
    const changeSummaryPath = path.join(root, "data/outputs/plan_change_summary.json");
    const changeSummary = fs.existsSync(changeSummaryPath) ? JSON.parse(fs.readFileSync(changeSummaryPath, "utf-8")) : null;
    sendJson(res, 200, { farmId, calibration, summary, scheduleCsv, changeSummary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Training and optimisation failed.";
    sendJson(res, 500, { error: message });
  }
}

export function optimizerTrainAndRunPlugin(): Plugin {
  return {
    name: "optimizer-train-and-run",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (req.method !== "POST" || url !== TRAIN_PATH) {
          next();
          return;
        }
        void handle(req, res);
      });
    },
  };
}

import fs from "node:fs";
import http from "node:http";
import { ExplanationService } from "./chatbot/explanationService";
import { RULES } from "./config";
import { loadExternalVariables } from "./externalVariables";
import { loadRules } from "./rules/store";
import { PLAN_CHANGE_SUMMARY_PATH, SCHEDULE_PATH } from "./paths";
import type { ConfigChangeProposal } from "./chatbot/configUpdate/parser";

/**
 * A tiny local sidecar for the one thing the web UI's API route (which runs
 * inside a Cloudflare Workers sandbox, even under `vinext dev`) fundamentally
 * cannot do itself: persist a confirmed config/machine change to real files
 * and re-run the HiGHS-based pipeline. Workers have no persistent local
 * filesystem at all -- in dev or in a real deployment -- so that part of the
 * work has to happen in a real Node process. This server IS that process;
 * app/api/chat/route.ts proxies "Yes, apply it" confirmations to it over
 * plain HTTP, which Workers can do freely (only local fs/WASM access is
 * restricted, not outgoing fetch).
 *
 * Run alongside `npm run dev`: `npm run optimizer:server`.
 */

const PORT = Number(process.env.OPTIMIZER_SERVER_PORT ?? 4790);

let service: ExplanationService | undefined;
function getService(): ExplanationService {
  service ??= new ExplanationService();
  return service;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/rules") {
      const data = loadExternalVariables();
      sendJson(response, 200, {
        rules: loadRules(),
        fields: data.fields.map((f) => f.field_id),
        machines: data.machines.map((m) => ({ id: m.machine_id, type: m.machine_type })),
        operations: Object.keys(RULES),
      });
      return;
    }

    // Polled by the frontend after a confirm-config-update response: that
    // response returns immediately with the fast, deterministic plan-change
    // summary, while the nicer LLM-phrased version (~10s on a local model)
    // keeps generating in the background and overwrites this file when
    // ready. Polling here is how the UI picks up that upgrade.
    if (request.method === "GET" && request.url === "/plan-change-summary") {
      if (!fs.existsSync(PLAN_CHANGE_SUMMARY_PATH)) {
        sendJson(response, 404, { error: "No plan change summary yet. Run the optimizer pipeline first." });
        return;
      }
      sendJson(response, 200, JSON.parse(fs.readFileSync(PLAN_CHANGE_SUMMARY_PATH, "utf-8")));
      return;
    }

    if (request.method === "POST" && request.url === "/confirm-config-update") {
      const raw = await readBody(request);
      const { proposal } = JSON.parse(raw) as { proposal?: ConfigChangeProposal };
      if (!proposal || typeof proposal !== "object") {
        sendJson(response, 400, { error: "Missing proposal in request body." });
        return;
      }

      const outcome = await getService().confirmConfigUpdate(proposal);
      sendJson(response, 200, {
        answer: outcome.answer,
        applied: true,
        summary: outcome.after,
        scheduleCsv: fs.readFileSync(SCHEDULE_PATH, "utf-8"),
        changeSummary: outcome.changeSummary,
      });
      return;
    }

    sendJson(response, 404, { error: "Not found. GET /rules, GET /plan-change-summary, POST /confirm-config-update" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: `Could not apply that change: ${message}` });
  }
});

server.listen(PORT, () => {
  console.log(`[optimizer:server] Listening on http://localhost:${PORT} (GET /rules, GET /plan-change-summary, POST /confirm-config-update)`);
});

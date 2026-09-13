import assert from "node:assert/strict";
import test from "node:test";
import { loadExternalVariables } from "./externalVariables.ts";
import { packWorkload, remainingAfterSegments, requiredWorkloadHours } from "./workload.ts";
import { EXTERNAL_DIR } from "./paths.ts";

test("required workload is area divided by effective machine capacity", () => {
  assert.equal(requiredWorkloadHours(20, 5), 4);
  assert.equal(requiredWorkloadHours(48, 5), 9.6);
});

test("remaining workload tracks cumulative completion", () => {
  const remaining = remainingAfterSegments(20, [
    { date: "2026-09-17", start_time: 0, end_time: 8 * 3_600_000, work_hours: 8 },
    { date: "2026-09-18", start_time: 0, end_time: 0, work_hours: 0 },
    { date: "2026-09-19", start_time: 0, end_time: 8 * 3_600_000, work_hours: 8 },
    { date: "2026-09-20", start_time: 0, end_time: 4 * 3_600_000, work_hours: 4 },
  ]);
  assert.deepEqual(remaining, [12, 12, 4, 0]);
});

test("packing can split a workload across more than one day", () => {
  const data = loadExternalVariables(EXTERNAL_DIR);
  const start = Date.UTC(2026, 8, 14, 7);
  const segments = packWorkload(data, "harvest", "harvester", 20, start, "2026-09-20");
  assert.ok(segments);
  assert.ok(segments.length >= 2);
  const total = segments.reduce((sum, segment) => sum + segment.work_hours, 0);
  assert.ok(Math.abs(total - 20) < 1e-6);
  assert.equal(new Set(segments.map((segment) => segment.date)).size, segments.filter((s) => s.work_hours > 0).length);
});

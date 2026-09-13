import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConstraintStore } from "./constraintStore.ts";

const FAKE_SCENARIO_A = {
  mode: "scenario",
  description: "Do not spray F2",
  changes: [{ target: "action", where: { field_id: { op: "eq", value: "F2" } }, constraints: { selected: { op: "eq", value: false } } }],
};

const FAKE_SCENARIO_B = {
  mode: "scenario",
  description: "Harvest F1 by Sep 25",
  changes: [{ target: "action", where: { field_id: { op: "eq", value: "F1" } }, constraints: { date: { op: "lte", value: "2024-09-25" } } }],
};

function fakeEval(scenario: typeof FAKE_SCENARIO_A) {
  return {
    scenario,
    resolvedChanges: [{ resolved: true }],
    comparison: { objective_change_aud: -1000 },
    summary: { total: 1 },
    schedule: [{ plan_id: "p1" }],
  };
}

test("propose returns a pending_confirmation proposal", () => {
  const store = new ConstraintStore();
  const proposal = store.propose("sess-1", "Do not spray F2", fakeEval(FAKE_SCENARIO_A));
  assert.equal(proposal.status, "pending_confirmation");
  assert.equal(proposal.sessionId, "sess-1");
  assert.equal(proposal.scenario.changes.length, 1);
});

test("confirm moves proposal to confirmed and updates active scenario", () => {
  const store = new ConstraintStore();
  store.propose("sess-1", "Do not spray F2", fakeEval(FAKE_SCENARIO_A));
  const confirmed = store.confirm("sess-1");
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.confirmedAt);
  assert.equal(store.getPending("sess-1"), undefined);
  const active = store.activeScenario();
  assert.ok(active);
  assert.equal(active.changes.length, 1);
});

test("reject removes proposal without adding to confirmed", () => {
  const store = new ConstraintStore();
  store.propose("sess-1", "Do not spray F2", fakeEval(FAKE_SCENARIO_A));
  store.reject("sess-1");
  assert.equal(store.getPending("sess-1"), undefined);
  assert.equal(store.activeScenario(), null);
});

test("multi-rule: two confirmed rules do not duplicate changes", () => {
  const store = new ConstraintStore();

  // Confirm rule A
  store.propose("sess-1", "Do not spray F2", fakeEval(FAKE_SCENARIO_A));
  store.confirm("sess-1");

  // Confirm rule B
  store.propose("sess-2", "Harvest F1 by Sep 25", fakeEval(FAKE_SCENARIO_B));
  store.confirm("sess-2");

  const confirmed = store.getConfirmed();
  assert.equal(confirmed.length, 2);

  // Each stored proposal's scenario has exactly 1 change (not merged with prior rules).
  assert.equal(confirmed[0].scenario.changes.length, 1);
  assert.equal(confirmed[1].scenario.changes.length, 1);

  // The active scenario overlay has exactly 2 changes total.
  const active = store.activeScenario();
  assert.ok(active);
  assert.equal(active.changes.length, 2);
});

test("persistence: confirmed rules survive a reload", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-store-test-"));
  const storePath = path.join(tmpDir, "constraints.json");

  try {
    const store1 = new ConstraintStore(storePath);
    store1.propose("sess-1", "Do not spray F2", fakeEval(FAKE_SCENARIO_A));
    store1.confirm("sess-1");

    const store2 = new ConstraintStore(storePath);
    const confirmed = store2.getConfirmed();
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].sourceText, "Do not spray F2");
    assert.equal(store2.activeScenario()?.changes.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("propose throws when scenario has no changes", () => {
  const store = new ConstraintStore();
  assert.throws(
    () => store.propose("sess-1", "empty", { scenario: { mode: "scenario", changes: [] } }),
    /validated constraint change/,
  );
});

import highsLoader, { type Highs } from "highs";
import { CONFIG } from "./config";
import { loadExternalVariables } from "./externalVariables";
import { addDays, dateOnlyOf } from "./datetime";
import { pyRound } from "./numeric";
import { EXTERNAL_DIR } from "./paths";
import { buildOptionMetrics } from "./planMetrics";
import type {
  AlternativeObjective,
  FieldOption,
  FieldRow,
  OptimizationScenario,
  OptimizationSummary,
  OptimizationVariant,
  OptionAction,
  ScheduleRow,
} from "./types";
import {
  actionDayCapacity,
  actionDayWindow,
  configWorkdayBounds,
  enumerateDates,
  labourWorkdayBounds,
  machineCapacityOnDay,
  remainingAfterSegments,
} from "./workload";

export { loadFieldOptions } from "./fieldOptionsIO";

function fieldDistanceKm(fields: Map<string, FieldRow>, a: string, b: string): number {
  if (a === b) return 0.0;
  const rowA = fields.get(a)!;
  const rowB = fields.get(b)!;
  const dx = rowA.x_km - rowB.x_km;
  const dy = rowA.y_km - rowB.y_km;
  return Math.sqrt(dx * dx + dy * dy);
}

interface FlatAction {
  option: FieldOption;
  action: OptionAction;
  actionKey: string;
  eligibleMachineIds: string[];
  workloadHours: number;
  earliestDate: string;
  latestDate: string;
  dates: string[];
}

function optionContainsPlan(option: FieldOption, planId: string): boolean {
  return option.actions.some((a) => String(a.plan_id) === planId);
}

function optionContainsCandidate(option: FieldOption, candidateId: string): boolean {
  return option.actions.some((a) => String(a.candidate_id) === candidateId);
}

function addCoef(varMap: Map<string, Map<string, number>>, varKey: string, conKey: string, delta: number): void {
  let coeffs = varMap.get(varKey);
  if (!coeffs) {
    coeffs = new Map();
    varMap.set(varKey, coeffs);
  }
  coeffs.set(conKey, (coeffs.get(conKey) ?? 0) + delta);
}

let highsPromise: Promise<Highs> | null = null;
function getHighs(): Promise<Highs> {
  if (!highsPromise) highsPromise = highsLoader();
  return highsPromise;
}

function sanitizeLpName(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_");
}

function fmtLpNumber(n: number): string {
  if (Object.is(n, -0)) n = 0;
  const s = String(n);
  if (!s.includes("e") && !s.includes("E")) return s;
  return n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

interface LpBuild {
  text: string;
  varNames: string[];
}

function buildLpText(
  varCoeffs: Map<string, Map<string, number>>,
  constraintBounds: Map<string, { equal?: number; max?: number; min?: number }>,
  objectiveKey: string,
  lpOptions: { sense?: "max" | "min"; continuousVars?: Set<string> } = {},
): LpBuild {
  const sense = lpOptions.sense ?? "max";
  const continuousVars = lpOptions.continuousVars ?? new Set<string>();
  const varNames = [...varCoeffs.keys()];
  const lpName = new Map(varNames.map((v) => [v, sanitizeLpName(v)]));

  const rowTerms = new Map<string, { varName: string; coeff: number }[]>();
  const objectiveTerms: { varName: string; coeff: number }[] = [];

  for (const [varKey, coeffs] of varCoeffs) {
    for (const [conKey, coeff] of coeffs) {
      if (coeff === 0) continue;
      if (conKey === objectiveKey) {
        objectiveTerms.push({ varName: lpName.get(varKey)!, coeff });
        continue;
      }
      const list = rowTerms.get(conKey) ?? [];
      list.push({ varName: lpName.get(varKey)!, coeff });
      rowTerms.set(conKey, list);
    }
  }

  const termsToText = (terms: { varName: string; coeff: number }[]) =>
    terms.map((t) => `${t.coeff >= 0 ? "+" : "-"}${fmtLpNumber(Math.abs(t.coeff))} ${t.varName}`).join(" ");

  const lines: string[] = [];
  lines.push(sense === "min" ? "Minimize" : "Maximize");
  lines.push(` obj: ${objectiveTerms.length > 0 ? termsToText(objectiveTerms) : "0 " + (varNames[0] ? lpName.get(varNames[0]) : "x")}`);
  lines.push("Subject To");

  for (const [conKey, bound] of constraintBounds) {
    const terms = rowTerms.get(conKey);
    if (!terms || terms.length === 0) continue;

    const rowName = sanitizeLpName(`row_${conKey}`);
    const body = termsToText(terms);

    if (bound.equal !== undefined) {
      lines.push(` ${rowName}: ${body} = ${fmtLpNumber(bound.equal)}`);
    } else if (bound.max !== undefined) {
      lines.push(` ${rowName}: ${body} <= ${fmtLpNumber(bound.max)}`);
    } else if (bound.min !== undefined) {
      lines.push(` ${rowName}: ${body} >= ${fmtLpNumber(bound.min)}`);
    }
  }

  const binaryVars = varNames.filter((name) => !continuousVars.has(name));
  const contVars = varNames.filter((name) => continuousVars.has(name));

  if (contVars.length > 0) {
    lines.push("Bounds");
    for (const name of contVars) {
      lines.push(` ${lpName.get(name)} >= 0`);
    }
  }

  lines.push("Binary");
  for (let i = 0; i < binaryVars.length; i += 20) {
    lines.push(" " + binaryVars.slice(i, i + 20).map((v) => lpName.get(v)).join(" "));
  }
  lines.push("End");

  return { text: lines.join("\n"), varNames };
}

function objectiveSense(mode: AlternativeObjective): "max" | "min" {
  return mode === "value" || mode === "lateness" ? "max" : "min";
}

export async function optimizeSchedule(
  options: FieldOption[],
  externalVariablesDir: string = EXTERNAL_DIR,
  scenario: OptimizationScenario = {},
  maxSolverSeconds?: number,
  variant: OptimizationVariant = {},
): Promise<{ schedule: ScheduleRow[]; summary: OptimizationSummary }> {
  const forbidPlanIds = new Set((scenario.forbid_plan_ids ?? []).map(String));
  const forcePlanIds = new Set((scenario.force_plan_ids ?? []).map(String));
  const forceCandidateIds = new Map(
    Object.entries(scenario.force_candidate_ids ?? {}).map(([k, v]) => [String(k), String(v)]),
  );

  const data = loadExternalVariables(externalVariablesDir);
  const fields = new Map(data.fields.map((f) => [f.field_id, f]));
  const optionMetrics = buildOptionMetrics(options, data);
  const objectiveMode: AlternativeObjective = variant.objective ?? "value";
  const labourCapacityFactor = variant.labourCapacityFactor ?? 1;
  const continuousVars = new Set<string>();
  const labourDays: { date: string; workdayHours: number; actions: FlatAction[] }[] = [];

  const optionsByField = new Map<string, FieldOption[]>();
  for (const option of options) {
    const list = optionsByField.get(String(option.field_id)) ?? [];
    list.push(option);
    optionsByField.set(String(option.field_id), list);
  }

  const varCoeffs = new Map<string, Map<string, number>>();
  const constraintBounds = new Map<string, { equal?: number; max?: number; min?: number }>();

  const optionVarKey = (optionId: string) => `opt:${optionId}`;
  const assignVarKey = (actionKey: string, machineId: string) => `assign:${actionKey}:${machineId}`;
  const workVarKey = (actionKey: string, machineId: string, date: string) => `work:${actionKey}:${machineId}:${date}`;
  const activeVarKey = (actionKey: string, machineId: string, date: string) => `active:${actionKey}:${machineId}:${date}`;
  const completeVarKey = (actionKey: string, date: string) => `complete:${actionKey}:${date}`;
  const planById = new Map(data.management.map((plan) => [String(plan.plan_id), plan]));

  const actionWorkload = (action: OptionAction): number => {
    const marked = Number(action.workload_hours ?? action.duration_hours ?? 0);
    if (marked > 0) return marked;
    return Math.max(0, (action.end_time - action.start_time) / 3_600_000);
  };

  const dayCapCache = new Map<string, number>();
  const dayCapacity = (operation: string, date: string, machineIds: string[], notBefore?: number): number => {
    const key = `${operation}|${date}|${machineIds.join(",")}|${notBefore ?? ""}`;
    const cached = dayCapCache.get(key);
    if (cached !== undefined) return cached;
    const value = actionDayCapacity(data, operation, date, machineIds, notBefore);
    dayCapCache.set(key, value);
    return value;
  };

  const zeroForced = new Set<string>();

  for (const [fieldId, fieldOptions] of optionsByField) {
    const fieldConstraint = `field:${fieldId}`;
    constraintBounds.set(fieldConstraint, { equal: 1 });

    for (const option of fieldOptions) {
      const varKey = optionVarKey(option.option_id);
      addCoef(varCoeffs, varKey, fieldConstraint, 1);

      if ([...forbidPlanIds].some((pid) => optionContainsPlan(option, pid))) {
        zeroForced.add(option.option_id);
      }

      for (const pid of forcePlanIds) {
        const fieldHasPlan = fieldOptions.some((o) => optionContainsPlan(o, pid));
        if (fieldHasPlan && !optionContainsPlan(option, pid)) zeroForced.add(option.option_id);
      }

      for (const [pid, candidateId] of forceCandidateIds) {
        const fieldHasPlan = fieldOptions.some((o) => optionContainsPlan(o, pid));
        if (fieldHasPlan && !optionContainsCandidate(option, candidateId)) zeroForced.add(option.option_id);
      }
    }
  }

  for (const optionId of zeroForced) {
    const conKey = `zero:${optionId}`;
    constraintBounds.set(conKey, { equal: 0 });
    addCoef(varCoeffs, optionVarKey(optionId), conKey, 1);
  }

  const flatActions: FlatAction[] = [];

  for (const option of options) {
    const varKey = optionVarKey(option.option_id);

    option.actions.forEach((action, index) => {
      const actionKey = `${option.option_id}__A${String(index).padStart(2, "0")}`;
      const eligible = Array.isArray(action.eligible_machine_ids)
        ? action.eligible_machine_ids
        : String(action.eligible_machine_ids ?? "")
            .split(",")
            .filter(Boolean);
      const plan = planById.get(String(action.plan_id));
      const earliestDate = dateOnlyOf(action.start_time);
      const latestDate = plan?.allowed_to ?? dateOnlyOf(action.end_time);
      const dates = enumerateDates(earliestDate, latestDate);
      const workloadHours = actionWorkload(action);

      flatActions.push({
        option,
        action,
        actionKey,
        eligibleMachineIds: eligible,
        workloadHours,
        earliestDate,
        latestDate,
        dates,
      });

      const linkConstraint = `link:${actionKey}`;
      constraintBounds.set(linkConstraint, { equal: 0 });
      addCoef(varCoeffs, varKey, linkConstraint, -1);

      for (const machineId of eligible) {
        addCoef(varCoeffs, assignVarKey(actionKey, machineId), linkConstraint, 1);
      }

      const workTotal = `worktotal:${actionKey}`;
      constraintBounds.set(workTotal, { equal: 0 });
      addCoef(varCoeffs, varKey, workTotal, -workloadHours);

      for (const date of dates) {
        const notBefore = date === earliestDate ? action.start_time : undefined;
        const dayCap = dayCapacity(action.operation, date, eligible, notBefore);
        if (dayCap <= 1e-9) continue;

        for (const machineId of eligible) {
          const machineCap = machineCapacityOnDay(data, machineId, date);
          const cap = Math.min(dayCap, machineCap);
          if (cap <= 1e-9) continue;

          const wKey = workVarKey(actionKey, machineId, date);
          continuousVars.add(wKey);
          addCoef(varCoeffs, wKey, workTotal, 1);

          const boundKey = `wcap:${actionKey}:${machineId}:${date}`;
          constraintBounds.set(boundKey, { max: 0 });
          addCoef(varCoeffs, wKey, boundKey, 1);
          addCoef(varCoeffs, assignVarKey(actionKey, machineId), boundKey, -cap);
        }
      }
    });
  }

  const actionsByMachine = new Map<string, FlatAction[]>();
  for (const flat of flatActions) {
    for (const machineId of flat.eligibleMachineIds) {
      const list = actionsByMachine.get(machineId) ?? [];
      list.push(flat);
      actionsByMachine.set(machineId, list);
    }
  }

  const allDates = [...new Set(flatActions.flatMap((flat) => flat.dates))].sort();

  for (const [machineId, machineActions] of actionsByMachine) {
    for (const date of allDates) {
      const contributors: { flat: FlatAction; wKey: string; cap: number }[] = [];
      for (const flat of machineActions) {
        if (!flat.dates.includes(date)) continue;
        const wKey = workVarKey(flat.actionKey, machineId, date);
        if (!varCoeffs.has(wKey)) continue;
        const notBefore = date === flat.earliestDate ? flat.action.start_time : undefined;
        const cap = Math.min(
          dayCapacity(flat.action.operation, date, flat.eligibleMachineIds, notBefore),
          machineCapacityOnDay(data, machineId, date),
        );
        if (cap <= 1e-9) continue;
        contributors.push({ flat, wKey, cap });
      }
      if (contributors.length === 0) continue;

      const machineCap = machineCapacityOnDay(data, machineId, date);
      const capKey = `mcap:${machineId}:${date}`;
      constraintBounds.set(capKey, { max: machineCap });
      for (const contributor of contributors) {
        addCoef(varCoeffs, contributor.wKey, capKey, 1);
      }

      if (!CONFIG.transport?.enforce_travel_time) continue;

      const speed = Number(CONFIG.transport.machine_speed_kmh);
      let travelIndex = 0;
      for (let i = 0; i < contributors.length; i++) {
        for (let j = i + 1; j < contributors.length; j++) {
          const a = contributors[i];
          const b = contributors[j];
          if (a.flat.action.field_id === b.flat.action.field_id) continue;
          if (a.flat.option.option_id === b.flat.option.option_id && a.flat.action.field_id === b.flat.action.field_id) {
            continue;
          }

          const travelHours = fieldDistanceKm(fields, a.flat.action.field_id, b.flat.action.field_id) / speed;
          const uA = activeVarKey(a.flat.actionKey, machineId, date);
          const uB = activeVarKey(b.flat.actionKey, machineId, date);

          const linkA = `ulink:${a.flat.actionKey}:${machineId}:${date}`;
          if (!constraintBounds.has(linkA)) {
            constraintBounds.set(linkA, { max: 0 });
            addCoef(varCoeffs, a.wKey, linkA, 1);
            addCoef(varCoeffs, uA, linkA, -a.cap);
          }
          const linkB = `ulink:${b.flat.actionKey}:${machineId}:${date}`;
          if (!constraintBounds.has(linkB)) {
            constraintBounds.set(linkB, { max: 0 });
            addCoef(varCoeffs, b.wKey, linkB, 1);
            addCoef(varCoeffs, uB, linkB, -b.cap);
          }

          const travelKey = `travel:${machineId}:${date}:${travelIndex++}`;
          constraintBounds.set(travelKey, { max: machineCap + travelHours });
          addCoef(varCoeffs, a.wKey, travelKey, 1);
          addCoef(varCoeffs, b.wKey, travelKey, 1);
          addCoef(varCoeffs, uA, travelKey, travelHours);
          addCoef(varCoeffs, uB, travelKey, travelHours);
        }
      }
    }
  }

  for (const date of allDates) {
    const labourRow = data.labour.find((l) => l.date === date);
    const labourWindow = labourWorkdayBounds(data, date);
    const configWindow = configWorkdayBounds(date);
    const window = labourWindow && configWindow
      ? {
          start: Math.max(labourWindow.start, configWindow.start),
          end: Math.min(labourWindow.end, configWindow.end),
        }
      : null;
    const workdayHours = window && window.start < window.end ? (window.end - window.start) / 3_600_000 : 0;
    const workerHours = (labourRow?.available_workers ?? 0) * labourCapacityFactor * workdayHours;
    const dayActions = flatActions.filter((flat) => flat.dates.includes(date));
    labourDays.push({ date, workdayHours, actions: dayActions });

    const conKey = `labour:${date}`;
    constraintBounds.set(conKey, { max: workerHours });
    for (const flat of dayActions) {
      for (const machineId of flat.eligibleMachineIds) {
        const wKey = workVarKey(flat.actionKey, machineId, date);
        if (!varCoeffs.has(wKey)) continue;
        addCoef(varCoeffs, wKey, conKey, flat.action.workers_required);
      }
    }
  }

  for (const waterRow of data.water) {
    const conKey = `water:${waterRow.date}`;
    const capacity = Math.min(waterRow.available_water_ml, waterRow.max_delivery_ml_per_day);
    let used = false;
    for (const flat of flatActions) {
      const water = flat.action.water_ml ?? 0;
      if (water <= 0 || !flat.dates.includes(waterRow.date) || flat.workloadHours <= 1e-9) continue;
      used = true;
      const rate = water / flat.workloadHours;
      for (const machineId of flat.eligibleMachineIds) {
        const wKey = workVarKey(flat.actionKey, machineId, waterRow.date);
        if (!varCoeffs.has(wKey)) continue;
        addCoef(varCoeffs, wKey, conKey, rate);
      }
    }
    if (used) constraintBounds.set(conKey, { max: capacity });
  }

  const byOption = new Map<string, FlatAction[]>();
  for (const flat of flatActions) {
    const list = byOption.get(flat.option.option_id) ?? [];
    list.push(flat);
    byOption.set(flat.option.option_id, list);
  }

  const precedences: { pred: FlatAction; succ: FlatAction; gapHours: number }[] = [];
  for (const group of byOption.values()) {
    const ordered = [...group].sort((a, b) => a.action.start_time - b.action.start_time);
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const pred = ordered[i];
        const succ = ordered[j];
        if (pred.action.field_id !== succ.action.field_id) continue;
        const explicit = String(succ.action.depends_on ?? "") === String(pred.action.plan_id);
        const gapHours = explicit ? (succ.action.min_gap_hours ?? 0) : 0;
        precedences.push({ pred, succ, gapHours });
      }
    }
  }

  const predecessors = new Set(precedences.map((pair) => pair.pred));
  for (const pred of predecessors) {
    const eps = 1e-3;
    for (const [index, date] of pred.dates.entries()) {
      const completeKey = completeVarKey(pred.actionKey, date);
      const finished = `fin:${pred.actionKey}:${date}`;
      constraintBounds.set(finished, { max: 0 });
      addCoef(varCoeffs, completeKey, finished, pred.workloadHours);

      const notLate = `notlate:${pred.actionKey}:${date}`;
      constraintBounds.set(notLate, { max: pred.workloadHours });
      addCoef(varCoeffs, optionVarKey(pred.option.option_id), notLate, eps);
      addCoef(varCoeffs, completeKey, notLate, -eps);

      const linked = `cx:${pred.actionKey}:${date}`;
      constraintBounds.set(linked, { max: 0 });
      addCoef(varCoeffs, completeKey, linked, 1);
      addCoef(varCoeffs, optionVarKey(pred.option.option_id), linked, -1);

      for (const earlier of pred.dates.slice(0, index + 1)) {
        for (const machineId of pred.eligibleMachineIds) {
          const wKey = workVarKey(pred.actionKey, machineId, earlier);
          if (!varCoeffs.has(wKey)) continue;
          addCoef(varCoeffs, wKey, finished, -1);
          addCoef(varCoeffs, wKey, notLate, 1);
        }
      }

      if (index + 1 < pred.dates.length) {
        const mono = `mono:${pred.actionKey}:${date}`;
        constraintBounds.set(mono, { max: 0 });
        addCoef(varCoeffs, completeKey, mono, 1);
        addCoef(varCoeffs, completeVarKey(pred.actionKey, pred.dates[index + 1]), mono, -1);
      }
    }
  }

  let precIndex = 0;
  for (const { pred, succ, gapHours } of precedences) {
    for (const date of succ.dates) {
      const predDate = gapHours > 0 ? addDays(date, -1) : date;
      const completeKey = pred.dates.includes(predDate)
        ? completeVarKey(pred.actionKey, predDate)
        : pred.dates.filter((d) => d < predDate).at(-1)
          ? completeVarKey(pred.actionKey, pred.dates.filter((d) => d < predDate).at(-1)!)
          : null;

      for (const machineId of succ.eligibleMachineIds) {
        const wKey = workVarKey(succ.actionKey, machineId, date);
        if (!varCoeffs.has(wKey)) continue;
        const notBefore = date === succ.earliestDate ? succ.action.start_time : undefined;
        const cap = dayCapacity(succ.action.operation, date, succ.eligibleMachineIds, notBefore);
        const conKey = `prec:${precIndex++}`;
        constraintBounds.set(conKey, { max: 0 });
        addCoef(varCoeffs, wKey, conKey, 1);
        if (completeKey) addCoef(varCoeffs, completeKey, conKey, -cap);
      }
    }
  }

  if (variant.minObjectiveValue != null) {
    constraintBounds.set("min_value", { min: variant.minObjectiveValue });
    for (const option of options) {
      addCoef(varCoeffs, optionVarKey(option.option_id), "min_value", option.objective_value_aud);
    }
  }

  for (const [index, optionSet] of (variant.forbidOptionSets ?? []).entries()) {
    const ids = optionSet.filter((id) => options.some((option) => option.option_id === id));
    if (ids.length === 0) continue;
    const conKey = `nogood:${index}`;
    constraintBounds.set(conKey, { max: ids.length - 1 });
    for (const optionId of ids) {
      addCoef(varCoeffs, optionVarKey(optionId), conKey, 1);
    }
  }

  const objectiveKey = "objective";
  if (objectiveMode === "smoothness") {
    continuousVars.add("peak_labour");
    addCoef(varCoeffs, "peak_labour", objectiveKey, 1);
    for (const { date, workdayHours, actions } of labourDays) {
      if (workdayHours <= 1e-9) continue;
      const peakCon = `peak:${date}`;
      constraintBounds.set(peakCon, { max: 0 });
      for (const flat of actions) {
        for (const machineId of flat.eligibleMachineIds) {
          const wKey = workVarKey(flat.actionKey, machineId, date);
          if (!varCoeffs.has(wKey)) continue;
          addCoef(varCoeffs, wKey, peakCon, flat.action.workers_required);
        }
      }
      addCoef(varCoeffs, "peak_labour", peakCon, -workdayHours);
    }
  } else {
    for (const option of options) {
      const metrics = optionMetrics.get(option.option_id);
      let coeff = option.objective_value_aud;
      if (objectiveMode === "cost") coeff = metrics?.cost_aud ?? 0;
      else if (objectiveMode === "risk") coeff = metrics?.risk_score ?? 0;
      else if (objectiveMode === "earliness" || objectiveMode === "lateness") coeff = metrics?.start_hours ?? 0;
      addCoef(varCoeffs, optionVarKey(option.option_id), objectiveKey, coeff);
    }
  }

  const { text: lpText } = buildLpText(varCoeffs, constraintBounds, objectiveKey, {
    sense: objectiveSense(objectiveMode),
    continuousVars,
  });

  const timeoutSeconds = maxSolverSeconds ?? Number(CONFIG.global_optimization.max_solver_seconds);
  const highs = await getHighs();
  const solution = highs.solve(lpText, {
    output_flag: false,
    time_limit: timeoutSeconds,
  });

  if (process.env.DEBUG_SOLVER) {
    console.error("[solver]", objectiveMode, solution.Status, solution.ObjectiveValue);
  }

  const isOptimal = solution.Status === "Optimal";
  const isTimeLimited = solution.Status === "Time limit reached" && Number.isFinite(solution.ObjectiveValue);

  if (!isOptimal && !isTimeLimited) {
    throw new Error("No feasible whole-farm schedule found");
  }

  const primalOf = (varKey: string): number => {
    const column = solution.Columns[sanitizeLpName(varKey)];
    return column?.Primal ?? 0;
  };

  const selectedVars = new Set<string>();
  for (const varKey of varCoeffs.keys()) {
    if (continuousVars.has(varKey)) continue;
    if (primalOf(varKey) > 0.5) selectedVars.add(varKey);
  }

  const selectedOptionIds = new Set(
    options.filter((o) => selectedVars.has(optionVarKey(o.option_id))).map((o) => o.option_id),
  );

  const selectedFlats = flatActions.filter((flat) => selectedOptionIds.has(flat.option.option_id));
  const workByMachineDay = new Map<string, { flat: FlatAction; machineId: string; date: string; hours: number }[]>();

  for (const flat of selectedFlats) {
    let assignedMachine = flat.eligibleMachineIds.find((id) => selectedVars.has(assignVarKey(flat.actionKey, id))) ?? "";
    for (const date of flat.dates) {
      for (const machineId of flat.eligibleMachineIds) {
        const hours = primalOf(workVarKey(flat.actionKey, machineId, date));
        if (hours <= 1e-4) continue;
        if (!assignedMachine) assignedMachine = machineId;
        const key = `${machineId}|${date}`;
        const list = workByMachineDay.get(key) ?? [];
        list.push({ flat, machineId, date, hours });
        workByMachineDay.set(key, list);
      }
    }
  }

  const placed = new Map<string, { start: number; end: number; hours: number; machineId: string; date: string }[]>();

  for (const [key, group] of workByMachineDay) {
    const [machineId, date] = key.split("|");
    const window = actionDayWindow(
      data,
      date,
      [machineId],
    );
    if (!window) continue;

    const speed = Number(CONFIG.transport?.machine_speed_kmh ?? 20);
    const ordered = [...group].sort((a, b) => {
      if (a.flat.action.start_time !== b.flat.action.start_time) return a.flat.action.start_time - b.flat.action.start_time;
      return a.flat.actionKey.localeCompare(b.flat.actionKey);
    });

    let cursor = window.start;
    let previousField: string | null = null;
    for (const item of ordered) {
      if (previousField && previousField !== item.flat.action.field_id && CONFIG.transport?.enforce_travel_time) {
        cursor += (fieldDistanceKm(fields, previousField, item.flat.action.field_id) / speed) * 3_600_000;
      }
      if (item.date === item.flat.earliestDate) {
        cursor = Math.max(cursor, item.flat.action.start_time);
      }
      const start = cursor;
      const end = start + item.hours * 3_600_000;
      const list = placed.get(item.flat.actionKey) ?? [];
      list.push({ start, end, hours: item.hours, machineId, date });
      placed.set(item.flat.actionKey, list);
      cursor = end;
      previousField = item.flat.action.field_id;
    }
  }

  const rows: ScheduleRow[] = [];

  for (const flat of selectedFlats) {
    const segments = (placed.get(flat.actionKey) ?? []).sort((a, b) => a.start - b.start);
    if (segments.length === 0) {
      rows.push({
        option_id: flat.option.option_id,
        candidate_id: flat.action.candidate_id,
        plan_id: flat.action.plan_id,
        field_id: flat.action.field_id,
        operation: flat.action.operation,
        target: flat.action.target,
        start_time: flat.action.start_time,
        end_time: flat.action.end_time,
        machine_id: flat.eligibleMachineIds.find((id) => selectedVars.has(assignVarKey(flat.actionKey, id))) ?? "",
        workers_required: flat.action.workers_required,
        water_ml: flat.action.water_ml ?? 0.0,
        direct_revenue_aud: flat.action.direct_revenue_aud,
        direct_cost_aud: flat.action.direct_cost_aud,
        direct_cash_effect_aud: flat.action.direct_cash_effect_aud,
        state_yield_effect_t_ha: flat.action.state_yield_effect_t_ha,
        work_hours: pyRound(flat.workloadHours, 4),
        workload_hours: pyRound(flat.workloadHours, 4),
        remaining_workload_hours: 0,
        completion_time: flat.action.end_time,
      });
      continue;
    }

    const remainings = remainingAfterSegments(flat.workloadHours, segments.map((s) => ({
      date: s.date,
      start_time: s.start,
      end_time: s.end,
      work_hours: s.hours,
    })));
    const completion = segments[segments.length - 1].end;
    const firstStart = segments[0].start;

    segments.forEach((segment, index) => {
      const isFirst = index === 0;
      const water = (flat.action.water_ml ?? 0) * (segment.hours / Math.max(flat.workloadHours, 1e-9));
      rows.push({
        option_id: flat.option.option_id,
        candidate_id: flat.action.candidate_id,
        plan_id: flat.action.plan_id,
        field_id: flat.action.field_id,
        operation: flat.action.operation,
        target: flat.action.target,
        start_time: segment.start,
        end_time: segment.end,
        machine_id: segment.machineId,
        workers_required: flat.action.workers_required,
        water_ml: pyRound(water, 3),
        direct_revenue_aud: isFirst ? flat.action.direct_revenue_aud : 0,
        direct_cost_aud: isFirst ? flat.action.direct_cost_aud : 0,
        direct_cash_effect_aud: isFirst ? flat.action.direct_cash_effect_aud : 0,
        state_yield_effect_t_ha: isFirst ? flat.action.state_yield_effect_t_ha : 0,
        work_hours: pyRound(segment.hours, 4),
        workload_hours: pyRound(flat.workloadHours, 4),
        remaining_workload_hours: pyRound(remainings[index], 4),
        completion_time: completion,
      });
    });
  }

  rows.sort((a, b) => a.start_time - b.start_time || a.plan_id.localeCompare(b.plan_id));

  const selectedOptionObjects = options.filter((o) => selectedOptionIds.has(o.option_id));
  const selectedOptionSummary = selectedOptionObjects.map((o) => ({
    option_id: o.option_id,
    field_id: o.field_id,
    direct_cash_effect_aud: pyRound(o.total_direct_cash_effect_aud, 2),
    terminal_value_aud: pyRound(o.terminal_value_aud, 2),
    objective_value_aud: pyRound(o.objective_value_aud, 2),
  }));

  const summary: OptimizationSummary = {
    status: isOptimal ? "optimal" : "feasible",
    total_direct_cash_effect_aud: pyRound(
      selectedOptionSummary.reduce((s, x) => s + x.direct_cash_effect_aud, 0),
      2,
    ),
    total_terminal_value_aud: pyRound(
      selectedOptionSummary.reduce((s, x) => s + x.terminal_value_aud, 0),
      2,
    ),
    total_objective_value_aud: pyRound(
      selectedOptionSummary.reduce((s, x) => s + x.objective_value_aud, 0),
      2,
    ),
    num_scheduled_actions: selectedFlats.length,
    selected_options: selectedOptionSummary,
  };

  return { schedule: rows, summary };
}

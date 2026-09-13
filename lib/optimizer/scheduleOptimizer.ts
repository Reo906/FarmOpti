import highsLoader, { type Highs } from "highs";
import { CANDIDATE_CONFIG, CONFIG } from "./config";
import { loadExternalVariables } from "./externalVariables";
import { ceilToHour, dateOnlyOf, floorToHour, combineDateAndTime } from "./datetime";
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
}

function machinePairIncompatible(fields: Map<string, FieldRow>, a: FlatAction, b: FlatAction): boolean {
  const startA = a.action.start_time;
  const endA = a.action.end_time;
  const startB = b.action.start_time;
  const endB = b.action.end_time;

  if (startA < endB && startB < endA) return true;

  if (!CONFIG.transport?.enforce_travel_time) return false;

  let earlier: FlatAction, later: FlatAction, gapHours: number;
  if (endA <= startB) {
    earlier = a;
    later = b;
    gapHours = (startB - endA) / 3_600_000;
  } else if (endB <= startA) {
    earlier = b;
    later = a;
    gapHours = (startA - endB) / 3_600_000;
  } else {
    return true;
  }

  const speed = Number(CONFIG.transport.machine_speed_kmh);
  const distance = fieldDistanceKm(fields, earlier.action.field_id, later.action.field_id);
  return gapHours + 1e-9 < distance / speed;
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
  const labourSlots: { t: number; active: FlatAction[] }[] = [];

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

      flatActions.push({ option, action, actionKey, eligibleMachineIds: eligible });

      const linkConstraint = `link:${actionKey}`;
      constraintBounds.set(linkConstraint, { equal: 0 });
      addCoef(varCoeffs, varKey, linkConstraint, -1);

      for (const machineId of eligible) {
        addCoef(varCoeffs, assignVarKey(actionKey, machineId), linkConstraint, 1);
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

  let conflictIndex = 0;
  for (const [machineId, machineActions] of actionsByMachine) {
    for (let i = 0; i < machineActions.length; i++) {
      for (let j = i + 1; j < machineActions.length; j++) {
        const a = machineActions[i];
        const b = machineActions[j];

        if (a.option.option_id === b.option.option_id && a.action.field_id === b.action.field_id) continue;

        if (machinePairIncompatible(fields, a, b)) {
          const conKey = `conflict:${machineId}:${conflictIndex++}`;
          constraintBounds.set(conKey, { max: 1 });
          addCoef(varCoeffs, assignVarKey(a.actionKey, machineId), conKey, 1);
          addCoef(varCoeffs, assignVarKey(b.actionKey, machineId), conKey, 1);
        }
      }
    }
  }

  if (flatActions.length > 0) {
    const timeStepMs = Number(CANDIDATE_CONFIG.time_step_hours) * 3_600_000;
    const horizonStart = floorToHour(Math.min(...flatActions.map((f) => f.action.start_time)));
    const horizonEnd = ceilToHour(Math.max(...flatActions.map((f) => f.action.end_time)));

    for (let t = horizonStart; t < horizonEnd; t += timeStepMs) {
      const date = dateOnlyOf(t);
      const labourRow = data.labour.find((l) => l.date === date);
      let capacity = 0;

      if (labourRow) {
        const start = combineDateAndTime(date, labourRow.workday_start);
        const end = combineDateAndTime(date, labourRow.workday_end);
        if (start <= t && t < end) capacity = labourRow.available_workers * labourCapacityFactor;
      }

      const active = flatActions.filter((f) => f.action.start_time <= t && t < f.action.end_time);
      if (active.length > 0) {
        labourSlots.push({ t, active });
        const conKey = `labour:${t}`;
        constraintBounds.set(conKey, { max: capacity });
        for (const flat of active) {
          addCoef(varCoeffs, optionVarKey(flat.option.option_id), conKey, flat.action.workers_required);
        }
      }
    }
  }

  for (const waterRow of data.water) {
    const activeForDate = flatActions.filter(
      (f) => dateOnlyOf(f.action.start_time) === waterRow.date && (f.action.water_ml ?? 0) > 0,
    );
    if (activeForDate.length === 0) continue;

    const conKey = `water:${waterRow.date}`;
    const capacity = Math.min(waterRow.available_water_ml, waterRow.max_delivery_ml_per_day);
    constraintBounds.set(conKey, { max: capacity });

    for (const flat of activeForDate) {
      addCoef(varCoeffs, optionVarKey(flat.option.option_id), conKey, flat.action.water_ml);
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
    for (const { t, active } of labourSlots) {
      const peakCon = `peak:${t}`;
      constraintBounds.set(peakCon, { max: 0 });
      for (const flat of active) {
        addCoef(varCoeffs, optionVarKey(flat.option.option_id), peakCon, flat.action.workers_required);
      }
      addCoef(varCoeffs, "peak_labour", peakCon, -1);
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

  const selectedVars = new Set<string>();
  for (const varKey of varCoeffs.keys()) {
    const column = solution.Columns[sanitizeLpName(varKey)];
    if (column && column.Primal > 0.5) selectedVars.add(varKey);
  }

  const selectedOptionIds = new Set(
    options.filter((o) => selectedVars.has(optionVarKey(o.option_id))).map((o) => o.option_id),
  );

  const rows: ScheduleRow[] = [];

  for (const flat of flatActions) {
    if (!selectedOptionIds.has(flat.option.option_id)) continue;

    let assignedMachine = "";
    for (const machineId of flat.eligibleMachineIds) {
      if (selectedVars.has(assignVarKey(flat.actionKey, machineId))) {
        assignedMachine = machineId;
        break;
      }
    }

    rows.push({
      option_id: flat.option.option_id,
      candidate_id: flat.action.candidate_id,
      plan_id: flat.action.plan_id,
      field_id: flat.action.field_id,
      operation: flat.action.operation,
      target: flat.action.target,
      start_time: flat.action.start_time,
      end_time: flat.action.end_time,
      machine_id: assignedMachine,
      workers_required: flat.action.workers_required,
      water_ml: flat.action.water_ml ?? 0.0,
      direct_revenue_aud: flat.action.direct_revenue_aud,
      direct_cost_aud: flat.action.direct_cost_aud,
      direct_cash_effect_aud: flat.action.direct_cash_effect_aud,
      state_yield_effect_t_ha: flat.action.state_yield_effect_t_ha,
    });
  }

  rows.sort((a, b) => a.start_time - b.start_time);

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
    num_scheduled_actions: rows.length,
    selected_options: selectedOptionSummary,
  };

  return { schedule: rows, summary };
}

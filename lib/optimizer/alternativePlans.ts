import fs from "node:fs";
import { CONFIG } from "./config";
import { compareSchedules } from "./decisionAnalysis/analyseCounterfactuals";
import { formatIso } from "./datetime";
import { loadExternalVariables } from "./externalVariables";
import { writeScheduleCsv } from "./csvWriters";
import { pyRound } from "./numeric";
import { ALTERNATIVE_PLANS_PATH, EXTERNAL_DIR, schedulePath } from "./paths";
import {
  computeScheduleMetrics,
  formatPercentDelta,
  isNearDuplicateOfAny,
  percentChange,
  selectedOptionIds,
} from "./planMetrics";
import { optimizeSchedule } from "./scheduleOptimizer";
import type {
  AlternativeObjective,
  AlternativePlan,
  AlternativePlansResult,
  FieldOption,
  OptimizationVariant,
  ScheduleRow,
} from "./types";

interface Theme {
  plan_id: string;
  label: string;
  objective: AlternativeObjective;
  labourCapacityFactor?: number;
}

const THEMES: Theme[] = [
  { plan_id: "value", label: "Maximum farm value", objective: "value" },
  { plan_id: "low_cost", label: "Lower input cost", objective: "cost" },
  { plan_id: "low_risk", label: "Lower operational risk", objective: "risk" },
  { plan_id: "smoother", label: "Smoother workload", objective: "smoothness" },
  { plan_id: "earlier", label: "Earlier operations", objective: "earliness" },
  { plan_id: "later", label: "Later operations", objective: "lateness" },
];

export function alternativePlanConfig() {
  const raw = CONFIG.alternative_plans ?? {};
  return {
    enabled: raw.enabled !== false,
    minOptimalityRatio: Number(raw.min_optimality_ratio ?? 0.95),
    planCount: Number(raw.plan_count ?? raw.min_plans ?? raw.max_plans ?? 4),
    maxJaccardSimilarity: Number(raw.max_jaccard_similarity ?? 0.8),
    minFieldOptionChanges: Number(raw.min_field_option_changes ?? 2),
    maxSolverSeconds:
      raw.max_solver_seconds != null
        ? Number(raw.max_solver_seconds)
        : Number(CONFIG.global_optimization.max_solver_seconds),
  };
}

function optionSet(schedule: ScheduleRow[]): string[] {
  return selectedOptionIds(schedule);
}

function describeStructure(baseline: ScheduleRow[], schedule: ScheduleRow[]): string {
  const changes = compareSchedules(baseline, schedule);
  const added = changes.filter((change) => change.change === "added").length;
  const removed = changes.filter((change) => change.change === "removed").length;
  const moved = changes.filter((change) => change.change === "rescheduled").length;
  const parts: string[] = [];
  if (added) parts.push(`adds ${added} operation${added === 1 ? "" : "s"}`);
  if (removed) parts.push(`drops ${removed} operation${removed === 1 ? "" : "s"}`);
  if (moved) parts.push(`reschedules ${moved}`);
  return parts.length > 0 ? parts.join(", ") : "uses a different mix of field options";
}

export function buildPlanReason(
  theme: Pick<Theme, "plan_id">,
  plan: AlternativePlan,
  baseline: AlternativePlan,
): string {
  const valuePct = Math.round(plan.optimality_ratio * 100);
  const structure = describeStructure(baseline.schedule, plan.schedule);
  const costDelta = formatPercentDelta(percentChange(baseline.metrics.total_cost_aud, plan.metrics.total_cost_aud));
  const riskDelta = formatPercentDelta(percentChange(baseline.metrics.risk_score, plan.metrics.risk_score));
  const peakDelta = formatPercentDelta(percentChange(baseline.metrics.peak_labour, plan.metrics.peak_labour));

  switch (theme.plan_id) {
    case "value":
      return "Best whole-farm cash + crop value under current constraints.";
    case "low_cost":
      return `Lower cost/resource usage: input cost ${costDelta} versus the optimum, at ${valuePct}% of optimal value; ${structure}.`;
    case "low_risk":
      return `Lower operational risk: risk score ${riskDelta} versus the optimum, at ${valuePct}% of optimal value; ${structure}.`;
    case "smoother":
      return `Smoother machinery/workload demand: peak labour ${peakDelta} versus the optimum, at ${valuePct}% of optimal value; ${structure}.`;
    case "earlier":
      return `Earlier operations where feasible, keeping ${valuePct}% of optimal value; ${structure}.`;
    case "later":
      return `Later operations where feasible, keeping ${valuePct}% of optimal value; ${structure}.`;
    default:
      return `Another near-optimal schedule at ${valuePct}% of optimal value; ${structure}.`;
  }
}

function toPlan(
  theme: Theme,
  schedule: ScheduleRow[],
  summary: AlternativePlan["summary"],
  options: FieldOption[],
  externalVariablesDir: string,
  zStar: number,
): AlternativePlan {
  const data = loadExternalVariables(externalVariablesDir);
  const metrics = computeScheduleMetrics(schedule, options, data);
  return {
    plan_id: theme.plan_id,
    label: theme.label,
    reason: "",
    objective_value_aud: summary.total_objective_value_aud,
    optimality_ratio: pyRound(zStar === 0 ? 1 : summary.total_objective_value_aud / zStar, 4),
    selected_option_ids: optionSet(schedule),
    schedule,
    summary,
    metrics,
  };
}

async function solveTheme(
  options: FieldOption[],
  externalVariablesDir: string,
  maxSolverSeconds: number | undefined,
  variant: OptimizationVariant,
): Promise<{ schedule: ScheduleRow[]; summary: AlternativePlan["summary"] } | null> {
  try {
    return await optimizeSchedule(options, externalVariablesDir, {}, maxSolverSeconds, variant);
  } catch {
    return null;
  }
}

function shouldKeep(
  candidate: ScheduleRow[],
  kept: AlternativePlan[],
  maxJaccard: number,
  minFieldOptionChanges: number,
  minValue: number,
  objectiveValue: number,
): boolean {
  if (objectiveValue + 1e-6 < minValue) return false;
  return !isNearDuplicateOfAny(
    candidate,
    kept.map((plan) => plan.schedule),
    maxJaccard,
    minFieldOptionChanges,
  );
}

export async function generateAlternativePlans(
  options: FieldOption[],
  externalVariablesDir: string = EXTERNAL_DIR,
  maxSolverSeconds?: number,
): Promise<AlternativePlansResult> {
  const config = alternativePlanConfig();
  const timeout = maxSolverSeconds ?? config.maxSolverSeconds;

  const baselineSolve = await optimizeSchedule(options, externalVariablesDir, {}, timeout);
  const zStar = baselineSolve.summary.total_objective_value_aud;
  const minValue = config.minOptimalityRatio * zStar;

  const baseline = toPlan(THEMES[0], baselineSolve.schedule, baselineSolve.summary, options, externalVariablesDir, zStar);
  baseline.reason = buildPlanReason(THEMES[0], baseline, baseline);

  const result: AlternativePlansResult = {
    baseline_objective_aud: zStar,
    min_optimality_ratio: config.minOptimalityRatio,
    plans: [baseline],
  };

  if (!config.enabled) return result;

  for (const theme of THEMES.slice(1)) {
    if (result.plans.length >= config.planCount) break;

    const variant: OptimizationVariant = {
      objective: theme.objective,
      minObjectiveValue: minValue,
      labourCapacityFactor: theme.labourCapacityFactor,
    };

    let solved = await solveTheme(options, externalVariablesDir, timeout, variant);
    if (!solved) continue;

    if (
      !shouldKeep(
        solved.schedule,
        result.plans,
        config.maxJaccardSimilarity,
        config.minFieldOptionChanges,
        minValue,
        solved.summary.total_objective_value_aud,
      )
    ) {
      solved = await solveTheme(options, externalVariablesDir, timeout, {
        ...variant,
        forbidOptionSets: [optionSet(solved.schedule), ...result.plans.map((plan) => plan.selected_option_ids)],
      });
    }

    if (!solved) continue;
    if (
      !shouldKeep(
        solved.schedule,
        result.plans,
        config.maxJaccardSimilarity,
        config.minFieldOptionChanges,
        minValue,
        solved.summary.total_objective_value_aud,
      )
    ) {
      continue;
    }

    const plan = toPlan(theme, solved.schedule, solved.summary, options, externalVariablesDir, zStar);
    plan.reason = buildPlanReason(theme, plan, baseline);
    result.plans.push(plan);
  }

  let fallbackIndex = 1;
  while (result.plans.length < config.planCount && fallbackIndex <= config.planCount + 2) {
    const solved = await solveTheme(options, externalVariablesDir, timeout, {
      objective: "value",
      minObjectiveValue: minValue,
      forbidOptionSets: result.plans.map((plan) => plan.selected_option_ids),
    });
    if (!solved) break;
    if (
      !shouldKeep(
        solved.schedule,
        result.plans,
        config.maxJaccardSimilarity,
        config.minFieldOptionChanges,
        minValue,
        solved.summary.total_objective_value_aud,
      )
    ) {
      break;
    }

    const theme: Theme = {
      plan_id: `near_optimal_${fallbackIndex}`,
      label: "Near-optimal alternative",
      objective: "value",
    };
    const plan = toPlan(theme, solved.schedule, solved.summary, options, externalVariablesDir, zStar);
    plan.reason = buildPlanReason(theme, plan, baseline);
    result.plans.push(plan);
    fallbackIndex += 1;
  }

  result.plans = result.plans.slice(0, config.planCount);
  return result;
}

export function saveAlternativePlans(
  result: AlternativePlansResult,
  path: string = ALTERNATIVE_PLANS_PATH,
): void {
  const serializable = {
    baseline_objective_aud: result.baseline_objective_aud,
    min_optimality_ratio: result.min_optimality_ratio,
    plans: result.plans.map((plan) => ({
      plan_id: plan.plan_id,
      label: plan.label,
      reason: plan.reason,
      objective_value_aud: plan.objective_value_aud,
      optimality_ratio: plan.optimality_ratio,
      selected_option_ids: plan.selected_option_ids,
      metrics: {
        total_cost_aud: plan.metrics.total_cost_aud,
        total_water_ml: plan.metrics.total_water_ml,
        peak_labour: plan.metrics.peak_labour,
        risk_score: plan.metrics.risk_score,
        mean_start: formatIso(plan.metrics.mean_start_time),
      },
      summary: plan.summary,
      schedule: plan.schedule.map((row) => ({
        ...row,
        start_time: formatIso(row.start_time),
        end_time: formatIso(row.end_time),
      })),
    })),
  };
  fs.writeFileSync(path, JSON.stringify(serializable, null, 2));
  for (const [index, plan] of result.plans.entries()) {
    writeScheduleCsv(schedulePath(index + 1), plan.schedule);
  }
}
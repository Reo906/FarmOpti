import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCsv, writeRawCsv, type RawRow } from "../../csv";
import { addDays, compareDateOnly, parseDateOnly, parseTimestamp } from "../../datetime";
import { generateFieldOptions } from "../../fieldOptions";
import { loadFieldOptions } from "../../fieldOptionsIO";
import { optimizeSchedule } from "../../scheduleOptimizer";
import { EXTERNAL_DIR, OUTPUTS_DIR } from "../../paths";
import { compareScenarios, type ScenarioComparison } from "./comparator";
import { buildMask, ScenarioValidationError, ScenarioValidator, type Expression, type ScenarioInterpretation } from "./validator";
import type { FieldOption, OptimizationSummary, ScheduleRow } from "../../types";

const BASELINE_SCHEDULE_PATH = path.join(OUTPUTS_DIR, "optimal_schedule.csv");
const BASELINE_SUMMARY_PATH = path.join(OUTPUTS_DIR, "optimization_summary.json");

interface TableMutation {
  target: string;
  where: Record<string, Expression>;
  update?: Record<string, Expression>;
}

interface CandidateFilter {
  plan_ids: string[];
  field: "date" | "start_time";
  expression: Expression;
}

interface CompiledScenario {
  scenario: ScenarioInterpretation;
  solver_constraints: { forbid_plan_ids: string[]; force_plan_ids: string[]; force_candidate_ids: Record<string, string> };
  table_mutations: TableMutation[];
  candidate_filters: CandidateFilter[];
  resolved_changes: any[];
  requires_regeneration: boolean;
}

export interface ScenarioRunResult {
  scenario: ScenarioInterpretation;
  requestedScenario?: ScenarioInterpretation;
  resolved_changes: any[];
  summary: OptimizationSummary;
  comparison: ScenarioComparison;
  schedule: Record<string, unknown>[];
}

export class ScenarioRunner {
  externalVariablesDir: string;
  validator: ScenarioValidator;

  constructor(externalVariablesDir: string = EXTERNAL_DIR) {
    this.externalVariablesDir = externalVariablesDir;
    this.validator = new ScenarioValidator(this.externalVariablesDir);
  }

  private loadBaseline(): { schedule: ScheduleRow[]; summary: OptimizationSummary } {
    if (!fs.existsSync(BASELINE_SCHEDULE_PATH) || !fs.existsSync(BASELINE_SUMMARY_PATH)) {
      throw new Error("Baseline optimisation outputs are missing. Run the optimizer pipeline first.");
    }
    const rows = readCsv(BASELINE_SCHEDULE_PATH);
    const schedule: ScheduleRow[] = rows.map((r) => ({
      option_id: r.option_id,
      candidate_id: r.candidate_id,
      plan_id: r.plan_id,
      field_id: r.field_id,
      operation: r.operation,
      target: r.target,
      start_time: parseTimestamp(r.start_time),
      end_time: parseTimestamp(r.end_time),
      machine_id: r.machine_id,
      workers_required: Number(r.workers_required),
      water_ml: Number(r.water_ml),
      direct_revenue_aud: Number(r.direct_revenue_aud),
      direct_cost_aud: Number(r.direct_cost_aud),
      direct_cash_effect_aud: Number(r.direct_cash_effect_aud),
      state_yield_effect_t_ha: Number(r.state_yield_effect_t_ha),
    }));
    const summary = JSON.parse(fs.readFileSync(BASELINE_SUMMARY_PATH, "utf-8")) as OptimizationSummary;
    return { schedule, summary };
  }

  private planIds(change: { where: Record<string, Expression> }): string[] {
    return this.validator.matchingRows("action", change.where).map((r) => String(r.plan_id));
  }

  private planRow(planId: string): RawRow {
    const rows = this.validator.matchingRows("action", { plan_id: { op: "eq", value: planId } });
    if (rows.length === 0) throw new ScenarioValidationError(`Unknown plan: ${planId}`);
    return rows[0];
  }

  private exactPlanWhere(planId: string): Record<string, Expression> {
    return { plan_id: { op: "eq", value: planId } };
  }

  private compileDateConstraint(planId: string, expression: Expression): TableMutation {
    const row = this.planRow(planId);
    const oldFrom = parseDateOnly(row.allowed_from);
    const oldTo = parseDateOnly(row.allowed_to);
    const requested = parseDateOnly(String(expression.value));
    const op = expression.op;

    let newFrom: string;
    let newTo: string;

    if (op === "eq") {
      newFrom = requested;
      newTo = requested;
    } else if (op === "gte") {
      newFrom = compareDateOnly(oldFrom, requested) >= 0 ? oldFrom : requested;
      newTo = oldTo;
    } else if (op === "gt") {
      const requestedPlus1 = addDays(requested, 1);
      newFrom = compareDateOnly(oldFrom, requestedPlus1) >= 0 ? oldFrom : requestedPlus1;
      newTo = oldTo;
    } else if (op === "lte") {
      newFrom = oldFrom;
      newTo = compareDateOnly(oldTo, requested) <= 0 ? oldTo : requested;
    } else if (op === "lt") {
      const requestedMinus1 = addDays(requested, -1);
      newFrom = oldFrom;
      newTo = compareDateOnly(oldTo, requestedMinus1) <= 0 ? oldTo : requestedMinus1;
    } else {
      throw new ScenarioValidationError(`Unsupported date constraint operator: ${op}`);
    }

    if (compareDateOnly(newFrom, newTo) > 0) {
      throw new ScenarioValidationError(`Date constraint for ${planId} produces an empty allowed range: ${newFrom} > ${newTo}`);
    }

    return {
      target: this.validator.tableTargetForAction(),
      where: this.exactPlanWhere(planId),
      update: {
        allowed_from: { op: "set", value: newFrom },
        allowed_to: { op: "set", value: newTo },
      },
    };
  }

  private compile(interpretation: ScenarioInterpretation): CompiledScenario {
    const compiled: CompiledScenario = {
      scenario: interpretation,
      solver_constraints: { forbid_plan_ids: [], force_plan_ids: [], force_candidate_ids: {} },
      table_mutations: [],
      candidate_filters: [],
      resolved_changes: [],
      requires_regeneration: false,
    };

    for (const change of interpretation.changes) {
      const target = change.target;

      if (target !== "action") {
        compiled.table_mutations.push(structuredClone(change) as TableMutation);
        compiled.resolved_changes.push(structuredClone(change));
        compiled.requires_regeneration = true;
        continue;
      }

      const planIds = this.planIds(change);
      const resolved: any = { target: "action", plan_ids: planIds, where: structuredClone(change.where) };

      if (change.update) {
        for (const planId of planIds) {
          compiled.table_mutations.push({
            target: this.validator.tableTargetForAction(),
            where: this.exactPlanWhere(planId),
            update: structuredClone(change.update),
          });
        }
        compiled.requires_regeneration = true;
        resolved.update = structuredClone(change.update);
      }

      const constraints = change.constraints ?? {};
      for (const [field, expression] of Object.entries(constraints)) {
        if (field === "selected") {
          const destination = expression.value ? "force_plan_ids" : "forbid_plan_ids";
          compiled.solver_constraints[destination].push(...planIds);
          continue;
        }

        if (field === "date") {
          for (const planId of planIds) {
            compiled.table_mutations.push(this.compileDateConstraint(planId, expression));
            compiled.candidate_filters.push({ plan_ids: [planId], field: "date", expression: structuredClone(expression) });
          }
          compiled.requires_regeneration = true;
          continue;
        }

        if (field === "start_time") {
          const timestamp = parseTimestamp(String(expression.value));
          const dateExpression: Expression = { op: expression.op, value: parseDateOnly(new Date(timestamp).toISOString()) };
          for (const planId of planIds) {
            compiled.table_mutations.push(this.compileDateConstraint(planId, dateExpression));
            compiled.candidate_filters.push({ plan_ids: [planId], field: "start_time", expression: structuredClone(expression) });
          }
          compiled.requires_regeneration = true;
          continue;
        }

        throw new ScenarioValidationError(`Unsupported action constraint field: ${field}`);
      }

      if (Object.keys(constraints).length > 0) resolved.constraints = structuredClone(constraints);
      compiled.resolved_changes.push(resolved);
    }

    compiled.solver_constraints.forbid_plan_ids = [...new Set(compiled.solver_constraints.forbid_plan_ids)].sort();
    compiled.solver_constraints.force_plan_ids = [...new Set(compiled.solver_constraints.force_plan_ids)].sort();

    const overlap = compiled.solver_constraints.forbid_plan_ids.filter((p) =>
      compiled.solver_constraints.force_plan_ids.includes(p),
    );
    if (overlap.length > 0) {
      throw new ScenarioValidationError(`Scenario both forces and forbids plan(s): ${overlap.sort()}`);
    }

    return compiled;
  }

  private applyUpdate(table: RawRow[], mask: boolean[], field: string, expression: Expression): void {
    const { op, value } = expression;

    if (op === "set") {
      table.forEach((row, i) => {
        if (mask[i]) row[field] = String(value);
      });
      return;
    }

    const numericValue = Number(value);
    table.forEach((row, i) => {
      if (!mask[i]) return;
      const current = Number(row[field]);
      if (op === "add") row[field] = String(current + numericValue);
      else if (op === "subtract") row[field] = String(current - numericValue);
      else if (op === "multiply") row[field] = String(current * numericValue);
      else throw new ScenarioValidationError(`Unsupported update operator: ${op}`);
    });
  }

  private applyTableMutations(externalDir: string, mutations: TableMutation[]): void {
    const grouped = new Map<string, TableMutation[]>();
    for (const mutation of mutations) {
      const list = grouped.get(mutation.target) ?? [];
      list.push(mutation);
      grouped.set(mutation.target, list);
    }

    for (const [target, targetMutations] of grouped) {
      const sourcePath = this.validator.fileForTarget(target);
      const filePath = path.join(externalDir, path.basename(sourcePath));
      const table = readCsv(filePath);

      for (const mutation of targetMutations) {
        const mask = buildMask(table, mutation.where);
        if (!mask.some(Boolean)) {
          throw new ScenarioValidationError(`No rows matched compiled mutation for ${target}: ${JSON.stringify(mutation.where)}`);
        }
        for (const [field, expression] of Object.entries(mutation.update!)) {
          this.applyUpdate(table, mask, field, expression);
        }
      }

      writeRawCsv(filePath, table);
    }
  }

  private constraintHolds(action: { start_time: number }, candidateFilter: CandidateFilter): boolean {
    const { field, expression } = candidateFilter;
    let value = action.start_time;
    let expected = parseTimestamp(String(expression.value));

    if (field === "date") {
      value = new Date(value).setUTCHours(0, 0, 0, 0);
      expected = new Date(expected).setUTCHours(0, 0, 0, 0);
    }

    switch (expression.op) {
      case "eq":
        return value === expected;
      case "gt":
        return value > expected;
      case "gte":
        return value >= expected;
      case "lt":
        return value < expected;
      case "lte":
        return value <= expected;
      default:
        throw new ScenarioValidationError(`Unsupported candidate constraint operator: ${expression.op}`);
    }
  }

  private filterOptions(options: FieldOption[], candidateFilters: CandidateFilter[]): FieldOption[] {
    if (candidateFilters.length === 0) return options;

    const filtered = options.filter((option) => {
      for (const candidateFilter of candidateFilters) {
        const planIds = new Set(candidateFilter.plan_ids);
        const matching = option.actions.filter((a) => planIds.has(String(a.plan_id)));
        if (matching.some((a) => !this.constraintHolds(a, candidateFilter))) return false;
      }
      return true;
    });

    if (filtered.length === 0) throw new Error("Scenario constraints removed every field option");
    return filtered;
  }

  async run(interpretation: ScenarioInterpretation): Promise<ScenarioRunResult> {
    if (interpretation.mode !== "scenario") {
      throw new ScenarioValidationError("ScenarioRunner received a non-scenario interpretation");
    }

    const { schedule: baselineSchedule, summary: baselineSummary } = this.loadBaseline();
    const compiled = this.compile(interpretation);
    const solverConstraints = compiled.solver_constraints;

    let scenarioSchedule: ScheduleRow[];
    let scenarioSummary: OptimizationSummary;

    if (!compiled.requires_regeneration) {
      console.log("[SCENARIO] Reusing existing field options");
      const options = loadFieldOptions();
      ({ schedule: scenarioSchedule, summary: scenarioSummary } = await optimizeSchedule(
        options,
        this.externalVariablesDir,
        solverConstraints,
      ));
    } else {
      console.log("[SCENARIO] Applying validated scenario to temporary farm inputs");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "farmopti_scenario_"));
      try {
        const tempExternal = path.join(tempDir, "external_variables");
        fs.cpSync(this.externalVariablesDir, tempExternal, { recursive: true });
        this.applyTableMutations(tempExternal, compiled.table_mutations);

        console.log("[SCENARIO] Regenerating candidates and field options...");
        let options = generateFieldOptions(tempExternal);
        if (options.length === 0) throw new Error("Scenario produced no feasible field options");

        options = this.filterOptions(options, compiled.candidate_filters);
        console.log("[SCENARIO] Solving whole-farm schedule...");
        ({ schedule: scenarioSchedule, summary: scenarioSummary } = await optimizeSchedule(
          options,
          tempExternal,
          solverConstraints,
        ));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    const comparison = compareScenarios(baselineSchedule, baselineSummary, scenarioSchedule, scenarioSummary);

    return {
      scenario: compiled.scenario,
      resolved_changes: compiled.resolved_changes,
      summary: scenarioSummary,
      comparison,
      schedule: scenarioSchedule.map((row) => ({
        ...row,
        start_time: new Date(row.start_time).toISOString(),
        end_time: new Date(row.end_time).toISOString(),
      })),
    };
  }
}

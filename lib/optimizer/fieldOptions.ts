import { generateCandidates } from "./candidateGeneration";
import { CONFIG } from "./config";
import { loadExternalVariables } from "./externalVariables";
import { compareDateOnly, dateOnlyOf, dateOnlyToTimestamp } from "./datetime";
import { FieldSimulator } from "./fieldSimulator";
import { pyRound } from "./numeric";
import { EXTERNAL_DIR } from "./paths";
import type { Candidate, ExternalVariables, FieldOption, ManagementPlanRow, OptionAction } from "./types";

function overlap(a: { start_time: number; end_time: number }, b: { start_time: number; end_time: number }): boolean {
  return a.start_time < b.end_time && b.start_time < a.end_time;
}

function candidateSubset(candidates: Candidate[], cfg: any): Candidate[] {
  if (candidates.length === 0) return candidates;

  const perDay = Number(cfg.max_candidates_per_plan_per_day);
  const maxTotal = Number(cfg.max_candidates_per_plan);

  const byScoreThenTime = (a: Candidate, b: Candidate) => {
    if (b.candidate_score !== a.candidate_score) return b.candidate_score - a.candidate_score;
    return a.start_time - b.start_time;
  };

  const sorted = [...candidates].sort(byScoreThenTime);
  const perDayCounts = new Map<string, number>();
  const limited: Candidate[] = [];

  for (const c of sorted) {
    const d = dateOnlyOf(c.start_time);
    const count = perDayCounts.get(d) ?? 0;
    if (count < perDay) {
      limited.push(c);
      perDayCounts.set(d, count + 1);
    }
  }

  limited.sort(byScoreThenTime);
  return limited.slice(0, maxTotal);
}

function topologicalPlanOrder(plans: ManagementPlanRow[]): string[] {
  const planIds = new Set(plans.map((p) => p.plan_id));
  const deps: Record<string, string> = {};

  for (const row of plans) {
    const dep = row.depends_on?.trim() ?? "";
    deps[row.plan_id] = planIds.has(dep) ? dep : "";
  }

  const ordered: string[] = [];
  const orderedSet = new Set<string>();
  const remaining = new Set(planIds);
  const planById = new Map(plans.map((p) => [p.plan_id, p]));

  while (remaining.size > 0) {
    const ready = [...remaining].filter((pid) => !deps[pid] || orderedSet.has(deps[pid]));
    if (ready.length === 0) {
      throw new Error(`Cyclic management-plan dependency in field ${plans[0]?.field_id}`);
    }

    ready.sort((a, b) => {
      const fromA = planById.get(a)!.allowed_from;
      const fromB = planById.get(b)!.allowed_from;
      if (fromA !== fromB) return compareDateOnly(fromA, fromB);
      return a < b ? -1 : a > b ? 1 : 0;
    });

    for (const pid of ready) {
      ordered.push(pid);
      orderedSet.add(pid);
      remaining.delete(pid);
    }
  }

  return ordered;
}

function repeatSpacingOk(
  choice: Candidate,
  plan: ManagementPlanRow,
  selected: Map<string, Candidate | null>,
  planMap: Map<string, ManagementPlanRow>,
): boolean {
  if (plan.depends_on && plan.depends_on.trim()) return true;

  const gap = plan.min_gap_hours ?? 0.0;
  if (gap <= 0) return true;

  for (const [otherPlanId, other] of selected) {
    if (other === null) continue;

    const otherPlan = planMap.get(otherPlanId)!;
    if (otherPlan.operation.toLowerCase() !== plan.operation.toLowerCase()) continue;

    const aStart = choice.start_time;
    const aEnd = choice.end_time;
    const bStart = other.start_time;
    const bEnd = other.end_time;

    let actualGap: number;
    if (aStart >= bEnd) {
      actualGap = (aStart - bEnd) / 3_600_000;
    } else if (bStart >= aEnd) {
      actualGap = (bStart - aEnd) / 3_600_000;
    } else {
      return false;
    }

    const otherGap = otherPlan.min_gap_hours ?? 0.0;
    if (actualGap < Math.max(gap, otherGap)) return false;
  }

  return true;
}

interface Simulation {
  total_direct_cash_effect_aud: number;
  terminal_value_aud: number;
  objective_value_aud: number;
  actions: OptionAction[];
  final_state: any;
}

function simulateSelection(
  data: ExternalVariables,
  config: any,
  fieldId: string,
  selected: Map<string, Candidate>,
  planMap: Map<string, ManagementPlanRow>,
  horizonEnd: number,
): Simulation | null {
  const simulator = new FieldSimulator(data, config, fieldId);
  const actions = [...selected.values()].sort((a, b) => a.start_time - b.start_time);

  for (let i = 1; i < actions.length; i++) {
    if (overlap(actions[i - 1], actions[i])) return null;
  }

  const completion = new Map<string, number>();
  const dynamicActions: OptionAction[] = [];
  let totalDirectCash = 0.0;

  for (const candidate of actions) {
    const planId = candidate.plan_id;
    const plan = planMap.get(planId)!;
    const dep = plan.depends_on?.trim() ?? "";

    if (dep) {
      if (!completion.has(dep)) return null;

      const minGap = plan.min_gap_hours ?? 0.0;
      const earliest = completion.get(dep)! + minGap * 3_600_000;
      if (candidate.start_time < earliest) return null;
    }

    const dynamic = simulator.evaluateAndApply(candidate, plan);
    if (dynamic === null) return null;

    const action: OptionAction = {
      ...candidate,
      direct_revenue_aud: dynamic.direct_revenue_aud,
      direct_cost_aud: dynamic.direct_cost_aud,
      direct_cash_effect_aud: dynamic.direct_cash_effect_aud,
      state_yield_effect_t_ha: dynamic.state_yield_effect_t_ha,
      state_after: dynamic.state_after!,
    };

    dynamicActions.push(action);
    totalDirectCash += dynamic.direct_cash_effect_aud;
    completion.set(planId, candidate.end_time);
  }

  const terminalValue = simulator.terminalValue(horizonEnd);
  const objectiveValue = totalDirectCash + terminalValue;

  return {
    total_direct_cash_effect_aud: pyRound(totalDirectCash, 2),
    terminal_value_aud: pyRound(terminalValue, 2),
    objective_value_aud: pyRound(objectiveValue, 2),
    actions: dynamicActions,
    final_state: simulator.snapshot(),
  };
}

interface BeamState {
  selected: Map<string, Candidate | null>;
  score: number;
  simulation: Simulation | null;
}

function optionalSignature(state: BeamState, planMap: Map<string, ManagementPlanRow>): string {
  const ids: string[] = [];
  for (const [planId, candidate] of state.selected) {
    if (candidate !== null && !planMap.get(planId)!.required) ids.push(planId);
  }
  return ids.sort().join("|");
}

function keepDiverseBeam(states: BeamState[], limit: number, planMap: Map<string, ManagementPlanRow>): BeamState[] {
  const sorted = [...states].sort((a, b) => b.score - a.score);
  const kept: BeamState[] = [];
  const keptSet = new Set<BeamState>();
  const signatures = new Set<string>();

  for (const state of sorted) {
    const signature = optionalSignature(state, planMap);
    if (!signatures.has(signature)) {
      kept.push(state);
      keptSet.add(state);
      signatures.add(signature);
    }
    if (kept.length >= limit) return kept.slice(0, limit);
  }

  for (const state of sorted) {
    if (kept.length >= limit) break;
    if (!keptSet.has(state)) {
      kept.push(state);
      keptSet.add(state);
    }
  }

  return kept.slice(0, limit);
}

function optionSignature(simulation: Simulation, planMap: Map<string, ManagementPlanRow>): string {
  const ids = simulation.actions
    .filter((a) => !planMap.get(a.plan_id)!.required)
    .map((a) => a.plan_id);
  return [...new Set(ids)].sort().join("|");
}

function keepDiverseOptions(options: Simulation[], limit: number, planMap: Map<string, ManagementPlanRow>): Simulation[] {
  const sorted = [...options].sort((a, b) => b.objective_value_aud - a.objective_value_aud);
  const kept: Simulation[] = [];
  const keptSet = new Set<Simulation>();
  const signatures = new Set<string>();

  for (const option of sorted) {
    const signature = optionSignature(option, planMap);
    if (!signatures.has(signature)) {
      kept.push(option);
      keptSet.add(option);
      signatures.add(signature);
    }
    if (kept.length >= limit) return kept.slice(0, limit);
  }

  for (const option of sorted) {
    if (kept.length >= limit) break;
    if (!keptSet.has(option)) {
      kept.push(option);
      keptSet.add(option);
    }
  }

  return kept.slice(0, limit);
}

export function generateFieldOptions(externalVariablesDir: string = EXTERNAL_DIR): FieldOption[] {
  const data = loadExternalVariables(externalVariablesDir);
  const candidates = generateCandidates(externalVariablesDir);

  if (candidates.length === 0) return [];

  const cfg = CONFIG.field_option_generation;
  const beamWidth = Number(cfg.beam_width);
  const maxOptions = Number(cfg.max_options_per_field);
  const allOptions: FieldOption[] = [];

  const fieldGroups = new Map<string, ManagementPlanRow[]>();
  for (const plan of data.management) {
    const list = fieldGroups.get(plan.field_id) ?? [];
    list.push(plan);
    fieldGroups.set(plan.field_id, list);
  }

  const horizonEnd =
    Math.max(...data.management.map((p) => dateOnlyToTimestamp(p.allowed_to))) + (23 * 60 + 59) * 60_000;

  const candidatesByPlan = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = candidatesByPlan.get(c.plan_id) ?? [];
    list.push(c);
    candidatesByPlan.set(c.plan_id, list);
  }

  for (const [fieldId, fieldPlans] of fieldGroups) {
    const planMap = new Map(fieldPlans.map((p) => [p.plan_id, p]));
    const planOrder = topologicalPlanOrder(fieldPlans);
    let beam: BeamState[] = [{ selected: new Map(), score: 0.0, simulation: null }];

    for (const planId of planOrder) {
      const plan = planMap.get(planId)!;
      const planCandidates = candidateSubset(candidatesByPlan.get(planId) ?? [], cfg);
      const choices: (Candidate | null)[] = plan.required ? [] : [null];
      choices.push(...planCandidates);

      if (plan.required && choices.length === 0) {
        beam = [];
        break;
      }

      const nextBeam: BeamState[] = [];

      for (const state of beam) {
        for (const choice of choices) {
          const selected = new Map(state.selected);

          if (choice === null) {
            selected.set(planId, null);
          } else {
            const dep = plan.depends_on?.trim() ?? "";

            if (dep) {
              const depChoice = selected.get(dep);
              if (!depChoice) continue;

              const minGap = plan.min_gap_hours ?? 0.0;
              if (choice.start_time < depChoice.end_time + minGap * 3_600_000) continue;
            }

            let overlapsExisting = false;
            for (const existing of selected.values()) {
              if (existing !== null && overlap(existing, choice)) {
                overlapsExisting = true;
                break;
              }
            }
            if (overlapsExisting) continue;

            if (!repeatSpacingOk(choice, plan, selected, planMap)) continue;

            selected.set(planId, choice);
          }

          const chosen = new Map<string, Candidate>();
          for (const [pid, value] of selected) if (value !== null) chosen.set(pid, value);

          const simulation = simulateSelection(data, CONFIG, fieldId, chosen, planMap, horizonEnd);

          if (simulation !== null) {
            nextBeam.push({ selected, score: simulation.objective_value_aud, simulation });
          }
        }
      }

      const dedup = new Map<string, BeamState>();
      for (const state of nextBeam) {
        const key = [...state.selected.entries()]
          .map(([pid, value]) => `${pid}:${value ? value.candidate_id : ""}`)
          .sort()
          .join("|");
        const existing = dedup.get(key);
        if (!existing || state.score > existing.score) dedup.set(key, state);
      }

      beam = keepDiverseBeam([...dedup.values()], beamWidth, planMap);
    }

    const valid: Simulation[] = [];

    for (const state of beam) {
      const missingRequired = planOrder.some(
        (pid) => planMap.get(pid)!.required && !state.selected.get(pid),
      );
      if (missingRequired) continue;

      const chosen = new Map<string, Candidate>();
      for (const [pid, value] of state.selected) if (value !== null) chosen.set(pid, value);

      const simulation = simulateSelection(data, CONFIG, fieldId, chosen, planMap, horizonEnd);
      if (simulation !== null) valid.push(simulation);
    }

    const kept = keepDiverseOptions(valid, maxOptions, planMap);
    const seen = new Set<string>();
    let rank = 1;

    for (const simulation of kept) {
      const key = simulation.actions.map((a) => a.candidate_id).join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      allOptions.push({
        option_id: `${fieldId}_O${String(rank).padStart(3, "0")}`,
        field_id: String(fieldId),
        total_direct_cash_effect_aud: simulation.total_direct_cash_effect_aud,
        terminal_value_aud: simulation.terminal_value_aud,
        objective_value_aud: simulation.objective_value_aud,
        actions: simulation.actions,
        final_state: simulation.final_state,
      });
      rank += 1;

      if (rank > maxOptions) break;
    }
  }

  return allOptions;
}

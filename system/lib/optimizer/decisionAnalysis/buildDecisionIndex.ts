import fs from "node:fs";
import type { ActionRecord, DecisionTrace } from "./extractDecisions";
import { DECISION_INDEX_PATH } from "../paths";

export interface DecisionIndexRecord {
  decision_id: string;
  type: string;
  text: string;
  plan_id?: string;
  field_id?: string;
  operation?: string;
  selected?: boolean;
  required?: boolean;
  resource_type?: string;
  importance: number;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  return `$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function actionText(record: ActionRecord): string {
  const { plan_id: planId, field_id: fieldId, operation, selected, required } = record;
  let text: string;

  if (selected) {
    const time = record.timing.selected_time;
    const cash = record.financial?.direct_cash_effect_aud ?? 0.0;
    text = `${planId} ${operation} on ${fieldId} was selected for ${time}. It is ${required ? "required" : "optional"} and has a direct cash effect of ${cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AUD.`;
  } else {
    text = `${planId} ${operation} on ${fieldId} was skipped. It is ${required ? "required" : "optional"}.`;
  }

  const cf = record.counterfactual;
  if (cf && cf.feasible && cf.objective_change_aud !== null && cf.objective_change_aud !== undefined) {
    const delta = cf.objective_change_aud;
    const deltaStr = delta.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    text += selected
      ? ` Forbidding it changes the whole-farm objective by ${deltaStr} AUD.`
      : ` Forcing it changes the whole-farm objective by ${deltaStr} AUD.`;
  }

  return text;
}

function stateText(record: ActionRecord): string | null {
  const transition = record.state_transition;
  if (!transition) return null;

  const changes = transition.state_changes;
  const keys = Object.keys(changes);
  if (keys.length === 0) return null;

  const parts = keys.map((key) => {
    const change = changes[key];
    if ("change" in change && change.change !== undefined) {
      const sign = change.change >= 0 ? "+" : "";
      return `${key}: ${change.before} -> ${change.after} (change ${sign}${change.change})`;
    }
    return `${key}: ${change.before} -> ${change.after}`;
  });

  return `${record.plan_id} changes field ${record.field_id} state: ${parts.join("; ")}.`;
}

function timingText(record: ActionRecord): string | null {
  if (!record.selected) return null;

  const alternatives = record.timing.alternative_times;
  if (!alternatives || alternatives.length === 0) return null;

  const altText = alternatives.map((x) => x.start_time).join(", ");
  return `${record.plan_id} was scheduled at ${record.timing.selected_time}. Nearby feasible alternative timings include ${altText}.`;
}

function counterfactualText(record: ActionRecord): string | null {
  const cf = record.counterfactual;
  if (!cf) return null;

  if (!cf.feasible) {
    return `The counterfactual scenario for ${record.plan_id} was infeasible.`;
  }

  const delta = cf.objective_change_aud;
  const deltaStr = delta.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const affectedCount = (cf.affected_decisions ?? []).length;

  if (record.selected) {
    return `Forbidding selected action ${record.plan_id} changes the whole-farm objective by ${deltaStr} AUD and changes ${affectedCount} other schedule decisions.`;
  }

  return `Forcing skipped action ${record.plan_id} changes the whole-farm objective by ${deltaStr} AUD and changes ${affectedCount} other schedule decisions.`;
}

export function buildDecisionIndex(trace: DecisionTrace): DecisionIndexRecord[] {
  const records: DecisionIndexRecord[] = [];

  for (const action of trace.actions) {
    const baseMetadata = {
      plan_id: action.plan_id,
      field_id: action.field_id,
      operation: action.operation,
      selected: action.selected,
      required: action.required,
      importance: action.importance,
    };

    records.push({
      decision_id: `${action.plan_id}:selection`,
      type: action.type,
      text: actionText(action),
      ...baseMetadata,
    });

    const state = stateText(action);
    if (state) {
      records.push({ decision_id: `${action.plan_id}:state`, type: "STATE_TRANSITION", text: state, ...baseMetadata });
    }

    const timing = timingText(action);
    if (timing) {
      records.push({ decision_id: `${action.plan_id}:timing`, type: "TIMING_SELECTION", text: timing, ...baseMetadata });
    }

    const counterfactual = counterfactualText(action);
    if (counterfactual) {
      records.push({
        decision_id: `${action.plan_id}:counterfactual`,
        type: "COUNTERFACTUAL",
        text: counterfactual,
        ...baseMetadata,
      });
    }
  }

  for (const field of trace.field_decisions) {
    const alt = field.best_local_alternative;
    let text = `Field ${field.field_id} uses option ${field.selected_option_id} with objective value ${field.selected_objective_value_aud.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AUD.`;

    if (alt) {
      text += ` The best other retained field option is ${alt.option_id} with value ${alt.objective_value_aud.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AUD.`;
    }

    records.push({
      decision_id: field.decision_id,
      type: field.type,
      field_id: field.field_id,
      importance: 0.4,
      text,
    });
  }

  for (const resource of trace.resources) {
    if (!resource.binding) continue;

    let text: string;
    if (resource.resource_type === "machine") {
      text = `Machine ${resource.resource_id} is a high-utilisation resource at ${(resource.utilisation * 100).toFixed(0)}% utilisation.`;
    } else if (resource.resource_type === "water") {
      text = `Water capacity on ${resource.date} is highly utilised at ${(resource.utilisation * 100).toFixed(0)}%.`;
    } else {
      text = `Labour at ${resource.time} is highly utilised at ${(resource.utilisation * 100).toFixed(0)}%.`;
    }

    records.push({
      decision_id: resource.decision_id,
      type: "RESOURCE_CONSTRAINT",
      resource_type: resource.resource_type,
      importance: 0.7,
      text,
    });
  }

  records.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));

  return records;
}

export function saveDecisionIndex(records: DecisionIndexRecord[], path: string = DECISION_INDEX_PATH): void {
  const lines = records.map((r) => JSON.stringify(r));
  fs.writeFileSync(path, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
}

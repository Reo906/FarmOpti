from __future__ import annotations

import json
from pathlib import Path

from optimization.generate_candidates import OPTIMIZER_ROOT


INDEX_PATH = OPTIMIZER_ROOT / "outputs" / "decision_index.jsonl"


def _money(value):
    if value is None:
        return "unknown"
    return f"${abs(float(value)):,.2f}"


def action_text(record):
    plan_id = record["plan_id"]
    field_id = record["field_id"]
    operation = record["operation"]
    selected = record["selected"]
    required = record["required"]

    if selected:
        time = record["timing"]["selected_time"]
        financial = record.get("financial") or {}
        cash = float(financial.get("direct_cash_effect_aud", 0.0))

        text = (
            f"{plan_id} {operation} on {field_id} was selected for {time}. "
            f"It is {'required' if required else 'optional'} and has a direct "
            f"cash effect of {cash:,.2f} AUD."
        )
    else:
        text = (
            f"{plan_id} {operation} on {field_id} was skipped. "
            f"It is {'required' if required else 'optional'}."
        )

    cf = record.get("counterfactual")
    if cf and cf.get("feasible") and cf.get("objective_change_aud") is not None:
        delta = float(cf["objective_change_aud"])

        if selected:
            text += (
                f" Forbidding it changes the whole-farm objective by "
                f"{delta:,.2f} AUD."
            )
        else:
            text += (
                f" Forcing it changes the whole-farm objective by "
                f"{delta:,.2f} AUD."
            )

    return text


def state_text(record):
    transition = record.get("state_transition")
    if not transition:
        return None

    changes = transition.get("state_changes", {})
    if not changes:
        return None

    parts = []

    for key, change in changes.items():
        if "change" in change:
            parts.append(
                f"{key}: {change['before']} -> {change['after']} "
                f"(change {change['change']:+})"
            )
        else:
            parts.append(
                f"{key}: {change['before']} -> {change['after']}"
            )

    return (
        f"{record['plan_id']} changes field {record['field_id']} state: "
        + "; ".join(parts)
        + "."
    )


def timing_text(record):
    timing = record["timing"]

    if not record["selected"]:
        return None

    alternatives = timing.get("alternative_times", [])
    if not alternatives:
        return None

    alt_text = ", ".join(
        str(x["start_time"])
        for x in alternatives
    )

    return (
        f"{record['plan_id']} was scheduled at "
        f"{timing['selected_time']}. Nearby feasible alternative timings "
        f"include {alt_text}."
    )


def counterfactual_text(record):
    cf = record.get("counterfactual")
    if not cf:
        return None

    if not cf.get("feasible"):
        return (
            f"The counterfactual scenario for {record['plan_id']} "
            f"was infeasible."
        )

    delta = float(cf["objective_change_aud"])

    if record["selected"]:
        return (
            f"Forbidding selected action {record['plan_id']} changes the "
            f"whole-farm objective by {delta:,.2f} AUD and changes "
            f"{len(cf.get('affected_decisions', []))} other schedule decisions."
        )

    return (
        f"Forcing skipped action {record['plan_id']} changes the "
        f"whole-farm objective by {delta:,.2f} AUD and changes "
        f"{len(cf.get('affected_decisions', []))} other schedule decisions."
    )


def build_decision_index(trace):
    records = []

    for action in trace["actions"]:
        base_metadata = {
            "plan_id": action["plan_id"],
            "field_id": action["field_id"],
            "operation": action["operation"],
            "selected": action["selected"],
            "required": action["required"],
            "importance": action["importance"],
        }

        records.append({
            "decision_id": f"{action['plan_id']}:selection",
            "type": action["type"],
            "text": action_text(action),
            **base_metadata,
        })

        state = state_text(action)
        if state:
            records.append({
                "decision_id": f"{action['plan_id']}:state",
                "type": "STATE_TRANSITION",
                "text": state,
                **base_metadata,
            })

        timing = timing_text(action)
        if timing:
            records.append({
                "decision_id": f"{action['plan_id']}:timing",
                "type": "TIMING_SELECTION",
                "text": timing,
                **base_metadata,
            })

        counterfactual = counterfactual_text(action)
        if counterfactual:
            records.append({
                "decision_id": f"{action['plan_id']}:counterfactual",
                "type": "COUNTERFACTUAL",
                "text": counterfactual,
                **base_metadata,
            })

    for field in trace["field_decisions"]:
        alt = field.get("best_local_alternative")
        text = (
            f"Field {field['field_id']} uses option "
            f"{field['selected_option_id']} with objective value "
            f"{field['selected_objective_value_aud']:,.2f} AUD."
        )

        if alt:
            text += (
                f" The best other retained field option is "
                f"{alt['option_id']} with value "
                f"{alt['objective_value_aud']:,.2f} AUD."
            )

        records.append({
            "decision_id": field["decision_id"],
            "type": field["type"],
            "field_id": field["field_id"],
            "importance": 0.4,
            "text": text,
        })

    for resource in trace["resources"]:
        if not resource.get("binding"):
            continue

        resource_type = resource["resource_type"]

        if resource_type == "machine":
            text = (
                f"Machine {resource['resource_id']} is a high-utilisation "
                f"resource at {resource['utilisation']:.0%} utilisation."
            )
        elif resource_type == "water":
            text = (
                f"Water capacity on {resource['date']} is highly utilised "
                f"at {resource['utilisation']:.0%}."
            )
        else:
            text = (
                f"Labour at {resource['time']} is highly utilised "
                f"at {resource['utilisation']:.0%}."
            )

        records.append({
            "decision_id": resource["decision_id"],
            "type": "RESOURCE_CONSTRAINT",
            "resource_type": resource_type,
            "importance": 0.7,
            "text": text,
        })

    records.sort(
        key=lambda x: float(x.get("importance", 0.0)),
        reverse=True,
    )

    return records


def save_decision_index(records, path=INDEX_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

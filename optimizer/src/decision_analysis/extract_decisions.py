from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import pandas as pd

from optimization.generate_candidates import CONFIG, EXTERNAL_DIR, OPTIMIZER_ROOT, load_external_variables
from optimization.simulate_field import FieldSimulator


TRACE_PATH = OPTIMIZER_ROOT / "outputs" / "decision_trace.json"


def _json_safe(value):
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    if hasattr(value, "item"):
        return value.item()
    return value


def _state_diff(before, after):
    changes = {}

    for key in sorted(set(before) | set(after)):
        a = before.get(key)
        b = after.get(key)

        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            delta = round(float(b) - float(a), 4)
            if abs(delta) > 1e-9:
                changes[key] = {
                    "before": round(float(a), 4),
                    "after": round(float(b), 4),
                    "change": delta,
                }
        elif a != b:
            changes[key] = {
                "before": a,
                "after": b,
            }

    return changes


def simulate_selected_option(data, option):
    field_id = str(option["field_id"])
    management = data["management"].copy()
    management["plan_id"] = management["plan_id"].astype(str)
    plan_map = {str(row["plan_id"]): row for _, row in management.iterrows()}

    simulator = FieldSimulator(data, CONFIG, field_id)
    records = []

    for raw_action in sorted(option["actions"], key=lambda x: pd.Timestamp(x["start_time"])):
        action = dict(raw_action)
        plan_id = str(action["plan_id"])
        start = pd.Timestamp(action["start_time"])

        simulator.advance_to(start)
        before = simulator.snapshot()
        result = simulator.evaluate_and_apply(action, plan_map[plan_id])

        if result is None:
            continue

        after = simulator.snapshot()

        records.append({
            "plan_id": plan_id,
            "candidate_id": str(action["candidate_id"]),
            "field_id": field_id,
            "operation": str(action["operation"]),
            "target": action.get("target", ""),
            "start_time": start,
            "end_time": pd.Timestamp(action["end_time"]),
            "state_before": before,
            "state_after": after,
            "state_changes": _state_diff(before, after),
            "direct_revenue_aud": float(result["direct_revenue_aud"]),
            "direct_cost_aud": float(result["direct_cost_aud"]),
            "direct_cash_effect_aud": float(result["direct_cash_effect_aud"]),
            "state_yield_effect_t_ha": float(result["state_yield_effect_t_ha"]),
        })

    return records


def build_action_records(data, candidates, options, schedule, summary):
    management = data["management"].copy()
    management["plan_id"] = management["plan_id"].astype(str)

    schedule = schedule.copy()
    if not schedule.empty:
        schedule["plan_id"] = schedule["plan_id"].astype(str)
        schedule["candidate_id"] = schedule["candidate_id"].astype(str)

    selected_option_ids = {
        str(item["option_id"])
        for item in summary["selected_options"]
    }

    selected_options = {
        str(option["option_id"]): option
        for option in options
        if str(option["option_id"]) in selected_option_ids
    }

    transitions = {}
    for option in selected_options.values():
        for record in simulate_selected_option(data, option):
            transitions[record["plan_id"]] = record

    records = []

    for _, plan in management.iterrows():
        plan_id = str(plan["plan_id"])
        selected_rows = schedule[schedule["plan_id"] == plan_id] if not schedule.empty else pd.DataFrame()
        selected = not selected_rows.empty
        selected_row = selected_rows.iloc[0] if selected else None

        plan_candidates = candidates[candidates["plan_id"].astype(str) == plan_id].copy()
        if not plan_candidates.empty:
            plan_candidates["start_time"] = pd.to_datetime(plan_candidates["start_time"])
            plan_candidates = plan_candidates.sort_values("start_time")

        timing = {
            "feasible_candidate_count": int(len(plan_candidates)),
            "earliest_feasible_time": None,
            "latest_feasible_time": None,
            "selected_time": None,
            "selected_candidate_id": None,
            "alternative_times": [],
        }

        if not plan_candidates.empty:
            timing["earliest_feasible_time"] = plan_candidates.iloc[0]["start_time"]
            timing["latest_feasible_time"] = plan_candidates.iloc[-1]["start_time"]

        if selected:
            timing["selected_time"] = pd.Timestamp(selected_row["start_time"])
            timing["selected_candidate_id"] = str(selected_row["candidate_id"])

            alternatives = plan_candidates[
                plan_candidates["candidate_id"].astype(str) != str(selected_row["candidate_id"])
            ]

            if not alternatives.empty:
                alternatives = alternatives.assign(
                    distance=(
                        alternatives["start_time"] - pd.Timestamp(selected_row["start_time"])
                    ).abs()
                ).sort_values("distance").head(5)

                timing["alternative_times"] = [
                    {
                        "candidate_id": str(row["candidate_id"]),
                        "start_time": row["start_time"],
                        "direct_cash_effect_aud": float(row["direct_cash_effect_aud"]),
                    }
                    for _, row in alternatives.iterrows()
                ]

        record = {
            "decision_id": f"{plan_id}:action",
            "type": "ACTION_SELECTED" if selected else "ACTION_SKIPPED",
            "plan_id": plan_id,
            "field_id": str(plan["field_id"]),
            "operation": str(plan["operation"]),
            "target": "" if pd.isna(plan["target"]) else str(plan["target"]),
            "required": bool(plan["required"]),
            "selected": selected,
            "depends_on": "" if pd.isna(plan["depends_on"]) else str(plan["depends_on"]),
            "min_gap_hours": 0.0 if pd.isna(plan["min_gap_hours"]) else float(plan["min_gap_hours"]),
            "timing": timing,
            "financial": None,
            "state_transition": transitions.get(plan_id),
            "counterfactual": None,
            "importance": 0.0,
        }

        if selected:
            record["financial"] = {
                "direct_revenue_aud": float(selected_row["direct_revenue_aud"]),
                "direct_cost_aud": float(selected_row["direct_cost_aud"]),
                "direct_cash_effect_aud": float(selected_row["direct_cash_effect_aud"]),
                "state_yield_effect_t_ha": float(selected_row["state_yield_effect_t_ha"]),
            }

        records.append(record)

    return records


def build_field_records(options, summary):
    selected_ids = {
        str(item["option_id"]): item
        for item in summary["selected_options"]
    }

    options_by_field = defaultdict(list)
    for option in options:
        options_by_field[str(option["field_id"])].append(option)

    records = []

    for field_id, field_options in options_by_field.items():
        selected = next(
            option for option in field_options
            if str(option["option_id"]) in selected_ids
        )

        alternatives = [
            option for option in field_options
            if str(option["option_id"]) != str(selected["option_id"])
        ]
        alternatives.sort(
            key=lambda x: float(x["objective_value_aud"]),
            reverse=True,
        )

        best_alt = alternatives[0] if alternatives else None

        records.append({
            "decision_id": f"{field_id}:field_option",
            "type": "FIELD_OPTION_SELECTED",
            "field_id": field_id,
            "selected_option_id": str(selected["option_id"]),
            "selected_objective_value_aud": float(selected["objective_value_aud"]),
            "selected_direct_cash_effect_aud": float(selected["total_direct_cash_effect_aud"]),
            "selected_terminal_value_aud": float(selected["terminal_value_aud"]),
            "best_local_alternative": None if best_alt is None else {
                "option_id": str(best_alt["option_id"]),
                "objective_value_aud": float(best_alt["objective_value_aud"]),
                "local_value_difference_aud": round(
                    float(selected["objective_value_aud"])
                    - float(best_alt["objective_value_aud"]),
                    2,
                ),
            },
        })

    return records


def build_resource_records(data, schedule):
    if schedule.empty:
        return []

    schedule = schedule.copy()
    schedule["start_time"] = pd.to_datetime(schedule["start_time"])
    schedule["end_time"] = pd.to_datetime(schedule["end_time"])
    records = []

    for machine_id, group in schedule.groupby("machine_id"):
        used_hours = sum(
            (row["end_time"] - row["start_time"]).total_seconds() / 3600.0
            for _, row in group.iterrows()
        )

        machine_availability = data["machine_availability"][
            (data["machine_availability"]["machine_id"] == machine_id)
            & (data["machine_availability"]["available"] == 1)
        ]

        available_hours = 0.0
        for _, row in machine_availability.iterrows():
            start = pd.Timestamp(f"{row['date']} {row['available_from']}")
            end = pd.Timestamp(f"{row['date']} {row['available_to']}")
            available_hours += max(0.0, (end - start).total_seconds() / 3600.0)

        utilisation = used_hours / available_hours if available_hours > 0 else 0.0

        records.append({
            "decision_id": f"machine:{machine_id}",
            "type": "RESOURCE_UTILISATION",
            "resource_type": "machine",
            "resource_id": str(machine_id),
            "used_hours": round(used_hours, 2),
            "available_hours": round(available_hours, 2),
            "utilisation": round(utilisation, 4),
            "binding": utilisation >= 0.90,
            "affected_plans": group["plan_id"].astype(str).tolist(),
        })

    for date, row in data["water"].set_index("date").iterrows():
        used = schedule.loc[
            schedule["start_time"].dt.date == date,
            "water_ml",
        ].sum()

        capacity = min(
            float(row["available_water_ml"]),
            float(row["max_delivery_ml_per_day"]),
        )

        utilisation = float(used) / capacity if capacity > 0 else 0.0

        records.append({
            "decision_id": f"water:{date}",
            "type": "RESOURCE_UTILISATION",
            "resource_type": "water",
            "date": str(date),
            "used_ml": round(float(used), 3),
            "capacity_ml": round(capacity, 3),
            "utilisation": round(utilisation, 4),
            "binding": utilisation >= 0.90,
        })

    time_step = pd.Timedelta(hours=float(CONFIG["candidate_generation"]["time_step_hours"]))
    start = schedule["start_time"].min().floor("h")
    end = schedule["end_time"].max().ceil("h")
    t = start

    while t < end:
        labour_rows = data["labour"][data["labour"]["date"] == t.date()]

        if not labour_rows.empty:
            capacity = int(labour_rows.iloc[0]["available_workers"])
            active = schedule[
                (schedule["start_time"] <= t)
                & (schedule["end_time"] > t)
            ]

            used = int(active["workers_required"].sum())
            utilisation = used / capacity if capacity > 0 else 0.0

            if used > 0 or utilisation >= 0.90:
                records.append({
                    "decision_id": f"labour:{t.isoformat()}",
                    "type": "RESOURCE_UTILISATION",
                    "resource_type": "labour",
                    "time": t,
                    "used_workers": used,
                    "available_workers": capacity,
                    "utilisation": round(utilisation, 4),
                    "binding": utilisation >= 0.90,
                    "affected_plans": active["plan_id"].astype(str).tolist(),
                })

        t += time_step

    return records


def update_importance(trace):
    baseline = abs(float(trace["summary"]["total_objective_value_aud"])) or 1.0

    counterfactual_by_plan = {
        str(x["plan_id"]): x
        for x in trace.get("counterfactuals", [])
    }

    for record in trace["actions"]:
        score = 0.0

        if record["required"]:
            score += 0.15

        financial = record.get("financial")

        if financial and financial["direct_cash_effect_aud"] < 0:
            score += min(
                0.20,
                abs(float(financial["direct_cash_effect_aud"])) / baseline * 10,
            )

        counterfactual = counterfactual_by_plan.get(record["plan_id"])

        if counterfactual:
            record["counterfactual"] = counterfactual

            objective_change = counterfactual.get("objective_change_aud")

            if objective_change is not None:
                delta = abs(float(objective_change))
                score += min(0.60, delta / baseline * 20)

            elif not counterfactual.get("feasible", True):
                # If forcing/forbidding the action makes the whole schedule
                # infeasible, that is itself an important decision.
                score += 0.60

        if not record["required"]:
            score += 0.10

        record["importance"] = round(min(1.0, score), 4)

    return trace


def generate_decision_trace(
    candidates,
    options,
    schedule,
    summary,
    external_variables_dir=EXTERNAL_DIR,
):
    data = load_external_variables(external_variables_dir)

    trace = {
        "generated_at": datetime.now().isoformat(),
        "summary": summary,
        "actions": build_action_records(
            data,
            candidates,
            options,
            schedule,
            summary,
        ),
        "field_decisions": build_field_records(options, summary),
        "resources": build_resource_records(data, schedule),
        "counterfactuals": [],
    }

    return update_importance(trace)


def save_decision_trace(trace, path=TRACE_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(_json_safe(trace), f, indent=2)

from __future__ import annotations

import pandas as pd
from tqdm.auto import tqdm

from optimization.optimize_schedule import optimize_schedule


def _schedule_map(schedule):
    if schedule.empty:
        return {}

    return {
        str(row["plan_id"]): {
            "selected": True,
            "candidate_id": str(row["candidate_id"]),
            "start_time": pd.Timestamp(row["start_time"]).isoformat(),
            "field_id": str(row["field_id"]),
            "operation": str(row["operation"]),
        }
        for _, row in schedule.iterrows()
    }


def _compare_schedules(baseline_schedule, scenario_schedule):
    baseline = _schedule_map(baseline_schedule)
    scenario = _schedule_map(scenario_schedule)
    changes = []

    for plan_id in sorted(set(baseline) | set(scenario)):
        a = baseline.get(plan_id)
        b = scenario.get(plan_id)

        if a is None:
            changes.append({
                "plan_id": plan_id,
                "change": "added",
                "new_candidate_id": b["candidate_id"],
                "new_start_time": b["start_time"],
            })
            continue

        if b is None:
            changes.append({
                "plan_id": plan_id,
                "change": "removed",
                "old_candidate_id": a["candidate_id"],
                "old_start_time": a["start_time"],
            })
            continue

        if a["candidate_id"] != b["candidate_id"]:
            changes.append({
                "plan_id": plan_id,
                "change": "rescheduled",
                "old_candidate_id": a["candidate_id"],
                "new_candidate_id": b["candidate_id"],
                "old_start_time": a["start_time"],
                "new_start_time": b["start_time"],
            })

    return changes


def run_action_counterfactuals(
    trace,
    options,
    baseline_schedule,
    baseline_summary,
    external_variables_dir,
    max_solver_seconds=5,
):
    baseline_value = float(baseline_summary["total_objective_value_aud"])
    optional_actions = [
        record
        for record in trace["actions"]
        if not record["required"]
    ]

    results = []

    for record in tqdm(
        optional_actions,
        desc="Decision counterfactuals",
        unit="action",
    ):
        plan_id = str(record["plan_id"])
        selected = bool(record["selected"])

        scenario = (
            {"forbid_plan_ids": [plan_id]}
            if selected
            else {"force_plan_ids": [plan_id]}
        )

        scenario_type = (
            "FORBID_SELECTED_ACTION"
            if selected
            else "FORCE_SKIPPED_ACTION"
        )

        try:
            scenario_schedule, scenario_summary = optimize_schedule(
                options,
                external_variables_dir=external_variables_dir,
                scenario=scenario,
                show_progress=False,
                max_solver_seconds=max_solver_seconds,
            )

            scenario_value = float(
                scenario_summary["total_objective_value_aud"]
            )

            results.append({
                "decision_id": f"{plan_id}:counterfactual",
                "type": "COUNTERFACTUAL",
                "plan_id": plan_id,
                "field_id": record["field_id"],
                "operation": record["operation"],
                "baseline_selected": selected,
                "scenario": scenario_type,
                "feasible": True,
                "baseline_objective_aud": round(baseline_value, 2),
                "counterfactual_objective_aud": round(scenario_value, 2),
                "objective_change_aud": round(
                    scenario_value - baseline_value,
                    2,
                ),
                "affected_decisions": _compare_schedules(
                    baseline_schedule,
                    scenario_schedule,
                ),
            })

        except RuntimeError:
            results.append({
                "decision_id": f"{plan_id}:counterfactual",
                "type": "COUNTERFACTUAL",
                "plan_id": plan_id,
                "field_id": record["field_id"],
                "operation": record["operation"],
                "baseline_selected": selected,
                "scenario": scenario_type,
                "feasible": False,
                "baseline_objective_aud": round(baseline_value, 2),
                "counterfactual_objective_aud": None,
                "objective_change_aud": None,
                "affected_decisions": [],
            })

    return results


def run_timing_counterfactual(
    options,
    baseline_schedule,
    baseline_summary,
    plan_id,
    candidate_id,
    external_variables_dir,
    max_solver_seconds=5,
):
    baseline_value = float(baseline_summary["total_objective_value_aud"])

    try:
        scenario_schedule, scenario_summary = optimize_schedule(
            options,
            external_variables_dir=external_variables_dir,
            scenario={
                "force_candidate_ids": {
                    str(plan_id): str(candidate_id)
                }
            },
            show_progress=False,
            max_solver_seconds=max_solver_seconds,
        )

        scenario_value = float(
            scenario_summary["total_objective_value_aud"]
        )

        return {
            "type": "TIMING_COUNTERFACTUAL",
            "plan_id": str(plan_id),
            "candidate_id": str(candidate_id),
            "feasible": True,
            "baseline_objective_aud": round(baseline_value, 2),
            "counterfactual_objective_aud": round(scenario_value, 2),
            "objective_change_aud": round(
                scenario_value - baseline_value,
                2,
            ),
            "affected_decisions": _compare_schedules(
                baseline_schedule,
                scenario_schedule,
            ),
        }

    except RuntimeError:
        return {
            "type": "TIMING_COUNTERFACTUAL",
            "plan_id": str(plan_id),
            "candidate_id": str(candidate_id),
            "feasible": False,
            "baseline_objective_aud": round(baseline_value, 2),
            "counterfactual_objective_aud": None,
            "objective_change_aud": None,
            "affected_decisions": [],
        }

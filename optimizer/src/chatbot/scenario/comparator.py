from __future__ import annotations

import pandas as pd


def _schedule_by_plan(schedule):
    if schedule is None or schedule.empty:
        return {}
    schedule = schedule.copy()
    schedule["plan_id"] = schedule["plan_id"].astype(str)
    return {str(row["plan_id"]): row for _, row in schedule.iterrows()}


def compare_scenarios(baseline_schedule, baseline_summary, scenario_schedule, scenario_summary):
    baseline = _schedule_by_plan(baseline_schedule)
    scenario = _schedule_by_plan(scenario_schedule)
    added = []
    removed = []
    rescheduled = []
    unchanged = []

    for plan_id in sorted(set(baseline) | set(scenario)):
        old = baseline.get(plan_id)
        new = scenario.get(plan_id)

        if old is None:
            added.append({"plan_id": plan_id, "field_id": str(new["field_id"]), "operation": str(new["operation"]), "start_time": str(new["start_time"])})
            continue

        if new is None:
            removed.append({"plan_id": plan_id, "field_id": str(old["field_id"]), "operation": str(old["operation"]), "start_time": str(old["start_time"])})
            continue

        old_candidate = str(old.get("candidate_id", ""))
        new_candidate = str(new.get("candidate_id", ""))
        old_machine = str(old.get("machine_id", ""))
        new_machine = str(new.get("machine_id", ""))

        if old_candidate != new_candidate or old_machine != new_machine:
            rescheduled.append({
                "plan_id": plan_id,
                "field_id": str(new["field_id"]),
                "operation": str(new["operation"]),
                "old_start_time": str(old["start_time"]),
                "new_start_time": str(new["start_time"]),
                "old_machine_id": old_machine,
                "new_machine_id": new_machine,
            })
        else:
            unchanged.append(plan_id)

    baseline_value = float(baseline_summary["total_objective_value_aud"])
    scenario_value = float(scenario_summary["total_objective_value_aud"])

    return {
        "baseline_objective_aud": round(baseline_value, 2),
        "scenario_objective_aud": round(scenario_value, 2),
        "objective_change_aud": round(scenario_value - baseline_value, 2),
        "baseline_direct_cash_effect_aud": float(baseline_summary["total_direct_cash_effect_aud"]),
        "scenario_direct_cash_effect_aud": float(scenario_summary["total_direct_cash_effect_aud"]),
        "baseline_terminal_value_aud": float(baseline_summary["total_terminal_value_aud"]),
        "scenario_terminal_value_aud": float(scenario_summary["total_terminal_value_aud"]),
        "actions_added": added,
        "actions_removed": removed,
        "actions_rescheduled": rescheduled,
        "unchanged_plan_count": len(unchanged),
    }

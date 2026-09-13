from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import pandas as pd
from tqdm.auto import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from optimization.generate_candidates import CONFIG, EXTERNAL_DIR, OPTIMIZER_ROOT, load_external_variables


FIELD_OPTIONS_PATH = OPTIMIZER_ROOT / "outputs" / "field_options.json"
SCHEDULE_PATH = OPTIMIZER_ROOT / "outputs" / "optimal_schedule.csv"
SUMMARY_PATH = OPTIMIZER_ROOT / "outputs" / "optimization_summary.json"


def load_field_options(path=FIELD_OPTIONS_PATH):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)["options"]


def parse_time(date, value):
    t = datetime.strptime(str(value), "%H:%M").time()
    return pd.Timestamp.combine(date, t)


def field_distance_km(fields, field_a, field_b):
    if field_a == field_b:
        return 0.0

    row_a = fields.loc[field_a]
    row_b = fields.loc[field_b]
    dx = float(row_a["x_km"]) - float(row_b["x_km"])
    dy = float(row_a["y_km"]) - float(row_b["y_km"])
    return math.sqrt(dx * dx + dy * dy)


def machine_pair_incompatible(fields, action_a, action_b):
    start_a = pd.Timestamp(action_a["start_time"])
    end_a = pd.Timestamp(action_a["end_time"])
    start_b = pd.Timestamp(action_b["start_time"])
    end_b = pd.Timestamp(action_b["end_time"])

    if start_a < end_b and start_b < end_a:
        return True

    if not CONFIG.get("transport", {}).get("enforce_travel_time", False):
        return False

    if end_a <= start_b:
        earlier, later = action_a, action_b
        gap_hours = (start_b - end_a).total_seconds() / 3600.0
    elif end_b <= start_a:
        earlier, later = action_b, action_a
        gap_hours = (start_a - end_b).total_seconds() / 3600.0
    else:
        return True

    speed = float(CONFIG["transport"]["machine_speed_kmh"])
    distance = field_distance_km(fields, earlier["field_id"], later["field_id"])
    return gap_hours + 1e-9 < distance / speed


def option_contains_plan(option, plan_id):
    return any(str(action["plan_id"]) == str(plan_id) for action in option["actions"])


def option_contains_candidate(option, candidate_id):
    return any(str(action["candidate_id"]) == str(candidate_id) for action in option["actions"])


def optimize_schedule(
    options,
    external_variables_dir=EXTERNAL_DIR,
    scenario=None,
    show_progress=True,
    max_solver_seconds=None,
):
    try:
        from ortools.sat.python import cp_model
    except ImportError as exc:
        raise ImportError("OR-Tools is required. Install it with: pip install ortools") from exc

    scenario = scenario or {}
    forbid_plan_ids = {str(x) for x in scenario.get("forbid_plan_ids", [])}
    force_plan_ids = {str(x) for x in scenario.get("force_plan_ids", [])}
    force_candidate_ids = {str(k): str(v) for k, v in scenario.get("force_candidate_ids", {}).items()}

    data = load_external_variables(external_variables_dir)
    fields = data["fields"].set_index("field_id")
    model = cp_model.CpModel()

    options_by_field = defaultdict(list)
    for option in options:
        options_by_field[str(option["field_id"])].append(option)

    option_vars = {}
    for field_id, field_options in options_by_field.items():
        vars_for_field = []

        for option in field_options:
            var = model.NewBoolVar(f"choose_{option['option_id']}")
            option_vars[option["option_id"]] = var
            vars_for_field.append(var)

            if any(option_contains_plan(option, pid) for pid in forbid_plan_ids):
                model.Add(var == 0)

            for pid in force_plan_ids:
                field_has_plan = any(str(action["plan_id"]) == pid for candidate in field_options for action in candidate["actions"])
                if field_has_plan and not option_contains_plan(option, pid):
                    model.Add(var == 0)

            for pid, candidate_id in force_candidate_ids.items():
                field_has_plan = any(str(action["plan_id"]) == pid for candidate in field_options for action in candidate["actions"])
                if field_has_plan and not option_contains_candidate(option, candidate_id):
                    model.Add(var == 0)

        model.Add(sum(vars_for_field) == 1)

    actions = []
    machine_assignments = {}
    option_iterator = tqdm(options, desc="Adding actions", unit="option") if show_progress else options

    for option in option_iterator:
        option_var = option_vars[option["option_id"]]

        for index, raw_action in enumerate(option["actions"]):
            action = dict(raw_action)
            action["option_id"] = option["option_id"]
            action["action_key"] = f"{option['option_id']}__A{index:02d}"
            action["start_time"] = pd.Timestamp(action["start_time"])
            action["end_time"] = pd.Timestamp(action["end_time"])

            eligible = action.get("eligible_machine_ids", [])
            if isinstance(eligible, str):
                eligible = [x for x in eligible.split(",") if x]

            action["eligible_machine_ids"] = eligible
            actions.append(action)

            assignment_vars = []
            for machine_id in eligible:
                var = model.NewBoolVar(f"assign_{action['action_key']}_{machine_id}")
                machine_assignments[(action["action_key"], machine_id)] = var
                assignment_vars.append(var)

            if not assignment_vars:
                model.Add(option_var == 0)
            else:
                model.Add(sum(assignment_vars) == option_var)

    actions_by_machine = defaultdict(list)
    for action in actions:
        for machine_id in action["eligible_machine_ids"]:
            actions_by_machine[machine_id].append(action)

    machine_items = actions_by_machine.items()
    if show_progress:
        machine_items = tqdm(
            machine_items,
            total=len(actions_by_machine),
            desc="Machine constraints",
            unit="machine",
        )

    for machine_id, machine_actions in machine_items:
        for i in range(len(machine_actions)):
            for j in range(i + 1, len(machine_actions)):
                a, b = machine_actions[i], machine_actions[j]

                if a["option_id"] == b["option_id"] and a["field_id"] == b["field_id"]:
                    continue

                if machine_pair_incompatible(fields, a, b):
                    va = machine_assignments[(a["action_key"], machine_id)]
                    vb = machine_assignments[(b["action_key"], machine_id)]
                    model.Add(va + vb <= 1)

    if actions:
        time_step = pd.Timedelta(hours=float(CONFIG["candidate_generation"]["time_step_hours"]))
        horizon_start = min(action["start_time"] for action in actions).floor("h")
        horizon_end = max(action["end_time"] for action in actions).ceil("h")
        t = horizon_start

        while t < horizon_end:
            labour_rows = data["labour"][data["labour"]["date"] == t.date()]
            capacity = 0

            if not labour_rows.empty:
                row = labour_rows.iloc[0]
                start = parse_time(t.date(), row["workday_start"])
                end = parse_time(t.date(), row["workday_end"])
                if start <= t < end:
                    capacity = int(row["available_workers"])

            terms = [
                int(action["workers_required"]) * option_vars[action["option_id"]]
                for action in actions
                if action["start_time"] <= t < action["end_time"]
            ]

            if terms:
                model.Add(sum(terms) <= capacity)

            t += time_step

    for date, water_row in data["water"].set_index("date").iterrows():
        terms = []

        for action in actions:
            if action["start_time"].date() == date and float(action.get("water_ml", 0.0)) > 0:
                water_scaled = int(round(float(action["water_ml"]) * 1000))
                terms.append(water_scaled * option_vars[action["option_id"]])

        if terms:
            available_scaled = int(round(float(water_row["available_water_ml"]) * 1000))
            delivery_scaled = int(round(float(water_row["max_delivery_ml_per_day"]) * 1000))
            model.Add(sum(terms) <= min(available_scaled, delivery_scaled))

    objective_scale = int(CONFIG["global_optimization"]["objective_scale"])
    model.Maximize(
        sum(
            int(round(float(option["objective_value_aud"]) * objective_scale))
            * option_vars[option["option_id"]]
            for option in options
        )
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(
        max_solver_seconds
        if max_solver_seconds is not None
        else CONFIG["global_optimization"]["max_solver_seconds"]
    )

    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError("No feasible whole-farm schedule found")

    selected_options = {
        option["option_id"]
        for option in options
        if solver.Value(option_vars[option["option_id"]]) == 1
    }

    rows = []

    for action in actions:
        if action["option_id"] not in selected_options:
            continue

        assigned_machine = ""

        for machine_id in action["eligible_machine_ids"]:
            if solver.Value(machine_assignments[(action["action_key"], machine_id)]) == 1:
                assigned_machine = machine_id
                break

        rows.append({
            "option_id": action["option_id"],
            "candidate_id": action["candidate_id"],
            "plan_id": action["plan_id"],
            "field_id": action["field_id"],
            "operation": action["operation"],
            "target": action["target"],
            "start_time": action["start_time"],
            "end_time": action["end_time"],
            "machine_id": assigned_machine,
            "workers_required": int(action["workers_required"]),
            "water_ml": float(action.get("water_ml", 0.0)),
            "direct_revenue_aud": float(action["direct_revenue_aud"]),
            "direct_cost_aud": float(action["direct_cost_aud"]),
            "direct_cash_effect_aud": float(action["direct_cash_effect_aud"]),
            "state_yield_effect_t_ha": float(action["state_yield_effect_t_ha"]),
        })

    schedule = pd.DataFrame(rows)
    if not schedule.empty:
        schedule = schedule.sort_values("start_time").reset_index(drop=True)

    selected_option_objects = [
        option for option in options
        if option["option_id"] in selected_options
    ]

    selected_option_summary = [
        {
            "option_id": option["option_id"],
            "field_id": option["field_id"],
            "direct_cash_effect_aud": round(float(option["total_direct_cash_effect_aud"]), 2),
            "terminal_value_aud": round(float(option["terminal_value_aud"]), 2),
            "objective_value_aud": round(float(option["objective_value_aud"]), 2),
        }
        for option in selected_option_objects
    ]

    summary = {
        "status": "optimal" if status == cp_model.OPTIMAL else "feasible",
        "total_direct_cash_effect_aud": round(
            sum(x["direct_cash_effect_aud"] for x in selected_option_summary), 2
        ),
        "total_terminal_value_aud": round(
            sum(x["terminal_value_aud"] for x in selected_option_summary), 2
        ),
        "total_objective_value_aud": round(
            sum(x["objective_value_aud"] for x in selected_option_summary), 2
        ),
        "num_scheduled_actions": len(schedule),
        "selected_options": selected_option_summary,
    }

    return schedule, summary


def save_results(schedule, summary, schedule_path=SCHEDULE_PATH, summary_path=SUMMARY_PATH):
    schedule_path = Path(schedule_path)
    summary_path = Path(summary_path)
    schedule_path.parent.mkdir(parents=True, exist_ok=True)

    schedule.to_csv(schedule_path, index=False)

    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


if __name__ == "__main__":
    options = load_field_options()
    schedule, summary = optimize_schedule(options)
    save_results(schedule, summary)

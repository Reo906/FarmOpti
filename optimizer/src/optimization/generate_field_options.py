from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd
from tqdm.auto import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from optimization.generate_candidates import CONFIG, EXTERNAL_DIR, OPTIMIZER_ROOT, generate_candidates, load_external_variables
from optimization.simulate_field import FieldSimulator


OUTPUT_JSON = OPTIMIZER_ROOT / "outputs" / "field_options.json"


def _to_timestamp(value):
    return pd.Timestamp(value)


def _overlap(a, b):
    a_start, a_end = _to_timestamp(a["start_time"]), _to_timestamp(a["end_time"])
    b_start, b_end = _to_timestamp(b["start_time"]), _to_timestamp(b["end_time"])
    return a_start < b_end and b_start < a_end


def _candidate_subset(candidates, cfg):
    if candidates.empty:
        return candidates

    candidates = candidates.copy()
    candidates["start_time"] = pd.to_datetime(candidates["start_time"])
    candidates["date"] = candidates["start_time"].dt.date
    per_day = int(cfg["max_candidates_per_plan_per_day"])
    max_total = int(cfg["max_candidates_per_plan"])

    candidates = candidates.sort_values(["candidate_score", "start_time"], ascending=[False, True])
    candidates = candidates.groupby("date", group_keys=False).head(per_day)
    candidates = candidates.sort_values(["candidate_score", "start_time"], ascending=[False, True]).head(max_total)
    return candidates.drop(columns=["date"])


def _topological_plan_order(plans):
    plans = plans.copy()
    plan_ids = set(plans["plan_id"].astype(str))
    deps = {}

    for _, row in plans.iterrows():
        plan_id = str(row["plan_id"])
        dep = str(row["depends_on"]).strip() if pd.notna(row["depends_on"]) else ""
        deps[plan_id] = dep if dep in plan_ids else ""

    ordered = []
    remaining = set(plan_ids)

    while remaining:
        ready = [pid for pid in remaining if not deps[pid] or deps[pid] in ordered]
        if not ready:
            raise ValueError(f"Cyclic management-plan dependency in field {plans.iloc[0]['field_id']}")

        ready.sort(key=lambda pid: (plans.loc[plans["plan_id"].astype(str) == pid, "allowed_from"].iloc[0], pid))
        for pid in ready:
            ordered.append(pid)
            remaining.remove(pid)

    return ordered


def _normalize_candidate(row):
    out = row.to_dict() if isinstance(row, pd.Series) else dict(row)
    out["start_time"] = pd.Timestamp(out["start_time"])
    out["end_time"] = pd.Timestamp(out["end_time"])

    machines = out.get("eligible_machine_ids", "")
    if isinstance(machines, str):
        out["eligible_machine_ids"] = [x for x in machines.split(",") if x]
    elif not isinstance(machines, list):
        out["eligible_machine_ids"] = list(machines)

    return out


def _repeat_spacing_ok(choice, plan, selected, plan_map):
    if pd.notna(plan["depends_on"]) and str(plan["depends_on"]).strip():
        return True

    gap = float(plan["min_gap_hours"]) if pd.notna(plan["min_gap_hours"]) else 0.0
    if gap <= 0:
        return True

    for other_plan_id, other in selected.items():
        if other is None:
            continue

        other_plan = plan_map[other_plan_id]
        if str(other_plan["operation"]).lower() != str(plan["operation"]).lower():
            continue

        a_start, a_end = pd.Timestamp(choice["start_time"]), pd.Timestamp(choice["end_time"])
        b_start, b_end = pd.Timestamp(other["start_time"]), pd.Timestamp(other["end_time"])

        if a_start >= b_end:
            actual_gap = (a_start - b_end).total_seconds() / 3600.0
        elif b_start >= a_end:
            actual_gap = (b_start - a_end).total_seconds() / 3600.0
        else:
            return False

        other_gap = float(other_plan["min_gap_hours"]) if pd.notna(other_plan["min_gap_hours"]) else 0.0
        if actual_gap < max(gap, other_gap):
            return False

    return True


def _simulate_selection(data, config, field_id, selected, plan_map, horizon_end):
    simulator = FieldSimulator(data, config, field_id)
    actions = sorted(selected.values(), key=lambda x: _to_timestamp(x["start_time"]))

    for i in range(1, len(actions)):
        if _overlap(actions[i - 1], actions[i]):
            return None

    completion = {}
    dynamic_actions = []
    total_direct_cash = 0.0

    for candidate in actions:
        plan_id = str(candidate["plan_id"])
        plan = plan_map[plan_id]
        dep = str(plan["depends_on"]).strip() if pd.notna(plan["depends_on"]) else ""

        if dep:
            if dep not in completion:
                return None

            min_gap = float(plan["min_gap_hours"]) if pd.notna(plan["min_gap_hours"]) else 0.0
            earliest = completion[dep] + pd.Timedelta(hours=min_gap)
            if _to_timestamp(candidate["start_time"]) < earliest:
                return None

        dynamic = simulator.evaluate_and_apply(candidate, plan)
        if dynamic is None:
            return None

        action = dict(candidate)
        action["direct_revenue_aud"] = dynamic["direct_revenue_aud"]
        action["direct_cost_aud"] = dynamic["direct_cost_aud"]
        action["direct_cash_effect_aud"] = dynamic["direct_cash_effect_aud"]
        action["state_yield_effect_t_ha"] = dynamic["state_yield_effect_t_ha"]
        action["state_after"] = dynamic["state_after"]

        dynamic_actions.append(action)
        total_direct_cash += dynamic["direct_cash_effect_aud"]
        completion[plan_id] = _to_timestamp(candidate["end_time"])

    terminal_value = simulator.terminal_value(horizon_end)
    objective_value = total_direct_cash + terminal_value

    return {
        "total_direct_cash_effect_aud": round(total_direct_cash, 2),
        "terminal_value_aud": round(terminal_value, 2),
        "objective_value_aud": round(objective_value, 2),
        "actions": dynamic_actions,
        "final_state": simulator.snapshot(),
    }


def optional_signature(state, plan_map):
    return tuple(sorted(plan_id for plan_id, candidate in state["selected"].items() if candidate is not None and not bool(plan_map[plan_id]["required"])))


def keep_diverse_beam(states, limit, plan_map):
    states = sorted(states, key=lambda x: x["score"], reverse=True)
    kept, kept_ids, signatures = [], set(), set()

    for state in states:
        signature = optional_signature(state, plan_map)
        if signature not in signatures:
            kept.append(state)
            kept_ids.add(id(state))
            signatures.add(signature)
        if len(kept) >= limit:
            return kept[:limit]

    for state in states:
        if len(kept) >= limit:
            break
        if id(state) not in kept_ids:
            kept.append(state)
            kept_ids.add(id(state))

    return kept[:limit]


def option_signature(simulation, plan_map):
    return tuple(sorted(str(action["plan_id"]) for action in simulation["actions"] if not bool(plan_map[str(action["plan_id"])]["required"])))


def keep_diverse_options(options, limit, plan_map):
    options = sorted(options, key=lambda x: x["objective_value_aud"], reverse=True)
    kept, kept_ids, signatures = [], set(), set()

    for option in options:
        signature = option_signature(option, plan_map)
        if signature not in signatures:
            kept.append(option)
            kept_ids.add(id(option))
            signatures.add(signature)
        if len(kept) >= limit:
            return kept[:limit]

    for option in options:
        if len(kept) >= limit:
            break
        if id(option) not in kept_ids:
            kept.append(option)
            kept_ids.add(id(option))

    return kept[:limit]


def generate_field_options(external_variables_dir=EXTERNAL_DIR):
    data = load_external_variables(external_variables_dir)
    candidates = generate_candidates(external_variables_dir)

    if candidates.empty:
        return []

    candidates["plan_id"] = candidates["plan_id"].astype(str)
    candidates["start_time"] = pd.to_datetime(candidates["start_time"])
    candidates["end_time"] = pd.to_datetime(candidates["end_time"])

    cfg = CONFIG["field_option_generation"]
    beam_width = int(cfg["beam_width"])
    max_options = int(cfg["max_options_per_field"])
    all_options = []
    field_groups = list(data["management"].groupby("field_id"))
    horizon_end = pd.Timestamp(data["management"]["allowed_to"].max()) + pd.Timedelta(hours=23, minutes=59)

    for field_id, field_plans in tqdm(field_groups, desc="Generating field options", unit="field"):
        field_plans = field_plans.copy()
        field_plans["plan_id"] = field_plans["plan_id"].astype(str)
        plan_map = {str(row["plan_id"]): row for _, row in field_plans.iterrows()}
        plan_order = _topological_plan_order(field_plans)
        beam = [{"selected": {}, "score": 0.0, "simulation": None}]

        plan_progress = tqdm(plan_order, desc=f"  {field_id}", unit="plan", leave=False)

        for plan_id in plan_progress:
            plan = plan_map[plan_id]
            plan_candidates = _candidate_subset(candidates[candidates["plan_id"] == plan_id], cfg)
            choices = [None] if not bool(plan["required"]) else []
            choices += [_normalize_candidate(row) for _, row in plan_candidates.iterrows()]

            if bool(plan["required"]) and not choices:
                beam = []
                break

            next_beam = []

            for state in tqdm(beam, desc=f"    {plan_id} beam", unit="state", leave=False):
                for choice in choices:
                    selected = dict(state["selected"])

                    if choice is None:
                        selected[plan_id] = None
                    else:
                        dep = str(plan["depends_on"]).strip() if pd.notna(plan["depends_on"]) else ""

                        if dep:
                            dep_choice = selected.get(dep)
                            if dep_choice is None:
                                continue

                            min_gap = float(plan["min_gap_hours"]) if pd.notna(plan["min_gap_hours"]) else 0.0
                            if choice["start_time"] < dep_choice["end_time"] + pd.Timedelta(hours=min_gap):
                                continue

                        if any(existing is not None and _overlap(existing, choice) for existing in selected.values()):
                            continue

                        if not _repeat_spacing_ok(choice, plan, selected, plan_map):
                            continue

                        selected[plan_id] = choice

                    chosen = {pid: value for pid, value in selected.items() if value is not None}
                    simulation = _simulate_selection(data, CONFIG, field_id, chosen, plan_map, horizon_end)

                    if simulation is not None:
                        next_beam.append({
                            "selected": selected,
                            "score": simulation["objective_value_aud"],
                            "simulation": simulation,
                        })

            dedup = {}
            for state in next_beam:
                key = tuple(sorted((pid, value["candidate_id"] if value is not None else "") for pid, value in state["selected"].items()))
                if key not in dedup or state["score"] > dedup[key]["score"]:
                    dedup[key] = state

            beam = keep_diverse_beam(list(dedup.values()), beam_width, plan_map)
            plan_progress.set_postfix(beam=len(beam), candidates=len(plan_candidates))

        valid = []

        for state in beam:
            if any(bool(plan_map[pid]["required"]) and state["selected"].get(pid) is None for pid in plan_order):
                continue

            chosen = {pid: value for pid, value in state["selected"].items() if value is not None}
            simulation = _simulate_selection(data, CONFIG, field_id, chosen, plan_map, horizon_end)
            if simulation is not None:
                valid.append(simulation)

        valid = keep_diverse_options(valid, max_options, plan_map)
        seen = set()
        rank = 1

        for simulation in valid:
            key = tuple(action["candidate_id"] for action in simulation["actions"])
            if key in seen:
                continue

            seen.add(key)
            all_options.append({
                "option_id": f"{field_id}_O{rank:03d}",
                "field_id": str(field_id),
                "total_direct_cash_effect_aud": simulation["total_direct_cash_effect_aud"],
                "terminal_value_aud": simulation["terminal_value_aud"],
                "objective_value_aud": simulation["objective_value_aud"],
                "actions": simulation["actions"],
                "final_state": simulation["final_state"],
            })
            rank += 1

            if rank > max_options:
                break

    return all_options


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


def save_field_options(options, path=OUTPUT_JSON):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(_json_safe({"options": options}), f, indent=2)


if __name__ == "__main__":
    options = generate_field_options()
    save_field_options(options)

from __future__ import annotations

import math
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yaml
from tqdm.auto import tqdm


OPTIMIZER_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = OPTIMIZER_ROOT / "config.yaml"
EXTERNAL_DIR = OPTIMIZER_ROOT / "external_variables"
OUTPUT_PATH = OPTIMIZER_ROOT / "outputs" / "candidate_actions.csv"


def load_config(path=CONFIG_PATH):
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CONFIG = load_config()
RULES = CONFIG["operations"]
CROP_PARAMETERS = CONFIG["crop_parameters"]
CANDIDATE_CONFIG = CONFIG["candidate_generation"]


def load_external_variables(folder=EXTERNAL_DIR):
    folder = Path(folder)
    data = {
        "fields": pd.read_csv(folder / "fields.csv"),
        "state": pd.read_csv(folder / "field_state_daily.csv"),
        "weather": pd.read_csv(folder / "weather_hourly.csv"),
        "labour": pd.read_csv(folder / "labour_availability_daily.csv"),
        "machines": pd.read_csv(folder / "machines.csv"),
        "machine_availability": pd.read_csv(folder / "machine_availability_daily.csv"),
        "water": pd.read_csv(folder / "water_availability_daily.csv"),
        "economics": pd.read_csv(folder / "economics_daily.csv"),
        "management": pd.read_csv(folder / "management_plan.csv"),
    }

    data["state"]["date"] = pd.to_datetime(data["state"]["date"]).dt.date
    data["weather"]["time"] = pd.to_datetime(data["weather"]["time"])
    data["labour"]["date"] = pd.to_datetime(data["labour"]["date"]).dt.date
    data["machine_availability"]["date"] = pd.to_datetime(data["machine_availability"]["date"]).dt.date
    data["water"]["date"] = pd.to_datetime(data["water"]["date"]).dt.date
    data["economics"]["date"] = pd.to_datetime(data["economics"]["date"]).dt.date
    data["management"]["allowed_from"] = pd.to_datetime(data["management"]["allowed_from"]).dt.date
    data["management"]["allowed_to"] = pd.to_datetime(data["management"]["allowed_to"]).dt.date
    return data


def get_field(data, field_id):
    rows = data["fields"][data["fields"]["field_id"] == field_id]
    if rows.empty:
        raise ValueError(f"Unknown field: {field_id}")
    return rows.iloc[0]


def get_effective_crop(field):
    current_crop = str(field["current_crop"]).strip().lower()
    if current_crop not in ("", "none", "nan"):
        return current_crop

    planned_crop = str(field["planned_crop"]).strip().lower()
    if planned_crop not in ("", "none", "nan"):
        return planned_crop

    raise ValueError(f"Field {field['field_id']} has no current or planned crop")


def get_field_state(data, field_id, date):
    rows = data["state"][(data["state"]["field_id"] == field_id) & (data["state"]["date"] == date)]
    return None if rows.empty else rows.iloc[0]


def get_weather_window(data, start, duration_hours):
    end = start + pd.Timedelta(hours=duration_hours)
    return data["weather"][(data["weather"]["time"] >= start.floor("h")) & (data["weather"]["time"] < end.ceil("h"))]


def get_economic_value(data, date, variable_type, item):
    rows = data["economics"][(data["economics"]["date"] == date) & (data["economics"]["variable_type"] == variable_type) & (data["economics"]["item"] == item)]
    if rows.empty:
        raise ValueError(f"Missing economic value: {variable_type}/{item} on {date}")
    return float(rows.iloc[0]["value"])


def get_labour_for_day(data, date):
    rows = data["labour"][data["labour"]["date"] == date]
    return None if rows.empty else rows.iloc[0]


def parse_time(date, value):
    t = datetime.strptime(str(value), "%H:%M").time()
    return pd.Timestamp.combine(date, t)


def get_eligible_machines(data, machine_type, start, end):
    machines = data["machines"][data["machines"]["machine_type"] == machine_type]
    eligible = []

    for _, machine in machines.iterrows():
        machine_id = machine["machine_id"]
        rows = data["machine_availability"][(data["machine_availability"]["machine_id"] == machine_id) & (data["machine_availability"]["date"] == start.date())]
        if rows.empty:
            continue

        availability = rows.iloc[0]
        if int(availability["available"]) != 1:
            continue
        if pd.isna(availability["available_from"]) or pd.isna(availability["available_to"]):
            continue

        available_from = parse_time(start.date(), availability["available_from"])
        available_to = parse_time(start.date(), availability["available_to"])
        if start >= available_from and end <= available_to:
            eligible.append(machine_id)

    return eligible


def get_machine_cost_per_hour(data, machine_ids):
    rows = data["machines"][data["machines"]["machine_id"].isin(machine_ids)]
    if rows.empty:
        raise ValueError(f"No machines found for {machine_ids}")
    return float(rows["cost_per_hour_aud"].mean())


def calculate_execution_cost(data, rule, start, duration, machine_ids):
    machine_cost = duration * get_machine_cost_per_hour(data, machine_ids)
    labour_rate = get_economic_value(data, start.date(), "labour_cost", "worker")
    labour_cost = duration * int(rule["workers"]) * labour_rate
    return machine_cost + labour_cost


def make_result(direct_revenue, direct_cost, state_yield_effect=0.0, water_ml=0.0, candidate_score=0.0):
    return {
        "direct_revenue_aud": round(float(direct_revenue), 2),
        "direct_cost_aud": round(float(direct_cost), 2),
        "direct_cash_effect_aud": round(float(direct_revenue) - float(direct_cost), 2),
        "state_yield_effect_t_ha": round(float(state_yield_effect), 4),
        "water_ml": round(float(water_ml), 3),
        "candidate_score": round(float(candidate_score), 6),
    }


def evaluate_harvest(data, plan, field, state, weather, start, duration, machine_ids):
    rule = RULES["harvest"]
    feasibility = rule["feasibility"]

    if float(state["readiness"]) < feasibility["min_readiness"]:
        return None
    if weather.empty or weather["rain_mm"].max() > feasibility["max_rain_mm_per_hour"] or weather["wind_kmh"].max() > feasibility["max_wind_kmh"]:
        return None

    area = float(field["area_ha"])
    crop = get_effective_crop(field)
    expected_yield = float(state["expected_yield_t_ha"])
    price = get_economic_value(data, start.date(), "crop_price", crop)
    revenue = area * expected_yield * price
    cost = calculate_execution_cost(data, rule, start, duration, machine_ids)
    return make_result(revenue, cost, candidate_score=revenue - cost)


def evaluate_irrigation(data, plan, field, state, weather, start, duration, machine_ids):
    rule = RULES["irrigate"]
    response = rule["response"]

    if int(field["irrigable"]) != 1:
        return None
    if weather.empty or weather["rain_mm"].max() > rule["feasibility"]["max_rain_mm_per_hour"]:
        return None

    target = float(plan["amount"]) if pd.notna(plan["amount"]) else float(response["default_target_soil_moisture"])
    current = float(state["soil_moisture"])
    if current >= target:
        return None

    area = float(field["area_ha"])
    crop = get_effective_crop(field)
    expected_yield = float(state["expected_yield_t_ha"])
    if expected_yield <= 0 and crop in CROP_PARAMETERS:
        expected_yield = float(CROP_PARAMETERS[crop]["potential_yield_t_per_ha"])

    deficit = max(0.0, min(1.0, (target - current) / target))
    yield_effect = expected_yield * deficit * response["max_yield_loss_fraction"]
    water_ml = area * response["water_ml_per_ha"]

    water_rows = data["water"][data["water"]["date"] == start.date()]
    if water_rows.empty:
        return None

    water_state = water_rows.iloc[0]
    if water_ml > float(water_state["available_water_ml"]) or water_ml > float(water_state["max_delivery_ml_per_day"]):
        return None

    water_price = get_economic_value(data, start.date(), "water_cost", "irrigation_water")
    cost = calculate_execution_cost(data, rule, start, duration, machine_ids) + water_ml * water_price
    return make_result(0.0, cost, yield_effect, water_ml, yield_effect)


def evaluate_spray(data, plan, field, state, weather, start, duration, machine_ids):
    rule = RULES["spray"]
    response = rule["response"]
    feasibility = rule["feasibility"]

    if weather.empty or weather["rain_mm"].max() > feasibility["max_rain_mm_per_hour"] or weather["wind_kmh"].max() > feasibility["max_wind_kmh"]:
        return None

    target = str(plan["target"])
    target_cfg = response["targets"].get(target)
    if target_cfg is None:
        raise ValueError(f"Unknown spray target: {target}")

    pressure = float(state[target_cfg["state_variable"]])
    if pressure <= 0:
        return None

    area = float(field["area_ha"])
    expected_yield = float(state["expected_yield_t_ha"])
    yield_effect = expected_yield * pressure * response["max_yield_loss_fraction"] * response["efficacy"]

    chemical_price = get_economic_value(data, start.date(), "input_cost", target_cfg["chemical"])
    chemical_cost = area * response["chemical_l_per_ha"] * chemical_price
    cost = calculate_execution_cost(data, rule, start, duration, machine_ids) + chemical_cost
    return make_result(0.0, cost, yield_effect, candidate_score=yield_effect)


def evaluate_fertiliser(data, plan, field, state, weather, start, duration, machine_ids):
    rule = RULES["fertilise"]
    response = rule["response"]
    feasibility = rule["feasibility"]

    if weather.empty or weather["rain_mm"].max() > feasibility["max_rain_mm_per_hour"] or weather["wind_kmh"].max() > feasibility["max_wind_kmh"]:
        return None

    current_n = float(state["nitrogen_index"])
    target_n = float(response["target_nitrogen_index"])
    if current_n >= target_n:
        return None
    if pd.isna(plan["amount"]):
        raise ValueError("Fertilisation requires an amount")

    amount = float(plan["amount"])
    deficit = max(0.0, min(1.0, (target_n - current_n) / target_n))
    dose_response = 1.0 - math.exp(-amount / response["response_scale_kg_per_ha"])
    expected_yield = float(state["expected_yield_t_ha"])
    yield_effect = expected_yield * deficit * response["max_yield_gain_fraction"] * dose_response

    area = float(field["area_ha"])
    fertiliser_price = get_economic_value(data, start.date(), "input_cost", response["fertiliser_item"])
    fertiliser_cost = amount * area * fertiliser_price
    cost = calculate_execution_cost(data, rule, start, duration, machine_ids) + fertiliser_cost
    return make_result(0.0, cost, yield_effect, candidate_score=yield_effect)


def evaluate_planting(data, plan, field, state, weather, start, duration, machine_ids):
    rule = RULES["plant"]
    response = rule["response"]
    feasibility = rule["feasibility"]

    if weather.empty or weather["rain_mm"].max() > feasibility["max_rain_mm_per_hour"] or weather["wind_kmh"].max() > feasibility["max_wind_kmh"]:
        return None
    if float(state["seedbed_readiness"]) < feasibility["min_seedbed_readiness"] or float(state["soil_temperature_c"]) < feasibility["min_soil_temperature_c"]:
        return None

    crop = str(plan["target"]).strip().lower()
    if crop not in CROP_PARAMETERS:
        raise ValueError(f"No crop parameters configured for {crop}")

    area = float(field["area_ha"])
    seedbed = float(state["seedbed_readiness"])
    moisture = float(state["soil_moisture"])
    temperature = float(state["soil_temperature_c"])

    moisture_score = max(0.0, min(1.0, 1.0 - abs(moisture - float(response["ideal_soil_moisture"])) / float(response["soil_moisture_tolerance"])))
    temperature_score = min(1.0, temperature / float(response["ideal_soil_temperature_c"]))
    suitability = max(0.0, min(1.0, seedbed * moisture_score * temperature_score))
    projected_yield = float(CROP_PARAMETERS[crop]["potential_yield_t_per_ha"]) * suitability

    seed_price = get_economic_value(data, start.date(), "input_cost", f"{crop}_seed")
    seed_cost = area * response["seed_rate_kg_per_ha"] * seed_price
    cost = calculate_execution_cost(data, rule, start, duration, machine_ids) + seed_cost
    return make_result(0.0, cost, projected_yield, candidate_score=projected_yield)


EVALUATORS = {
    "harvest": evaluate_harvest,
    "irrigate": evaluate_irrigation,
    "spray": evaluate_spray,
    "fertilise": evaluate_fertiliser,
    "plant": evaluate_planting,
}


def generate_candidates(external_variables_dir=EXTERNAL_DIR):
    data = load_external_variables(external_variables_dir)
    candidates = []
    time_step = pd.Timedelta(hours=float(CANDIDATE_CONFIG["time_step_hours"]))
    config_start_hour = int(CANDIDATE_CONFIG["workday_start_hour"])
    config_end_hour = int(CANDIDATE_CONFIG["workday_end_hour"])

    iterator = tqdm(data["management"].iterrows(), total=len(data["management"]), desc="Generating candidates", unit="plan")

    for _, plan in iterator:
        plan_id = str(plan["plan_id"])
        field_id = str(plan["field_id"])
        operation = str(plan["operation"]).lower()

        if operation not in RULES:
            raise ValueError(f"Unsupported operation: {operation}")

        field = get_field(data, field_id)
        rule = RULES[operation]
        duration = float(field["area_ha"]) / float(rule["work_rate_ha_per_hour"])
        current_date = plan["allowed_from"]

        while current_date <= plan["allowed_to"]:
            state = get_field_state(data, field_id, current_date)
            labour = get_labour_for_day(data, current_date)

            if state is None or labour is None or int(labour["available_workers"]) < int(rule["workers"]):
                current_date += timedelta(days=1)
                continue

            day = pd.Timestamp(datetime.combine(current_date, datetime.min.time()))
            day_start = max(day + pd.Timedelta(hours=config_start_hour), parse_time(current_date, labour["workday_start"]))
            day_end = min(day + pd.Timedelta(hours=config_end_hour), parse_time(current_date, labour["workday_end"]))
            start = day_start

            while start + pd.Timedelta(hours=duration) <= day_end:
                end = start + pd.Timedelta(hours=duration)
                machine_ids = get_eligible_machines(data, rule["machine_type"], start, end)

                if machine_ids:
                    weather = get_weather_window(data, start, duration)
                    if not weather.empty:
                        action_result = EVALUATORS[operation](data, plan, field, state, weather, start, duration, machine_ids)
                        if action_result is not None:
                            candidates.append({
                                "candidate_id": f"{plan_id}_{field_id}_{operation}_{start:%Y%m%d_%H%M}",
                                "plan_id": plan_id,
                                "field_id": field_id,
                                "operation": operation,
                                "target": plan["target"],
                                "required": bool(plan["required"]),
                                "depends_on": plan["depends_on"] if pd.notna(plan["depends_on"]) else "",
                                "min_gap_hours": float(plan["min_gap_hours"]) if pd.notna(plan["min_gap_hours"]) else 0.0,
                                "start_time": start,
                                "end_time": end,
                                "duration_hours": round(duration, 2),
                                "machine_type": rule["machine_type"],
                                "eligible_machine_ids": ",".join(machine_ids),
                                "workers_required": int(rule["workers"]),
                                **action_result,
                            })

                start += time_step

            current_date += timedelta(days=1)

    candidates = pd.DataFrame(candidates)
    if not candidates.empty:
        candidates = candidates.sort_values(["plan_id", "start_time"]).reset_index(drop=True)
    return candidates


if __name__ == "__main__":
    candidates = generate_candidates()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    candidates.to_csv(OUTPUT_PATH, index=False)

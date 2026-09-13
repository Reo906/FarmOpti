from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import yaml

SPRAY_TARGET_TO_PLAN = {
    "weed": "weed_control",
    "pest": "pest_control",
    "disease": "disease_control",
    "weed_control": "weed_control",
    "pest_control": "pest_control",
    "disease_control": "disease_control",
}

SPRAY_PLAN_TO_PRESSURE = {
    "weed_control": "weed_pressure",
    "pest_control": "pest_pressure",
    "disease_control": "disease_pressure",
}


def load_simulator_config(config_path: str | Path) -> dict[str, Any]:
    with open(config_path, encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def clip(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def normalize_spray_target(raw: str | None) -> str:
    key = str(raw or "").strip().lower()
    return SPRAY_TARGET_TO_PLAN.get(key, key)


def spray_pressure_key(raw: str | None) -> str | None:
    return SPRAY_PLAN_TO_PRESSURE.get(normalize_spray_target(raw))


def generic_next_moisture(moisture: float, target: float) -> float | None:
    if moisture >= target:
        return None
    return max(moisture, target)


def generic_irrigate_yield_effect(
    moisture: float,
    target: float,
    expected_yield: float,
    max_yield_loss_fraction: float,
) -> float:
    deficit = clip((target - moisture) / target, 0.0, 1.0)
    return expected_yield * deficit * max_yield_loss_fraction


def generic_next_nitrogen(current_n: float, target_n: float, amount: float, response_scale: float) -> float | None:
    if current_n >= target_n or not amount:
        return None
    dose_response = 1.0 - math.exp(-amount / response_scale)
    return min(1.0, current_n + (target_n - current_n) * dose_response)


def generic_fertilise_yield_effect(
    current_n: float,
    target_n: float,
    amount: float,
    expected_yield: float,
    max_yield_gain_fraction: float,
    response_scale: float,
) -> float:
    deficit = clip((target_n - current_n) / target_n, 0.0, 1.0)
    dose_response = 1.0 - math.exp(-amount / response_scale)
    return expected_yield * deficit * max_yield_gain_fraction * dose_response


def generic_next_pressure(pressure: float, efficacy: float) -> float | None:
    if pressure <= 0:
        return None
    return pressure * (1.0 - efficacy)


def generic_spray_yield_effect(
    pressure: float,
    expected_yield: float,
    max_yield_loss_fraction: float,
    efficacy: float,
) -> float:
    return expected_yield * pressure * max_yield_loss_fraction * efficacy


def default_fertiliser_amount(config: dict[str, Any]) -> float:
    return float(config.get("operations", {}).get("fertilise", {}).get("response", {}).get("response_scale_kg_per_ha", 60.0))


def irrigate_target(config: dict[str, Any]) -> float:
    return float(
        config.get("operations", {}).get("irrigate", {}).get("response", {}).get("default_target_soil_moisture", 0.25)
    )


def apply_generic_operation(state: dict[str, Any], operation: str, row: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Apply the same numeric transition used by FieldSimulator.eval*."""
    next_state = dict(state)
    operations = config.get("operations", {})
    crop_params = config.get("crop_parameters", {})
    operation = operation.lower()

    if operation == "plant":
        crop = str(row.get("next_crop") or row.get("crop") or "").strip().lower()
        next_state["crop"] = crop
        next_state["planted"] = True
        next_state["growth_stage"] = "planted"
        seedbed = float(state.get("seedbed_readiness", 0.8))
        moisture = float(state.get("soil_moisture", 0.0))
        temperature = float(state.get("soil_temperature_c", 16.0))
        response = operations.get("plant", {}).get("response", {})
        ideal_moisture = float(response.get("ideal_soil_moisture", 0.24))
        tolerance = float(response.get("soil_moisture_tolerance", 0.10))
        ideal_temperature = float(response.get("ideal_soil_temperature_c", 18.0))
        moisture_score = clip(1.0 - abs(moisture - ideal_moisture) / tolerance, 0.0, 1.0)
        temperature_score = min(1.0, temperature / ideal_temperature)
        suitability = clip(seedbed * moisture_score * temperature_score, 0.0, 1.0)
        potential = float(crop_params.get(crop, {}).get("potential_yield_t_per_ha", 0.0))
        next_state["expected_yield_t_ha"] = potential * suitability
        return next_state

    if operation == "irrigate":
        response = operations.get("irrigate", {}).get("response", {})
        target = irrigate_target(config)
        moisture = float(state["soil_moisture"])
        generic = generic_next_moisture(moisture, target)
        next_state["soil_moisture"] = moisture if generic is None else generic
        expected = float(state.get("expected_yield_t_ha") or 0.0)
        if expected <= 0:
            crop = str(state.get("crop") or "").strip().lower()
            expected = float(crop_params.get(crop, {}).get("potential_yield_t_per_ha", 0.0))
        next_state["expected_yield_t_ha"] = expected + generic_irrigate_yield_effect(
            moisture,
            target,
            expected,
            float(response.get("max_yield_loss_fraction", 0.2)),
        )
        return next_state

    if operation == "fertilise":
        response = operations.get("fertilise", {}).get("response", {})
        current_n = float(state["nitrogen_index"])
        target_n = float(response.get("target_nitrogen_index", 0.75))
        amount = default_fertiliser_amount(config)
        generic = generic_next_nitrogen(current_n, target_n, amount, float(response.get("response_scale_kg_per_ha", 60.0)))
        next_state["nitrogen_index"] = current_n if generic is None else generic
        expected = float(state.get("expected_yield_t_ha") or 0.0)
        next_state["expected_yield_t_ha"] = expected + generic_fertilise_yield_effect(
            current_n,
            target_n,
            amount,
            expected,
            float(response.get("max_yield_gain_fraction", 0.18)),
            float(response.get("response_scale_kg_per_ha", 60.0)),
        )
        return next_state

    if operation == "spray":
        response = operations.get("spray", {}).get("response", {})
        pressure_key = spray_pressure_key(row.get("spray_target"))
        if pressure_key is None:
            return next_state
        pressure = max(0.0, float(state.get(pressure_key, 0.0)))
        efficacy = float(response.get("efficacy", 0.9))
        generic = generic_next_pressure(pressure, efficacy)
        next_state[pressure_key] = pressure if generic is None else generic
        expected = float(state.get("expected_yield_t_ha") or 0.0)
        next_state["expected_yield_t_ha"] = expected + generic_spray_yield_effect(
            pressure,
            expected,
            float(response.get("max_yield_loss_fraction", 0.25)),
            efficacy,
        )
        return next_state

    if operation == "harvest":
        next_state["crop"] = ""
        next_state["planted"] = False
        next_state["harvested"] = True
        next_state["expected_yield_t_ha"] = 0.0
        return next_state

    return next_state

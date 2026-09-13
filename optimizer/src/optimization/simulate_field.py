from __future__ import annotations

import math

import pandas as pd

from optimization.generate_candidates import CROP_PARAMETERS, RULES, get_economic_value, get_field


TRACKED_STATE = [
    "readiness",
    "soil_moisture",
    "soil_temperature_c",
    "expected_yield_t_ha",
    "nitrogen_index",
    "weed_pressure",
    "pest_pressure",
    "disease_pressure",
    "seedbed_readiness",
]


class FieldSimulator:
    def __init__(self, data, config, field_id):
        self.data = data
        self.config = config
        self.field_id = field_id
        self.field = get_field(data, field_id)
        self.baseline = data["state"][data["state"]["field_id"] == field_id].sort_values("date").copy()

        if self.baseline.empty:
            raise ValueError(f"No field-state forecast for {field_id}")

        current_crop = str(self.field["current_crop"]).strip().lower()
        self.current_crop = None if current_crop in ("", "none", "nan") else current_crop
        self.planned_crop = str(self.field["planned_crop"]).strip().lower()
        self.planted = self.current_crop is not None
        self.newly_planted = False
        self.harvested = False
        self.current_date = None
        self.current_time = None
        self.state = {}
        self.residuals = {key: 0.0 for key in TRACKED_STATE}
        self.decay = config.get("state_simulation", {}).get("residual_decay_per_day", {})

    def _baseline_for(self, date):
        rows = self.baseline[self.baseline["date"] == date]
        if rows.empty:
            raise ValueError(f"No baseline state for {self.field_id} on {date}")
        return rows.iloc[0]

    def advance_to(self, timestamp):
        timestamp = pd.Timestamp(timestamp)
        date = timestamp.date()
        baseline = self._baseline_for(date)

        if self.current_date is None:
            self.state = {key: float(baseline[key]) for key in TRACKED_STATE}
            self.state["growth_stage"] = str(baseline["growth_stage"])
            self.current_date = date
            self.current_time = timestamp
            return

        if date == self.current_date:
            self.current_time = timestamp
            return

        days = (date - self.current_date).days
        if days < 0:
            raise ValueError("FieldSimulator cannot move backward in time")

        for key in TRACKED_STATE:
            factor = float(self.decay.get(key, 1.0)) ** days
            self.residuals[key] *= factor
            self.state[key] = float(baseline[key]) + self.residuals[key]

        if self.newly_planted:
            self.state["growth_stage"] = "planted"
        else:
            self.state["growth_stage"] = str(baseline["growth_stage"])

        self.current_date = date
        self.current_time = timestamp

    def _set_state(self, key, value):
        baseline = self._baseline_for(self.current_date)
        self.state[key] = float(value)
        self.residuals[key] = float(value) - float(baseline[key])

    def _potential_yield(self):
        if self.current_crop in CROP_PARAMETERS:
            return float(CROP_PARAMETERS[self.current_crop]["potential_yield_t_per_ha"])
        return max(0.0, float(self.state.get("expected_yield_t_ha", 0.0)))

    def _increase_yield(self, delta):
        current = float(self.state["expected_yield_t_ha"])
        cap = self._potential_yield()
        new_value = current + max(0.0, float(delta))
        if cap > 0:
            new_value = min(cap, new_value)
        self._set_state("expected_yield_t_ha", new_value)

    def _price(self, date, crop=None):
        crop = crop or self.current_crop
        if not crop:
            raise ValueError(f"No crop exists on {self.field_id}")
        return get_economic_value(self.data, date, "crop_price", crop)

    def evaluate_and_apply(self, candidate, plan):
        start = pd.Timestamp(candidate["start_time"])
        self.advance_to(start)

        operation = str(candidate["operation"]).lower()
        if self.harvested:
            return None
        if operation != "plant" and self.current_crop is None:
            return None

        evaluator = getattr(self, f"_eval_{operation}", None)
        if evaluator is None:
            raise ValueError(f"Unsupported operation in simulator: {operation}")

        result = evaluator(candidate, plan)
        if result is None:
            return None

        result["state_after"] = self.snapshot()
        return result

    def _eval_harvest(self, candidate, plan):
        rule = RULES["harvest"]
        if float(self.state["readiness"]) < float(rule["feasibility"]["min_readiness"]):
            return None

        area = float(self.field["area_ha"])
        expected_yield = max(0.0, float(self.state["expected_yield_t_ha"]))
        revenue = area * expected_yield * self._price(self.current_date)
        cost = float(candidate["direct_cost_aud"])

        self.harvested = True
        self.planted = False
        self.current_crop = None
        self._set_state("expected_yield_t_ha", 0.0)

        return self._result(revenue, cost, 0.0)

    def _eval_irrigate(self, candidate, plan):
        response = RULES["irrigate"]["response"]
        target = float(plan["amount"]) if pd.notna(plan["amount"]) else float(response["default_target_soil_moisture"])
        moisture = float(self.state["soil_moisture"])

        if moisture >= target:
            return None

        expected_yield = float(self.state["expected_yield_t_ha"])
        if expected_yield <= 0:
            expected_yield = self._potential_yield()

        deficit = max(0.0, min(1.0, (target - moisture) / target))
        yield_effect = expected_yield * deficit * float(response["max_yield_loss_fraction"])
        cost = float(candidate["direct_cost_aud"])

        self._set_state("soil_moisture", max(moisture, target))
        self._increase_yield(yield_effect)

        return self._result(0.0, cost, yield_effect, float(candidate.get("water_ml", 0.0)))

    def _eval_spray(self, candidate, plan):
        response = RULES["spray"]["response"]
        target = str(plan["target"])
        target_cfg = response["targets"].get(target)

        if target_cfg is None:
            raise ValueError(f"Unknown spray target: {target}")

        pressure_key = target_cfg["state_variable"]
        pressure = max(0.0, float(self.state[pressure_key]))
        if pressure <= 0:
            return None

        expected_yield = float(self.state["expected_yield_t_ha"])
        yield_effect = expected_yield * pressure * float(response["max_yield_loss_fraction"]) * float(response["efficacy"])
        cost = float(candidate["direct_cost_aud"])

        self._set_state(pressure_key, pressure * (1.0 - float(response["efficacy"])))
        self._increase_yield(yield_effect)

        return self._result(0.0, cost, yield_effect)

    def _eval_fertilise(self, candidate, plan):
        response = RULES["fertilise"]["response"]
        current_n = float(self.state["nitrogen_index"])
        target_n = float(response["target_nitrogen_index"])

        if current_n >= target_n or pd.isna(plan["amount"]):
            return None

        amount = float(plan["amount"])
        deficit = max(0.0, min(1.0, (target_n - current_n) / target_n))
        dose_response = 1.0 - math.exp(-amount / float(response["response_scale_kg_per_ha"]))
        expected_yield = float(self.state["expected_yield_t_ha"])
        yield_effect = expected_yield * deficit * float(response["max_yield_gain_fraction"]) * dose_response
        cost = float(candidate["direct_cost_aud"])

        new_n = current_n + (target_n - current_n) * dose_response
        self._set_state("nitrogen_index", min(1.0, new_n))
        self._increase_yield(yield_effect)

        return self._result(0.0, cost, yield_effect)

    def _eval_plant(self, candidate, plan):
        if self.current_crop is not None or self.planted:
            return None

        rule = RULES["plant"]
        response = rule["response"]
        crop = str(plan["target"]).strip().lower()

        if crop not in CROP_PARAMETERS:
            return None

        seedbed = float(self.state["seedbed_readiness"])
        moisture = float(self.state["soil_moisture"])
        temperature = float(self.state["soil_temperature_c"])

        if seedbed < float(rule["feasibility"]["min_seedbed_readiness"]):
            return None
        if temperature < float(rule["feasibility"]["min_soil_temperature_c"]):
            return None

        ideal_moisture = float(response["ideal_soil_moisture"])
        tolerance = float(response["soil_moisture_tolerance"])
        ideal_temperature = float(response["ideal_soil_temperature_c"])
        moisture_score = max(0.0, min(1.0, 1.0 - abs(moisture - ideal_moisture) / tolerance))
        temperature_score = min(1.0, temperature / ideal_temperature)
        suitability = max(0.0, min(1.0, seedbed * moisture_score * temperature_score))
        expected_yield = float(CROP_PARAMETERS[crop]["potential_yield_t_per_ha"]) * suitability
        cost = float(candidate["direct_cost_aud"])

        self.current_crop = crop
        self.planted = True
        self.newly_planted = True
        self.state["growth_stage"] = "planted"
        self._set_state("expected_yield_t_ha", expected_yield)

        return self._result(0.0, cost, expected_yield)

    def terminal_value(self, timestamp):
        self.advance_to(timestamp)

        if self.harvested or self.current_crop is None:
            return 0.0

        area = float(self.field["area_ha"])
        expected_yield = max(0.0, float(self.state["expected_yield_t_ha"]))
        value = area * expected_yield * self._price(self.current_date)

        if self.newly_planted:
            remaining_cost = float(self.config.get("terminal_value", {}).get("newly_planted_remaining_variable_cost_per_ha", 0.0))
            value -= area * remaining_cost

        return round(value, 2)

    @staticmethod
    def _result(revenue, cost, yield_effect=0.0, water_ml=0.0):
        return {
            "direct_revenue_aud": round(float(revenue), 2),
            "direct_cost_aud": round(float(cost), 2),
            "direct_cash_effect_aud": round(float(revenue) - float(cost), 2),
            "state_yield_effect_t_ha": round(float(yield_effect), 4),
            "water_ml": round(float(water_ml), 3),
        }

    def snapshot(self):
        return {
            "crop": self.current_crop or "",
            "planted": bool(self.planted),
            "newly_planted": bool(self.newly_planted),
            "harvested": bool(self.harvested),
            "growth_stage": self.state.get("growth_stage", ""),
            **{key: round(float(self.state.get(key, 0.0)), 4) for key in TRACKED_STATE},
        }

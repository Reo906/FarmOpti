from __future__ import annotations

from collections import defaultdict
from typing import Any

import pandas as pd

from farm_calibration.generic_transitions import apply_generic_operation, spray_pressure_key


def _num(value: Any, default: float = 0.0) -> float:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return default
    if isinstance(value, str) and value.strip() == "":
        return default
    return float(value)


def _text(value: Any) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    return str(value).strip()


def load_history(path: str) -> pd.DataFrame:
    return pd.read_csv(path)


def row_state(row: pd.Series) -> dict[str, Any]:
    return {
        "crop": _text(row.get("crop")).lower(),
        "growth_stage": _text(row.get("growth_stage")),
        "soil_moisture": _num(row.get("soil_moisture")),
        "nitrogen_index": _num(row.get("nitrogen_index")),
        "weed_pressure": _num(row.get("weed_pressure")),
        "pest_pressure": _num(row.get("pest_pressure")),
        "disease_pressure": _num(row.get("disease_pressure")),
        "expected_yield_t_ha": 0.0,
        "seedbed_readiness": 0.8,
        "soil_temperature_c": 16.0,
        "planted": bool(_text(row.get("crop"))),
        "harvested": False,
    }


def replay_residuals(history: pd.DataFrame, config: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    irrigation: list[dict[str, Any]] = []
    fertiliser: list[dict[str, Any]] = []
    spray: list[dict[str, Any]] = []
    yield_rows: list[dict[str, Any]] = []

    grouped = history.sort_values(["season_id", "timestamp"])
    for season_id, season in grouped.groupby("season_id", sort=False):
        replay_state: dict[str, Any] | None = None
        harvest_yield: float | None = None
        season_yield_rows: list[dict[str, Any]] = []

        for _, row in season.iterrows():
            operation = _text(row.get("operation")).lower()
            field_id = _text(row.get("field_id"))
            crop = _text(row.get("crop")).lower() or _text(row.get("next_crop")).lower()
            before = row_state(row)
            if replay_state is None:
                replay_state = dict(before)
            else:
                replay_state = {
                    **replay_state,
                    "crop": before["crop"] or replay_state.get("crop", ""),
                    "growth_stage": before["growth_stage"] or replay_state.get("growth_stage", ""),
                    "soil_moisture": before["soil_moisture"],
                    "nitrogen_index": before["nitrogen_index"],
                    "weed_pressure": before["weed_pressure"],
                    "pest_pressure": before["pest_pressure"],
                    "disease_pressure": before["disease_pressure"],
                }

            generic_next = apply_generic_operation(replay_state, operation, row.to_dict(), config)

            if operation == "irrigate":
                irrigation.append(
                    {
                        "field_id": field_id,
                        "crop": crop,
                        "growth_stage": before["growth_stage"],
                        "soil_moisture": before["soil_moisture"],
                        "generic_next_soil_moisture": generic_next["soil_moisture"],
                        "residual": _num(row.get("next_soil_moisture")) - generic_next["soil_moisture"],
                    }
                )
            elif operation == "fertilise":
                fertiliser.append(
                    {
                        "field_id": field_id,
                        "crop": crop,
                        "growth_stage": before["growth_stage"],
                        "nitrogen_index": before["nitrogen_index"],
                        "generic_next_nitrogen_index": generic_next["nitrogen_index"],
                        "residual": _num(row.get("next_nitrogen_index")) - generic_next["nitrogen_index"],
                    }
                )
            elif operation == "spray":
                pressure_key = spray_pressure_key(row.get("spray_target"))
                if pressure_key:
                    spray.append(
                        {
                            "field_id": field_id,
                            "crop": crop,
                            "growth_stage": before["growth_stage"],
                            "spray_target": _text(row.get("spray_target")).lower().replace("_control", ""),
                            "current_target_pressure": before[pressure_key],
                            "generic_next_target_pressure": generic_next[pressure_key],
                            "residual": _num(row.get(f"next_{pressure_key}")) - generic_next[pressure_key],
                        }
                    )

            if operation != "harvest":
                season_yield_rows.append(
                    {
                        "field_id": field_id,
                        "crop": crop,
                        "growth_stage": before["growth_stage"] or replay_state.get("growth_stage", ""),
                        "soil_moisture": before["soil_moisture"],
                        "nitrogen_index": before["nitrogen_index"],
                        "weed_pressure": before["weed_pressure"],
                        "pest_pressure": before["pest_pressure"],
                        "disease_pressure": before["disease_pressure"],
                        "generic_expected_yield_t_ha": generic_next["expected_yield_t_ha"],
                    }
                )

            actual = row.get("actual_yield_t_ha")
            if operation == "harvest" and actual is not None and not pd.isna(actual) and str(actual).strip() != "":
                harvest_yield = float(actual)
                generic_at_harvest = float(replay_state.get("expected_yield_t_ha") or 0.0)
                season_yield_rows.append(
                    {
                        "field_id": field_id,
                        "crop": crop,
                        "growth_stage": before["growth_stage"],
                        "soil_moisture": before["soil_moisture"],
                        "nitrogen_index": before["nitrogen_index"],
                        "weed_pressure": before["weed_pressure"],
                        "pest_pressure": before["pest_pressure"],
                        "disease_pressure": before["disease_pressure"],
                        "generic_expected_yield_t_ha": generic_at_harvest,
                    }
                )

            replay_state = generic_next

        if harvest_yield is not None:
            for item in season_yield_rows:
                item["residual"] = harvest_yield - float(item["generic_expected_yield_t_ha"])
                item["season_id"] = season_id
                yield_rows.append(item)

    return {
        "irrigation": irrigation,
        "fertiliser": fertiliser,
        "spray": spray,
        "yield": yield_rows,
    }


def support_counts(history: pd.DataFrame) -> dict[str, dict[str, Any]]:
    mapping = {"irrigate": "irrigate", "fertilise": "fertilise", "spray": "spray", "harvest": "yield"}
    counts: dict[str, dict[str, Any]] = {}
    for source, key in mapping.items():
        rows = history[history["operation"].astype(str).str.lower() == source]
        by_field_crop: dict[str, int] = defaultdict(int)
        by_crop: dict[str, int] = defaultdict(int)
        for _, row in rows.iterrows():
            field_id = _text(row.get("field_id"))
            crop = _text(row.get("crop")).lower() or _text(row.get("next_crop")).lower()
            by_field_crop[f"{field_id}|{crop}"] += 1
            by_crop[crop] += 1
        counts[key] = {
            "all": int(len(rows)),
            "by_crop": dict(by_crop),
            "by_field_crop": dict(by_field_crop),
        }
    return counts

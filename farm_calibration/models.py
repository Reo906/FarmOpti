from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

MIN_SAMPLES = 5

MODEL_SPECS: dict[str, dict[str, Any]] = {
    "irrigation": {
        "filename": "irrigation_model",
        "categorical": ["field_id", "crop", "growth_stage"],
        "numeric": ["soil_moisture", "generic_next_soil_moisture"],
    },
    "fertiliser": {
        "filename": "fertiliser_model",
        "categorical": ["field_id", "crop", "growth_stage"],
        "numeric": ["nitrogen_index", "generic_next_nitrogen_index"],
    },
    "spray": {
        "filename": "spray_model",
        "categorical": ["field_id", "crop", "growth_stage", "spray_target"],
        "numeric": ["current_target_pressure", "generic_next_target_pressure"],
    },
    "yield": {
        "filename": "yield_model",
        "categorical": ["field_id", "crop", "growth_stage"],
        "numeric": [
            "soil_moisture",
            "nitrogen_index",
            "weed_pressure",
            "pest_pressure",
            "disease_pressure",
            "generic_expected_yield_t_ha",
        ],
    },
}


def _pipeline(categorical: list[str], numeric: list[str]) -> Pipeline:
    return Pipeline(
        [
            (
                "pre",
                ColumnTransformer(
                    [
                        ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), categorical),
                        ("num", "passthrough", numeric),
                    ]
                ),
            ),
            (
                "gb",
                GradientBoostingRegressor(
                    n_estimators=40,
                    max_depth=2,
                    learning_rate=0.1,
                    random_state=0,
                ),
            ),
        ]
    )


def export_gradient_boosting(model: Pipeline, categorical: list[str], numeric: list[str]) -> dict[str, Any]:
    encoder: OneHotEncoder = model.named_steps["pre"].named_transformers_["cat"]
    gb: GradientBoostingRegressor = model.named_steps["gb"]
    init = float(gb.init_.constant_.ravel()[0])
    trees = []
    for estimator in gb.estimators_.ravel():
        tree = estimator.tree_
        trees.append(
            {
                "feature": tree.feature.tolist(),
                "threshold": tree.threshold.tolist(),
                "left": tree.children_left.tolist(),
                "right": tree.children_right.tolist(),
                "value": tree.value.reshape(-1).tolist(),
            }
        )
    categories = {name: [str(item) for item in values] for name, values in zip(categorical, encoder.categories_)}
    return {
        "kind": "gradient_boosting",
        "categories": categories,
        "numeric": numeric,
        "learning_rate": float(gb.learning_rate),
        "init": init,
        "trees": trees,
    }


def evaluate_fit(model: Pipeline | None, rows: list[dict[str, Any]], spec: dict[str, Any]) -> dict[str, float] | None:
    if not rows:
        return None
    residuals = [float(row["residual"]) for row in rows]
    generic_mae = sum(abs(value) for value in residuals) / len(residuals)
    generic_bias = sum(residuals) / len(residuals)
    if model is None:
        return {
            "samples": float(len(rows)),
            "generic_mae": generic_mae,
            "generic_bias": generic_bias,
            "calibrated_mae": generic_mae,
            "mae_improvement": 0.0,
            "mean_correction": 0.0,
        }

    frame = pd.DataFrame(rows)
    predicted = model.predict(frame[spec["categorical"] + spec["numeric"]])
    calibrated_errors = [residual - float(pred) for residual, pred in zip(residuals, predicted)]
    calibrated_mae = sum(abs(value) for value in calibrated_errors) / len(calibrated_errors)
    mean_correction = float(sum(predicted) / len(predicted))
    improvement = 0.0 if generic_mae == 0 else (generic_mae - calibrated_mae) / generic_mae
    return {
        "samples": float(len(rows)),
        "generic_mae": generic_mae,
        "generic_bias": generic_bias,
        "calibrated_mae": calibrated_mae,
        "mae_improvement": improvement,
        "mean_correction": mean_correction,
    }


def train_residual_model(rows: list[dict[str, Any]], spec: dict[str, Any], min_samples: int = MIN_SAMPLES) -> Pipeline | None:
    if len(rows) < min_samples:
        return None
    frame = pd.DataFrame(rows)
    features = spec["categorical"] + spec["numeric"]
    x = frame[features]
    y = frame["residual"]
    model = _pipeline(spec["categorical"], spec["numeric"])
    model.fit(x, y)
    return model


def save_farm_calibration(
    output_dir: str | Path,
    farm_id: str,
    history: pd.DataFrame,
    datasets: dict[str, list[dict[str, Any]]],
    support: dict[str, Any],
    confidence_k: float,
    min_samples: int = MIN_SAMPLES,
) -> dict[str, Any]:
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    trained: dict[str, Pipeline | None] = {}
    fit: dict[str, dict[str, float]] = {}
    feature_names: dict[str, list[str]] = {}
    sample_counts = {
        "irrigation": len(datasets["irrigation"]),
        "fertiliser": len(datasets["fertiliser"]),
        "spray": len(datasets["spray"]),
        "yield_rows": len(datasets["yield"]),
        "yield_seasons": int(history["season_id"].nunique()),
    }

    for name, spec in MODEL_SPECS.items():
        rows = datasets[name]
        model = train_residual_model(rows, spec, min_samples)
        trained[name] = model
        feature_names[name] = spec["categorical"] + spec["numeric"]
        stats = evaluate_fit(model, rows, spec)
        if stats is not None:
            fit[name] = stats
        if model is None:
            continue
        joblib.dump(model, output / f"{spec['filename']}.joblib")
        exported = export_gradient_boosting(model, spec["categorical"], spec["numeric"])
        (output / f"{spec['filename']}.json").write_text(json.dumps(exported, indent=2), encoding="utf-8")

    fields = sorted({str(value) for value in history["field_id"].dropna().unique()})
    crops = sorted(
        {
            str(value).strip().lower()
            for value in list(history["crop"].fillna("")) + list(history["next_crop"].fillna(""))
            if str(value).strip()
        }
    )
    metadata = {
        "farm_id": farm_id,
        "training_rows": int(len(history)),
        "fields": fields,
        "crops": crops,
        "model_version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "samples": sample_counts,
        "support": support,
        "feature_names": feature_names,
        "confidence_k": confidence_k,
        "trained_models": [name for name, model in trained.items() if model is not None],
        "skipped_models": [name for name, model in trained.items() if model is None],
        "fit": fit,
    }
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata

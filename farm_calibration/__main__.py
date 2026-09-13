from __future__ import annotations

import argparse
from pathlib import Path

from farm_calibration.generic_transitions import load_simulator_config
from farm_calibration.models import save_farm_calibration
from farm_calibration.replay import load_history, replay_residuals, support_counts


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Calibrate FarmOpti generic simulator residuals from farm history.")
    parser.add_argument("--history", required=True, help="Historical CSV path")
    parser.add_argument("--farm-id", required=True, help="Farm identifier")
    parser.add_argument("--output", required=True, help="Directory for farm_models/<farm_id>")
    parser.add_argument("--config", default=str(Path("data/config.yaml")), help="FarmOpti config.yaml")
    parser.add_argument("--confidence-k", type=float, default=5.0)
    parser.add_argument("--min-samples", type=int, default=5)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    history = load_history(args.history)
    config = load_simulator_config(args.config)
    datasets = replay_residuals(history, config)
    support = support_counts(history)
    metadata = save_farm_calibration(
        args.output,
        args.farm_id,
        history,
        datasets,
        support,
        args.confidence_k,
        args.min_samples,
    )

    print(f"Loaded {metadata['training_rows']} historical events")
    print(f"Irrigation samples: {metadata['samples']['irrigation']}")
    print(f"Fertiliser samples: {metadata['samples']['fertiliser']}")
    print(f"Spray samples: {metadata['samples']['spray']}")
    print(f"Yield seasons: {metadata['samples']['yield_seasons']}")
    print_fit_report(metadata.get("fit", {}))
    if metadata["skipped_models"]:
        print(f"Skipped models with insufficient samples: {', '.join(metadata['skipped_models'])}")
    print(f"\nSaved farm calibration to {args.output}")


def print_fit_report(fit: dict) -> None:
    if not fit:
        return

    labels = {
        "irrigation": "Irrigation (soil moisture)",
        "fertiliser": "Fertiliser (nitrogen index)",
        "spray": "Spray (target pressure)",
        "yield": "Yield (t/ha)",
    }
    print("\nHow much the generic simulator differed from history")
    print("  (MAE = mean |actual − generic|; calibrated applies the learned residual)")
    for name, stats in fit.items():
        label = labels.get(name, name)
        bias = stats["generic_bias"]
        sign = "+" if bias >= 0 else ""
        improvement = stats["mae_improvement"] * 100
        print(f"\n  {label}  n={int(stats['samples'])}")
        print(f"    generic MAE:     {stats['generic_mae']:.4f}")
        print(f"    calibrated MAE:  {stats['calibrated_mae']:.4f}  ({improvement:.0f}% lower error)")
        print(f"    mean residual:   {sign}{bias:.4f}   (actual − generic)")
        print(f"    mean correction: {stats['mean_correction']:+.4f}")


if __name__ == "__main__":
    main()

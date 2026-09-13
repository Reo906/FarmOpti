import sys
from pathlib import Path

from tqdm.auto import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from decision_analysis.analyse_counterfactuals import run_action_counterfactuals
from decision_analysis.build_decision_index import build_decision_index, save_decision_index
from decision_analysis.extract_decisions import (
    generate_decision_trace,
    save_decision_trace,
    update_importance,
)
from optimization.generate_candidates import EXTERNAL_DIR, OUTPUT_PATH, generate_candidates
from optimization.generate_field_options import generate_field_options, save_field_options
from optimization.optimize_schedule import optimize_schedule, save_results


def main():
    stages = tqdm(total=6, desc="Farm optimisation", unit="stage")

    stages.set_postfix_str("candidate generation")
    candidates = generate_candidates()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    candidates.to_csv(OUTPUT_PATH, index=False)
    stages.update(1)

    stages.set_postfix_str("field option generation")
    options = generate_field_options()
    save_field_options(options)
    stages.update(1)

    stages.set_postfix_str("global optimisation")
    schedule, summary = optimize_schedule(options)
    save_results(schedule, summary)
    stages.update(1)

    stages.set_postfix_str("decision evidence")
    trace = generate_decision_trace(
        candidates,
        options,
        schedule,
        summary,
    )
    stages.update(1)

    stages.set_postfix_str("counterfactual analysis")
    trace["counterfactuals"] = run_action_counterfactuals(
        trace,
        options,
        schedule,
        summary,
        EXTERNAL_DIR,
    )
    trace = update_importance(trace)
    save_decision_trace(trace)
    stages.update(1)

    stages.set_postfix_str("retrieval index")
    index = build_decision_index(trace)
    save_decision_index(index)
    stages.update(1)

    stages.set_postfix_str("complete")
    stages.close()


if __name__ == "__main__":
    main()

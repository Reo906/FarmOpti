from __future__ import annotations

import json
import shutil
import tempfile
from copy import deepcopy
from pathlib import Path

import pandas as pd

from chatbot.scenario.comparator import compare_scenarios
from chatbot.scenario.validator import ScenarioValidationError, ScenarioValidator, build_mask
from optimization.generate_candidates import EXTERNAL_DIR, OPTIMIZER_ROOT
from optimization.generate_field_options import generate_field_options
from optimization.optimize_schedule import load_field_options, optimize_schedule


BASELINE_SCHEDULE_PATH = OPTIMIZER_ROOT / "outputs" / "optimal_schedule.csv"
BASELINE_SUMMARY_PATH = OPTIMIZER_ROOT / "outputs" / "optimization_summary.json"


class ScenarioRunner:
    def __init__(self, external_variables_dir=EXTERNAL_DIR):
        self.external_variables_dir = Path(external_variables_dir)
        self.validator = ScenarioValidator(self.external_variables_dir)

    def _load_baseline(self):
        if not BASELINE_SCHEDULE_PATH.exists() or not BASELINE_SUMMARY_PATH.exists():
            raise FileNotFoundError("Baseline optimisation outputs are missing. Run optimizer/src/pipeline/run_pipeline.py first.")
        schedule = pd.read_csv(BASELINE_SCHEDULE_PATH)
        with open(BASELINE_SUMMARY_PATH, "r", encoding="utf-8") as f:
            summary = json.load(f)
        return schedule, summary

    def _plan_ids(self, change):
        rows = self.validator.matching_rows("action", change["where"])
        return [str(value) for value in rows["plan_id"].tolist()]

    def _plan_row(self, plan_id):
        rows = self.validator.matching_rows("action", {"plan_id": {"op": "eq", "value": plan_id}})
        if rows.empty:
            raise ScenarioValidationError(f"Unknown plan: {plan_id}")
        return rows.iloc[0]

    def _exact_plan_where(self, plan_id):
        return {"plan_id": {"op": "eq", "value": plan_id}}

    def _compile_date_constraint(self, plan_id, expression):
        row = self._plan_row(plan_id)
        old_from = pd.Timestamp(row["allowed_from"]).date()
        old_to = pd.Timestamp(row["allowed_to"]).date()
        requested = pd.Timestamp(expression["value"]).date()
        op = expression["op"]

        if op == "eq":
            new_from = requested
            new_to = requested
        elif op == "gte":
            new_from = max(old_from, requested)
            new_to = old_to
        elif op == "gt":
            new_from = max(old_from, requested + pd.Timedelta(days=1).to_pytimedelta())
            new_to = old_to
        elif op == "lte":
            new_from = old_from
            new_to = min(old_to, requested)
        elif op == "lt":
            new_from = old_from
            new_to = min(old_to, requested - pd.Timedelta(days=1).to_pytimedelta())
        else:
            raise ScenarioValidationError(f"Unsupported date constraint operator: {op}")

        if new_from > new_to:
            raise ScenarioValidationError(f"Date constraint for {plan_id} produces an empty allowed range: {new_from} > {new_to}")

        return {
            "target": self.validator.table_target_for_action(),
            "where": self._exact_plan_where(plan_id),
            "update": {
                "allowed_from": {"op": "set", "value": str(new_from)},
                "allowed_to": {"op": "set", "value": str(new_to)},
            },
        }

    def _compile(self, interpretation):
        compiled = {
            "scenario": interpretation,
            "solver_constraints": {"forbid_plan_ids": [], "force_plan_ids": [], "force_candidate_ids": {}},
            "table_mutations": [],
            "candidate_filters": [],
            "resolved_changes": [],
            "requires_regeneration": False,
        }

        for change in interpretation["changes"]:
            target = change["target"]

            if target != "action":
                compiled["table_mutations"].append(deepcopy(change))
                compiled["resolved_changes"].append(deepcopy(change))
                compiled["requires_regeneration"] = True
                continue

            plan_ids = self._plan_ids(change)
            resolved = {"target": "action", "plan_ids": plan_ids, "where": deepcopy(change["where"])}

            if change.get("update"):
                for plan_id in plan_ids:
                    compiled["table_mutations"].append({
                        "target": self.validator.table_target_for_action(),
                        "where": self._exact_plan_where(plan_id),
                        "update": deepcopy(change["update"]),
                    })
                compiled["requires_regeneration"] = True
                resolved["update"] = deepcopy(change["update"])

            constraints = change.get("constraints") or {}
            for field, expression in constraints.items():
                if field == "selected":
                    destination = "force_plan_ids" if expression["value"] else "forbid_plan_ids"
                    compiled["solver_constraints"][destination].extend(plan_ids)
                    continue

                if field == "date":
                    for plan_id in plan_ids:
                        compiled["table_mutations"].append(self._compile_date_constraint(plan_id, expression))
                        compiled["candidate_filters"].append({"plan_ids": [plan_id], "field": "date", "expression": deepcopy(expression)})
                    compiled["requires_regeneration"] = True
                    continue

                if field == "start_time":
                    timestamp = pd.Timestamp(expression["value"])
                    date_expression = {"op": expression["op"], "value": timestamp.date().isoformat()}
                    for plan_id in plan_ids:
                        compiled["table_mutations"].append(self._compile_date_constraint(plan_id, date_expression))
                        compiled["candidate_filters"].append({"plan_ids": [plan_id], "field": "start_time", "expression": deepcopy(expression)})
                    compiled["requires_regeneration"] = True
                    continue

                raise ScenarioValidationError(f"Unsupported action constraint field: {field}")

            if constraints:
                resolved["constraints"] = deepcopy(constraints)
            compiled["resolved_changes"].append(resolved)

        for key in ("forbid_plan_ids", "force_plan_ids"):
            compiled["solver_constraints"][key] = sorted(set(compiled["solver_constraints"][key]))

        overlap = set(compiled["solver_constraints"]["forbid_plan_ids"]) & set(compiled["solver_constraints"]["force_plan_ids"])
        if overlap:
            raise ScenarioValidationError(f"Scenario both forces and forbids plan(s): {sorted(overlap)}")

        return compiled

    def _apply_update(self, df, mask, field, expression):
        op = expression["op"]
        value = expression["value"]

        if op == "set":
            df.loc[mask, field] = value
            return

        current = pd.to_numeric(df.loc[mask, field], errors="raise")
        numeric_value = float(value)
        if op == "add":
            df.loc[mask, field] = current + numeric_value
        elif op == "subtract":
            df.loc[mask, field] = current - numeric_value
        elif op == "multiply":
            df.loc[mask, field] = current * numeric_value
        else:
            raise ScenarioValidationError(f"Unsupported update operator: {op}")

    def _apply_table_mutations(self, external_dir, mutations):
        grouped = {}
        for mutation in mutations:
            grouped.setdefault(mutation["target"], []).append(mutation)

        for target, target_mutations in grouped.items():
            source_path = self.validator.file_for_target(target)
            path = Path(external_dir) / source_path.name
            df = pd.read_csv(path)

            for mutation in target_mutations:
                mask = build_mask(df, mutation["where"])
                if not mask.any():
                    raise ScenarioValidationError(f"No rows matched compiled mutation for {target}: {mutation['where']}")
                for field, expression in mutation["update"].items():
                    self._apply_update(df, mask, field, expression)

            df.to_csv(path, index=False)

    def _constraint_holds(self, action, candidate_filter):
        field = candidate_filter["field"]
        expression = candidate_filter["expression"]
        value = pd.Timestamp(action["start_time"])
        expected = pd.Timestamp(expression["value"])

        if field == "date":
            value = value.date()
            expected = expected.date()

        op = expression["op"]
        if op == "eq":
            return value == expected
        if op == "gt":
            return value > expected
        if op == "gte":
            return value >= expected
        if op == "lt":
            return value < expected
        if op == "lte":
            return value <= expected
        raise ScenarioValidationError(f"Unsupported candidate constraint operator: {op}")

    def _filter_options(self, options, candidate_filters):
        if not candidate_filters:
            return options

        filtered = []
        for option in options:
            valid = True
            actions = option.get("actions", [])

            for candidate_filter in candidate_filters:
                plan_ids = set(candidate_filter["plan_ids"])
                matching = [action for action in actions if str(action.get("plan_id")) in plan_ids]
                if any(not self._constraint_holds(action, candidate_filter) for action in matching):
                    valid = False
                    break

            if valid:
                filtered.append(option)

        if not filtered:
            raise RuntimeError("Scenario constraints removed every field option")
        return filtered

    def run(self, interpretation, show_progress=True):
        if interpretation.get("mode") != "scenario":
            raise ScenarioValidationError("ScenarioRunner received a non-scenario interpretation")

        baseline_schedule, baseline_summary = self._load_baseline()
        compiled = self._compile(interpretation)
        solver_constraints = compiled["solver_constraints"]

        if not compiled["requires_regeneration"]:
            print("[SCENARIO] Reusing existing field options", flush=True)
            options = load_field_options()
            scenario_schedule, scenario_summary = optimize_schedule(options, external_variables_dir=self.external_variables_dir, scenario=solver_constraints, show_progress=show_progress)
        else:
            print("[SCENARIO] Applying validated scenario to temporary farm inputs", flush=True)
            with tempfile.TemporaryDirectory(prefix="farmopti_scenario_") as temp_dir:
                temp_external = Path(temp_dir) / "external_variables"
                shutil.copytree(self.external_variables_dir, temp_external)
                self._apply_table_mutations(temp_external, compiled["table_mutations"])

                print("[SCENARIO] Regenerating candidates and field options...", flush=True)
                options = generate_field_options(temp_external)
                if not options:
                    raise RuntimeError("Scenario produced no feasible field options")

                options = self._filter_options(options, compiled["candidate_filters"])
                print("[SCENARIO] Solving whole-farm schedule...", flush=True)
                scenario_schedule, scenario_summary = optimize_schedule(options, external_variables_dir=temp_external, scenario=solver_constraints, show_progress=show_progress)

        comparison = compare_scenarios(baseline_schedule, baseline_summary, scenario_schedule, scenario_summary)
        schedule_output = scenario_schedule.copy()
        for column in ("start_time", "end_time"):
            if column in schedule_output.columns:
                schedule_output[column] = schedule_output[column].astype(str)

        return {
            "scenario": compiled["scenario"],
            "resolved_changes": compiled["resolved_changes"],
            "summary": scenario_summary,
            "comparison": comparison,
            "schedule": schedule_output.to_dict(orient="records"),
        }

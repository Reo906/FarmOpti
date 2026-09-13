from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from optimization.generate_candidates import EXTERNAL_DIR


FILTER_OPERATORS = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "contains"]
UPDATE_OPERATORS = ["set", "add", "subtract", "multiply"]
ACTION_CONSTRAINTS = {
    "selected": {"type": "boolean", "operators": ["eq"]},
    "date": {"type": "date", "operators": ["eq", "gt", "gte", "lt", "lte"]},
    "start_time": {"type": "datetime", "operators": ["eq", "gt", "gte", "lt", "lte"]},
}
IMMUTABLE_COLUMNS = {"plan_id", "field_id", "machine_id", "candidate_id", "date", "time", "operation"}


class ScenarioValidationError(ValueError):
    pass


def _coerce_comparable(series, value):
    if pd.api.types.is_numeric_dtype(series):
        return pd.to_numeric(series, errors="coerce"), float(value)

    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "false"}:
            bool_value = lowered == "true"
            mapped = series.astype(str).str.lower().map({"true": True, "false": False, "1": True, "0": False})
            if mapped.notna().any():
                return mapped, bool_value

        if any(token in series.name.lower() for token in ("date", "time", "from", "to")):
            parsed = pd.to_datetime(series, errors="coerce")
            parsed_value = pd.to_datetime(value, errors="coerce")
            if parsed.notna().any() and not pd.isna(parsed_value):
                return parsed, parsed_value

    return series.astype(str).str.lower(), str(value).lower()


def evaluate_expression(series, expression):
    op = expression["op"]
    value = expression["value"]

    if op == "in":
        if not isinstance(value, list):
            raise ScenarioValidationError("Operator 'in' requires a list value")
        values = {str(item).lower() for item in value}
        return series.astype(str).str.lower().isin(values)

    if op == "contains":
        return series.astype(str).str.contains(str(value), case=False, regex=False, na=False)

    comparable, comparable_value = _coerce_comparable(series, value)

    if op == "eq":
        return comparable == comparable_value
    if op == "neq":
        return comparable != comparable_value
    if op == "gt":
        return comparable > comparable_value
    if op == "gte":
        return comparable >= comparable_value
    if op == "lt":
        return comparable < comparable_value
    if op == "lte":
        return comparable <= comparable_value

    raise ScenarioValidationError(f"Unsupported filter operator: {op}")


def build_mask(df, where):
    mask = pd.Series(True, index=df.index)
    for field, expression in where.items():
        if field not in df.columns:
            raise ScenarioValidationError(f"Unknown selector field {field!r}")
        mask &= evaluate_expression(df[field], expression)
    return mask


class ScenarioValidator:
    def __init__(self, external_variables_dir=EXTERNAL_DIR):
        self.external_variables_dir = Path(external_variables_dir)
        self.tables = self._discover_tables()
        self.action_table = "management_plan"
        self._cache = {}

        if self.action_table not in self.tables:
            raise FileNotFoundError(f"Required table {self.action_table}.csv not found in {self.external_variables_dir}")

    def _discover_tables(self):
        tables = {}
        for path in sorted(self.external_variables_dir.glob("*.csv")):
            # macOS creates AppleDouble companion files on some external drives.
            # They are metadata, not CSV inputs, and must never become DSL targets.
            if path.name.startswith("._"):
                continue
            df = pd.read_csv(path)
            tables[path.stem] = {
                "filename": path.name,
                "columns": list(df.columns),
                "types": {column: self._column_type(df[column]) for column in df.columns},
                "modifiable": [column for column in df.columns if column not in IMMUTABLE_COLUMNS and not column.endswith("_id")],
            }
        return tables

    def _column_type(self, series):
        if pd.api.types.is_bool_dtype(series):
            return "boolean"
        if pd.api.types.is_integer_dtype(series):
            return "integer"
        if pd.api.types.is_numeric_dtype(series):
            return "number"
        return "string"

    def targets(self):
        return ["action", *self.tables.keys()]

    def file_for_target(self, target):
        table = self.action_table if target == "action" else target
        if table not in self.tables:
            raise ScenarioValidationError(f"Unknown target {target!r}")
        return self.external_variables_dir / self.tables[table]["filename"]

    def table_target_for_action(self):
        return self.action_table

    def where_fields(self, target):
        table = self.action_table if target == "action" else target
        if target == "action":
            preferred = ["plan_id", "field_id", "operation", "target", "required"]
            return [field for field in preferred if field in self.tables[table]["columns"]]
        return list(self.tables[table]["columns"])

    def update_fields(self, target):
        table = self.action_table if target == "action" else target
        return list(self.tables[table]["modifiable"])

    def _table(self, target):
        table = self.action_table if target == "action" else target
        if table not in self._cache:
            self._cache[table] = pd.read_csv(self.file_for_target(table))
        return self._cache[table]

    def matching_rows(self, target, where):
        df = self._table(target)
        return df[build_mask(df, where)].copy()

    def _sample_values(self, df, column, limit=10):
        values = []
        for value in df[column].dropna().unique().tolist():
            value = value.item() if hasattr(value, "item") else value
            values.append(value)
            if len(values) >= limit:
                break
        return values

    def describe_for_llm(self):
        targets = {}
        management = self._table("action")
        plan_columns = [column for column in ["plan_id", "field_id", "operation", "target", "required"] if column in management.columns]

        targets["action"] = {
            "purpose": "A farm management/scheduling action. Use this when the user refers to harvesting, irrigation, spraying, fertilising, planting, a plan, or when an operation is performed.",
            "where_fields": {field: self.tables[self.action_table]["types"].get(field, "string") for field in self.where_fields("action")},
            "update_fields": {field: self.tables[self.action_table]["types"].get(field, "string") for field in self.update_fields("action")},
            "constraints": ACTION_CONSTRAINTS,
            "plans": management[plan_columns].to_dict(orient="records"),
        }

        for target, spec in self.tables.items():
            df = self._table(target)
            sample_values = {}
            for column in spec["columns"]:
                if column.endswith("_id") or column in {"operation", "item", "variable_type", "date"}:
                    sample_values[column] = self._sample_values(df, column)
            targets[target] = {
                "purpose": f"Rows from {spec['filename']}.",
                "where_fields": {field: spec["types"][field] for field in spec["columns"]},
                "update_fields": {field: spec["types"][field] for field in spec["modifiable"]},
                "sample_values": sample_values,
            }

        return {
            "dsl": {
                "where_operators": FILTER_OPERATORS,
                "update_operators": UPDATE_OPERATORS,
                "expression_format": {"field_name": {"op": "operator", "value": "value"}},
            },
            "targets": targets,
        }

    def describe_for_llm_json(self):
        return json.dumps(self.describe_for_llm(), indent=2, default=str)

    def response_schema(self):
        scalar = {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}]}
        expression_value = {"anyOf": [scalar, {"type": "array", "items": scalar}]}
        filter_expression = {
            "type": "object",
            "properties": {"op": {"type": "string", "enum": FILTER_OPERATORS}, "value": expression_value},
            "required": ["op", "value"],
            "additionalProperties": False,
        }
        update_expression = {
            "type": "object",
            "properties": {"op": {"type": "string", "enum": UPDATE_OPERATORS}, "value": scalar},
            "required": ["op", "value"],
            "additionalProperties": False,
        }
        constraint_expression = {
            "type": "object",
            "properties": {"op": {"type": "string", "enum": ["eq", "gt", "gte", "lt", "lte"]}, "value": scalar},
            "required": ["op", "value"],
            "additionalProperties": False,
        }
        change = {
            "type": "object",
            "properties": {
                "target": {"type": "string", "enum": self.targets()},
                "where": {"type": "object", "additionalProperties": filter_expression},
                "update": {"type": "object", "additionalProperties": update_expression},
                "constraints": {"type": "object", "additionalProperties": constraint_expression},
            },
            "required": ["target", "where"],
            "additionalProperties": False,
        }
        return {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "enum": ["explain", "scenario"]},
                "description": {"type": "string"},
                "changes": {"type": "array", "items": change},
            },
            "required": ["mode", "description", "changes"],
            "additionalProperties": False,
        }

    def _normalize_expression(self, expression, allowed_operators, label):
        if not isinstance(expression, dict):
            raise ScenarioValidationError(f"{label} must be an object with 'op' and 'value'")
        if set(expression) != {"op", "value"}:
            raise ScenarioValidationError(f"{label} must contain exactly 'op' and 'value'")

        op = str(expression["op"]).lower()
        if op not in allowed_operators:
            raise ScenarioValidationError(f"Unsupported operator {op!r} for {label}")

        value = expression["value"]
        field = label.rsplit(".", 1)[-1]
        if isinstance(value, dict) and len(value) == 1:
            key = next(iter(value))
            if key in {field, "value"}:
                value = value[key]

        if isinstance(value, dict):
            raise ScenarioValidationError(f"{label}.value must be a scalar value or a list for operator 'in'")
        if isinstance(value, list) and op != "in":
            raise ScenarioValidationError(f"{label} only accepts a list value with operator 'in'")
        if op == "in" and not isinstance(value, list):
            raise ScenarioValidationError(f"{label} with operator 'in' requires a list value")

        return {"op": op, "value": value}

    def _validate_where(self, target, where):
        if not isinstance(where, dict) or not where:
            raise ScenarioValidationError("where must be a non-empty object")

        allowed_fields = set(self.where_fields(target))
        normalized = {}
        for field, expression in where.items():
            if field not in allowed_fields:
                raise ScenarioValidationError(f"Field {field!r} cannot select target {target!r}. Allowed: {sorted(allowed_fields)}")
            normalized[field] = self._normalize_expression(expression, FILTER_OPERATORS, f"where.{field}")

        if self.matching_rows(target, normalized).empty:
            raise ScenarioValidationError(f"No {target!r} rows matched where={normalized}")
        return normalized

    def _validate_update(self, target, update):
        if update is None:
            return None
        if not isinstance(update, dict) or not update:
            raise ScenarioValidationError("update must be a non-empty object")

        allowed_fields = set(self.update_fields(target))
        normalized = {}
        for field, expression in update.items():
            if field not in allowed_fields:
                raise ScenarioValidationError(f"Field {field!r} cannot be updated on target {target!r}. Allowed: {sorted(allowed_fields)}")
            expression = self._normalize_expression(expression, UPDATE_OPERATORS, f"update.{field}")
            if expression["op"] != "set" and not isinstance(expression["value"], (int, float)):
                raise ScenarioValidationError(f"update.{field} with operator {expression['op']!r} requires a numeric value")
            normalized[field] = expression
        return normalized

    def _validate_constraints(self, target, constraints):
        if constraints is None:
            return None
        if target != "action":
            raise ScenarioValidationError("constraints are supported only for target 'action'; use update for external-variable tables")
        if not isinstance(constraints, dict) or not constraints:
            raise ScenarioValidationError("constraints must be a non-empty object")

        normalized = {}
        for field, expression in constraints.items():
            if field not in ACTION_CONSTRAINTS:
                raise ScenarioValidationError(f"Unknown action constraint {field!r}. Allowed: {sorted(ACTION_CONSTRAINTS)}")
            expression = self._normalize_expression(expression, ACTION_CONSTRAINTS[field]["operators"], f"constraints.{field}")

            if field == "selected" and not isinstance(expression["value"], bool):
                raise ScenarioValidationError("constraints.selected requires a boolean value")
            if field == "date":
                try:
                    pd.Timestamp(expression["value"]).date()
                except Exception as exc:
                    raise ScenarioValidationError("constraints.date requires a valid date") from exc
            if field == "start_time":
                try:
                    pd.Timestamp(expression["value"])
                except Exception as exc:
                    raise ScenarioValidationError("constraints.start_time requires a valid datetime") from exc

            normalized[field] = expression
        return normalized

    def validate_interpretation(self, interpretation):
        if not isinstance(interpretation, dict):
            raise ScenarioValidationError("LLM interpretation must be a JSON object")

        mode = str(interpretation.get("mode", "")).lower()
        if mode not in {"explain", "scenario"}:
            raise ScenarioValidationError("mode must be 'explain' or 'scenario'")

        description = str(interpretation.get("description", ""))
        changes = interpretation.get("changes", [])

        if mode == "explain":
            return {"mode": "explain", "description": description, "changes": []}

        if not isinstance(changes, list) or not changes:
            raise ScenarioValidationError("Scenario mode requires at least one change")

        normalized = {"mode": "scenario", "description": description or "Scenario", "changes": []}
        for index, change in enumerate(changes):
            if not isinstance(change, dict):
                raise ScenarioValidationError(f"changes[{index}] must be an object")

            target = str(change.get("target", ""))
            if target not in self.targets():
                raise ScenarioValidationError(f"Unknown target {target!r}. Allowed targets: {self.targets()}")

            where = self._validate_where(target, change.get("where", {}))
            update = self._validate_update(target, change.get("update"))
            constraints = self._validate_constraints(target, change.get("constraints"))
            if not update and not constraints:
                raise ScenarioValidationError(f"changes[{index}] must contain update and/or constraints")

            item = {"target": target, "where": where}
            if update:
                item["update"] = update
            if constraints:
                item["constraints"] = constraints
            normalized["changes"].append(item)

        return normalized

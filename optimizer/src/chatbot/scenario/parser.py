from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from chatbot.scenario.validator import ScenarioValidationError, ScenarioValidator


SYSTEM_PROMPT = """
You compile a FarmOpti scenario request into the supplied generic scenario DSL.
The request has already been classified as a scenario modification. Do not classify it again.

Every scenario change uses:
- target: an exposed FarmOpti entity/table
- where: selectors identifying affected rows/actions
- update: modification to stored input values, and/or
- constraints: scheduling/selection constraints for target="action"

Rules:
1. Use only targets, fields, operators and identifiers present in the supplied FarmOpti context.
2. Never invent plan IDs, field IDs, machine IDs, operation names or candidate IDs.
3. Prefer target="action" when the user refers to harvesting, irrigation, spraying, fertilising, planting, a plan, or changing when an operation occurs.
4. For action timing changes, use constraints.date or constraints.start_time, not table edits or candidate IDs.
5. A request to move/schedule an action to a date/time implies constraints.selected=true unless the user explicitly says selection remains optional.
6. Use YYYY-MM-DD for dates and YYYY-MM-DD HH:MM:SS for datetimes.
7. Use update for water, labour, machines, economics, weather, field state, management values and other exposed input tables.
8. Preserve requested numerical values exactly. Do not guess missing values.
9. Return only the structured scenario object required by the supplied schema.

Examples:

User: What if the harvest day in F1 changes to 2026-09-25?
{"description":"Harvest F1 on 2026-09-25","changes":[{"target":"action","where":{"field_id":{"op":"eq","value":"F1"},"operation":{"op":"eq","value":"harvest"}},"constraints":{"selected":{"op":"eq","value":true},"date":{"op":"eq","value":"2026-09-25"}}}]}

User: Add 3 ML of available water on 2026-09-20.
{"description":"Add 3 ML of water on 2026-09-20","changes":[{"target":"water_availability_daily","where":{"date":{"op":"eq","value":"2026-09-20"}},"update":{"available_water_ml":{"op":"add","value":3.0}}}]}

User: Don't spray F2.
{"description":"Do not spray F2","changes":[{"target":"action","where":{"field_id":{"op":"eq","value":"F2"},"operation":{"op":"eq","value":"spray"}},"constraints":{"selected":{"op":"eq","value":false}}}]}
""".strip()


class ScenarioParser:
    def __init__(self, llm, validator=None):
        self.llm = llm
        self.validator = validator or ScenarioValidator()

    def _extract_json(self, text):
        text = text.strip()
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                return json.loads(text[start:end + 1])
            raise

    def _response_schema(self):
        schema = copy.deepcopy(self.validator.response_schema())
        schema["properties"].pop("mode", None)
        schema["required"] = [field for field in schema["required"] if field != "mode"]
        return schema

    def parse(self, request):
        today = datetime.now(ZoneInfo("Australia/Melbourne")).date().isoformat()
        prompt = f"""Current date in Australia/Melbourne: {today}

FarmOpti schema and current identifiers:
{self.validator.describe_for_llm_json()}

User scenario request:
{request}

Compile this scenario into the supplied FarmOpti DSL."""

        response = self.llm.chat(
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
            response_schema=self._response_schema(),
            max_output_tokens=800,
        )

        try:
            parsed = self._extract_json(response)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ScenarioValidationError(f"Could not parse LLM scenario as JSON: {exc}") from exc

        return self.validator.validate_interpretation({"mode": "scenario", **parsed})

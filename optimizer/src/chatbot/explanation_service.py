from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from copy import deepcopy

from chatbot.explanation.retrieve_decisions import DecisionRetriever
from chatbot.scenario import ScenarioParser, ScenarioRunner, ScenarioValidationError
from optimization.generate_candidates import CONFIG


LLM_CONFIG = CONFIG["explanation"]["llm"]
PROCESS_CONFIG = CONFIG["explanation"].get("process_display", {})
SCENARIO_CONFIG = CONFIG["explanation"].get("scenario", {})


def process_print(message):
    if PROCESS_CONFIG.get("enabled", True):
        print(message, flush=True)


SYSTEM_PROMPT = """
You explain decisions made by a mathematical farm optimisation system.

Rules:
1. Use only the supplied optimisation evidence.
2. Never invent a reason that is not supported by the evidence.
3. Answer the exact decision the user asked about.
4. Do not discuss other fields or plans unless they directly affected the target decision.
5. Start with the main reason for the decision.
6. Clearly distinguish direct cash effects, field-state effects, terminal crop value, and whole-farm objective changes.
7. Counterfactual objective changes are the strongest evidence for explaining why optional actions were selected or skipped.
8. A negative direct cash effect does not mean an action was economically harmful if it improves the final whole-farm objective.
9. Never describe a forced counterfactual action as an action selected by the original optimiser.
10. If a counterfactual scenario is infeasible, say only that the alternative could not produce a feasible whole-farm schedule.
11. If the evidence is insufficient to establish a reason, say so.
12. Be concise. Normally answer in one or two short paragraphs.
13. The optimiser made the scheduling decision. You only explain its evidence.
""".strip()


CLASSIFICATION_PROMPT = """
Classify the user's FarmOpti request as exactly one of two modes.

EXPLAIN:
The user is asking about the existing optimisation result, including its decisions, timing, feasibility, alternatives, values, state changes, resources, or reasoning. Use EXPLAIN when the question can be answered from the existing optimisation and its recorded evidence.

SCENARIO:
The user explicitly specifies a changed condition, value, requirement, constraint, availability, assumption, timing, or action and wants FarmOpti to evaluate the result under that changed state. A SCENARIO request must contain a concrete modification to the optimisation problem.

Important distinctions:
- "Why was F2 sprayed?" -> EXPLAIN
- "Could F1 have been harvested later?" -> EXPLAIN
- "Was September 25 considered for F1?" -> EXPLAIN
- "What other harvest dates were feasible for F1?" -> EXPLAIN
- "What if F1 is harvested on September 25?" -> SCENARIO
- "Move F1 harvest to September 25." -> SCENARIO
- "Would profit be higher if F1 were harvested on September 25?" -> SCENARIO
- "Add 3 ML of water on September 20." -> SCENARIO
- "What if wheat price were 450 AUD/t?" -> SCENARIO
- "Don't spray F2." -> SCENARIO

Do not classify a request as SCENARIO merely because it contains words such as could, would, possible, alternative, later, earlier, or why not. Those remain EXPLAIN unless the user actually supplies a changed condition to evaluate.

Return only the structured classification required by the supplied schema.
""".strip()

CLASSIFICATION_SCHEMA = {
    "type": "object",
    "properties": {"mode": {"type": "string", "enum": ["explain", "scenario"]}},
    "required": ["mode"],
    "additionalProperties": False,
}

SCENARIO_EXPLANATION_PROMPT = """
You explain the result of a user-requested FarmOpti re-optimisation scenario.

Rules:
1. The baseline schedule is the original optimiser result.
2. The scenario schedule is the result after applying the validated user-requested modification.
3. Use only the supplied scenario comparison and resolved changes.
4. State whether the whole-farm objective increased or decreased.
5. Mention important actions that were added, removed, or rescheduled.
6. Do not invent causal reasons that are not supported by the supplied result.
7. Do not claim the LLM performed the optimisation.
8. Be concise.
""".strip()


class LLMClient:
    def __init__(self):
        self.provider = str(LLM_CONFIG["provider"]).lower()
        self.model = str(LLM_CONFIG["model"])
        self.base_url = str(LLM_CONFIG["base_url"]).rstrip("/")
        self.temperature = float(LLM_CONFIG["temperature"])
        self.timeout_seconds = float(LLM_CONFIG["timeout_seconds"])
        self.max_output_tokens = int(LLM_CONFIG.get("max_output_tokens", 250))
        api_key_env = str(LLM_CONFIG.get("api_key_env", "LLM_API_KEY"))
        self.api_key = os.getenv(api_key_env, "")
        process_print(f"[INIT] LLM ready | provider={self.provider} | model={self.model}")

    def _post_json(self, url, payload, headers=None):
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **(headers or {})}, method="POST")

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            raise RuntimeError(f"LLM request failed ({exc.code}): {body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Could not connect to LLM at {url}: {exc}") from exc

    def _ollama(self, messages, response_schema=None, max_output_tokens=None):
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": self.temperature,
                "num_predict": int(max_output_tokens or self.max_output_tokens),
            },
        }
        if response_schema is not None:
            payload["format"] = response_schema
        result = self._post_json(f"{self.base_url}/api/chat", payload)
        return result["message"]["content"].strip()

    def _openai_compatible(self, messages, response_schema=None, max_output_tokens=None):
        url = f"{self.base_url}/chat/completions" if self.base_url.endswith("/v1") else f"{self.base_url}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": int(max_output_tokens or self.max_output_tokens),
        }
        if response_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "farmopti_structured_response", "strict": True, "schema": response_schema},
            }
        result = self._post_json(url, payload, headers=headers)
        return result["choices"][0]["message"]["content"].strip()

    def chat(self, messages, response_schema=None, max_output_tokens=None):
        if self.provider == "ollama":
            return self._ollama(messages, response_schema=response_schema, max_output_tokens=max_output_tokens)
        if self.provider in ("openai", "openai_compatible", "compatible"):
            return self._openai_compatible(messages, response_schema=response_schema, max_output_tokens=max_output_tokens)
        raise ValueError(f"Unsupported LLM provider: {self.provider}")


class ExplanationService:
    def __init__(self):
        process_print("[INIT] Initialising explanation service...")
        self.retriever = DecisionRetriever()
        self.llm = LLMClient()
        self.scenario_runner = None
        self.scenario_parser = None

        if SCENARIO_CONFIG.get("enabled", True):
            self.scenario_runner = ScenarioRunner()
            self.scenario_parser = ScenarioParser(self.llm, validator=self.scenario_runner.validator)

        process_print("[INIT] Explanation service ready")

    def _compact_action_evidence(self, action):
        if not action:
            return None

        timing = action.get("timing") or {}
        transition = action.get("state_transition") or {}
        counterfactual = action.get("counterfactual") or {}
        compact_counterfactual = None

        if counterfactual:
            compact_counterfactual = {
                "scenario": counterfactual.get("scenario"),
                "feasible": counterfactual.get("feasible"),
                "baseline_objective_aud": counterfactual.get("baseline_objective_aud"),
                "counterfactual_objective_aud": counterfactual.get("counterfactual_objective_aud"),
                "objective_change_aud": counterfactual.get("objective_change_aud"),
                "affected_decisions": (counterfactual.get("affected_decisions") or [])[:5],
            }

        return {
            "selected": action.get("selected"),
            "required": action.get("required"),
            "financial": action.get("financial"),
            "timing": {
                "selected_time": timing.get("selected_time"),
                "selected_candidate_id": timing.get("selected_candidate_id"),
                "earliest_feasible_time": timing.get("earliest_feasible_time"),
                "latest_feasible_time": timing.get("latest_feasible_time"),
                "feasible_candidate_count": timing.get("feasible_candidate_count"),
                "alternative_times": (timing.get("alternative_times") or [])[:3],
            },
            "state_changes": transition.get("state_changes"),
            "counterfactual": compact_counterfactual,
        }

    def _compact_field_evidence(self, field):
        if not field:
            return None
        return {
            "selected_option_id": field.get("selected_option_id"),
            "selected_objective_value_aud": field.get("selected_objective_value_aud"),
            "selected_direct_cash_effect_aud": field.get("selected_direct_cash_effect_aud"),
            "selected_terminal_value_aud": field.get("selected_terminal_value_aud"),
            "best_local_alternative": field.get("best_local_alternative"),
        }

    def _build_context(self, records):
        plans = {}
        other = []

        for record in records:
            plan_id = record.get("plan_id")
            if not plan_id:
                other.append({"decision_id": record.get("decision_id"), "type": record.get("type"), "text": record.get("text")})
                continue

            if plan_id not in plans:
                plans[plan_id] = {
                    "plan_id": plan_id,
                    "field_id": record.get("field_id"),
                    "operation": record.get("operation"),
                    "target_decision": bool(record.get("target_match")),
                    "retrieved_evidence": [],
                    "action_evidence": self._compact_action_evidence(record.get("raw_action_evidence")),
                    "field_evidence": self._compact_field_evidence(record.get("raw_field_evidence")),
                }

            plans[plan_id]["retrieved_evidence"].append({
                "decision_id": record.get("decision_id"),
                "type": record.get("type"),
                "text": record.get("text"),
            })

        return {"decisions": list(plans.values()), "other_evidence": other}

    def _generate(self, prompt, system_prompt=SYSTEM_PROMPT):
        process_print(f"[LLM] {self.llm.model} → generating explanation...")
        start = time.perf_counter()
        answer = self.llm.chat([
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ])
        elapsed = time.perf_counter() - start
        process_print(f"[LLM] Done ({elapsed:.2f}s)" if PROCESS_CONFIG.get("show_llm_timing", True) else "[LLM] Done")
        return answer

    def _classify_request(self, question):
        if not self.scenario_parser:
            return "explain"

        process_print("[CLASSIFY] Classifying request...")
        start = time.perf_counter()

        try:
            response = self.llm.chat(
                [{"role": "system", "content": CLASSIFICATION_PROMPT}, {"role": "user", "content": question}],
                response_schema=CLASSIFICATION_SCHEMA,
                max_output_tokens=30,
            )
            mode = str(json.loads(response)["mode"]).lower()
        except Exception as exc:
            process_print(f"[CLASSIFY] Invalid classifier response ({exc}) → EXPLAIN fallback")
            mode = "explain"

        elapsed = time.perf_counter() - start
        process_print(f"[CLASSIFY] {mode.upper()} ({elapsed:.2f}s)")
        return mode

    def _run_scenario(self, question, scenario_overlay=None):
        process_print("[SCENARIO] Parsing requested modification...")

        try:
            interpretation = self.scenario_parser.parse(question)
            requested_interpretation = deepcopy(interpretation)
            if scenario_overlay and scenario_overlay.get("changes"):
                interpretation = self.scenario_runner.validator.validate_interpretation({
                    "mode": "scenario",
                    "description": f"{scenario_overlay.get('description', 'Confirmed constraints')} + {interpretation['description']}",
                    "changes": [
                        *deepcopy(scenario_overlay["changes"]),
                        *deepcopy(interpretation["changes"]),
                    ],
                })
        except ScenarioValidationError as exc:
            process_print(f"[SCENARIO] Invalid scenario: {exc}")
            return {
                "answer": f"I understood this as a scenario change, but could not translate it into a valid FarmOpti modification: {exc}",
                "needs_reoptimization": False,
                "scenario_error": True,
            }

        if SCENARIO_CONFIG.get("show_parsed_scenario", True):
            process_print("[SCENARIO] Validated modification:")
            process_print(json.dumps(interpretation, indent=2))

        process_print("[SCENARIO] Re-optimising...")
        start = time.perf_counter()

        try:
            result = self.scenario_runner.run(interpretation, show_progress=SCENARIO_CONFIG.get("show_progress", True))
        except Exception as exc:
            process_print(f"[SCENARIO] Re-optimisation failed: {exc}")
            return {
                "answer": f"FarmOpti understood the requested modification, but could not produce a feasible scenario result: {exc}",
                "needs_reoptimization": False,
                "scenario_error": True,
            }

        comparison = result["comparison"]
        if SCENARIO_CONFIG.get("show_comparison", True):
            process_print(f"[SCENARIO] Objective: ${comparison['baseline_objective_aud']:,.2f} → ${comparison['scenario_objective_aud']:,.2f} ({comparison['objective_change_aud']:+,.2f})")
            process_print(f"[SCENARIO] Schedule changes | added={len(comparison['actions_added'])} | removed={len(comparison['actions_removed'])} | rescheduled={len(comparison['actions_rescheduled'])}")

        elapsed = time.perf_counter() - start
        process_print(f"[SCENARIO] Re-optimisation complete ({elapsed:.2f}s)")

        prompt = f"""
The user requested this FarmOpti scenario:
{question}

Validated modification:
{json.dumps(result['scenario'], indent=2)}

Deterministically resolved changes:
{json.dumps(result['resolved_changes'], indent=2)}

Comparison against the original optimisation:
{json.dumps(result['comparison'], indent=2)}

New optimisation summary:
{json.dumps(result['summary'], indent=2)}

Explain what changed and whether the requested scenario improved or reduced the whole-farm financial objective.
""".strip()

        answer = self._generate(prompt, SCENARIO_EXPLANATION_PROMPT)
        result["requested_scenario"] = requested_interpretation
        return {"answer": answer, "needs_reoptimization": False, "scenario_result": result}

    def explain_default(self):
        process_print("\n[SUMMARY] Generating important-decision summary")
        records = self.retriever.get_default_decisions()
        context = self._build_context(records)
        process_print(f"[CONTEXT] Building context from {len(records)} retrieved records")

        prompt = f"""
Explain the most important decisions in the optimised farm schedule.

Only discuss the major decisions represented in the supplied evidence. Prioritise financially important optional decisions, costly required actions, meaningful field trade-offs, and genuinely important resource constraints.

Optimisation evidence:
{json.dumps(context, indent=2)}
""".strip()
        return self._generate(prompt)

    def answer(self, question, return_evidence=False, scenario_overlay=None):
        process_print(f"\n[CHAT] Question: {question}")

        mode = self._classify_request(question)

        if mode == "scenario":
            return self._run_scenario(question, scenario_overlay=scenario_overlay)

        process_print("[RETRIEVAL] Existing decision → retrieving optimisation evidence")
        records = self.retriever.retrieve(question)
        context = self._build_context(records)
        process_print(f"[CONTEXT] Consolidated {len(records)} retrieved records into {len(context['decisions'])} decision context(s)")

        prompt = f"""
Answer this question directly:

{question}

Optimisation evidence:
{json.dumps(context, indent=2)}

Instructions:
- Answer only the decision asked about.
- Start with the main reason in the first sentence.
- If this is an optional selected action, use the forbid-action counterfactual as the strongest financial evidence.
- If this is an optional skipped action, use the force-action counterfactual as the strongest financial evidence.
- Use state changes to explain the agronomic mechanism when available.
- Mention timing only if it helps answer the question.
- Do not discuss unrelated plans.
- Do not confuse a counterfactual forced action with the original selected schedule.
- Keep the answer concise.
""".strip()

        answer = self._generate(prompt)
        result = {"answer": answer, "needs_reoptimization": False}
        if return_evidence:
            result["evidence"] = records
        return result

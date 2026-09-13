from __future__ import annotations

from threading import Lock
from typing import Callable

from chatbot.explanation_service import ExplanationService
from voice_interface.errors import VoiceInputError
from voice_interface.models import ConversationReply


class FarmOptiConversationAdapter:
    """Adapts the existing explanation/scenario service to the voice port."""

    def __init__(
        self,
        service: ExplanationService | None = None,
        active_constraints: Callable[[], dict | None] | None = None,
    ):
        self.service = service or ExplanationService()
        self.active_constraints = active_constraints or (lambda: None)
        self._lock = Lock()

    def answer(self, question: str) -> ConversationReply:
        clean_question = " ".join(question.split()).strip()
        if not clean_question:
            raise VoiceInputError("The transcript did not contain a question.")
        if len(clean_question) > 2_000:
            raise VoiceInputError("The transcript is too long for one FarmOpti turn.")

        # Scenario runs use temporary input copies, but the underlying service is
        # intentionally serialized until its concurrency guarantees are explicit.
        with self._lock:
            result = self.service.answer(
                clean_question,
                scenario_overlay=self.active_constraints(),
            )

        answer = str(result.get("answer", "")).strip()
        if not answer:
            raise RuntimeError("FarmOpti returned an empty answer.")
        scenario_result = result.get("scenario_result")
        mode = "scenario" if scenario_result else "explain"
        metadata = {"scenario_error": bool(result.get("scenario_error", False))}
        if scenario_result:
            comparison = scenario_result.get("comparison", {})
            metadata.update({
                "objective_change_aud": comparison.get("objective_change_aud"),
                "actions_added": len(comparison.get("actions_added", [])),
                "actions_removed": len(comparison.get("actions_removed", [])),
                "actions_rescheduled": len(comparison.get("actions_rescheduled", [])),
                "constraint_evaluation": {
                    "scenario": scenario_result.get("requested_scenario", scenario_result.get("scenario")),
                    "effective_scenario": scenario_result.get("scenario"),
                    "resolved_changes": scenario_result.get("resolved_changes"),
                    "comparison": comparison,
                    "summary": scenario_result.get("summary"),
                    "schedule": scenario_result.get("schedule"),
                },
            })
        return ConversationReply(answer=answer, mode=mode, metadata=metadata)

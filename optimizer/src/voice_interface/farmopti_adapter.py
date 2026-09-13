from __future__ import annotations

from threading import Lock

from chatbot.explanation_service import ExplanationService
from voice_interface.errors import VoiceInputError
from voice_interface.models import ConversationReply


class FarmOptiConversationAdapter:
    """Adapts the existing explanation/scenario service to the voice port."""

    def __init__(self, service: ExplanationService | None = None):
        self.service = service or ExplanationService()
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
            result = self.service.answer(clean_question)

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
            })
        return ConversationReply(answer=answer, mode=mode, metadata=metadata)

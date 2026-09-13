from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Transcript:
    text: str
    language_code: str | None = None
    provider_request_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ConversationReply:
    answer: str
    mode: str = "explain"
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ConversationTurn:
    transcript: str
    answer: str
    mode: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class VoiceTurn:
    session_id: str
    transcript: Transcript
    reply: ConversationReply
    audio: bytes | None
    audio_content_type: str | None
    timings_ms: dict[str, int]
    history: tuple[ConversationTurn, ...]

    def to_dict(self, include_audio: bool = False) -> dict[str, Any]:
        import base64

        result = {
            "session_id": self.session_id,
            "transcript": self.transcript.to_dict(),
            "reply": self.reply.to_dict(),
            "audio_content_type": self.audio_content_type,
            "timings_ms": self.timings_ms,
            "history": [turn.to_dict() for turn in self.history],
        }
        if include_audio and self.audio is not None:
            result["audio_base64"] = base64.b64encode(self.audio).decode("ascii")
        return result

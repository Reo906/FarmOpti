from __future__ import annotations

from typing import Protocol

from voice_interface.models import ConversationReply, Transcript


class SpeechProvider(Protocol):
    @property
    def configured(self) -> bool: ...

    @property
    def max_audio_bytes(self) -> int: ...

    def transcribe(self, audio: bytes, filename: str, content_type: str) -> Transcript: ...

    def synthesise(self, text: str) -> tuple[bytes, str]: ...


class ConversationBackend(Protocol):
    def answer(self, question: str) -> ConversationReply: ...

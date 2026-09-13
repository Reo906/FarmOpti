from __future__ import annotations

import time
import uuid
from collections import OrderedDict
from threading import Lock

from voice_interface.models import ConversationReply, ConversationTurn, Transcript, VoiceTurn
from voice_interface.ports import ConversationBackend, SpeechProvider


class SessionStore:
    """Bounded, in-memory transcript history with no persistence requirement."""

    def __init__(self, max_sessions: int = 100, max_turns: int = 6):
        self.max_sessions = max_sessions
        self.max_turns = max_turns
        self._sessions: OrderedDict[str, list[ConversationTurn]] = OrderedDict()
        self._lock = Lock()

    def append(self, session_id: str, turn: ConversationTurn) -> tuple[ConversationTurn, ...]:
        with self._lock:
            turns = self._sessions.pop(session_id, [])
            turns.append(turn)
            turns = turns[-self.max_turns :]
            self._sessions[session_id] = turns
            while len(self._sessions) > self.max_sessions:
                self._sessions.popitem(last=False)
            return tuple(turns)

    def get(self, session_id: str) -> tuple[ConversationTurn, ...]:
        with self._lock:
            return tuple(self._sessions.get(session_id, []))

    def clear(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)


class VoiceGateway:
    """Provider-neutral orchestration for speech → FarmOpti → speech."""

    def __init__(
        self,
        speech: SpeechProvider,
        conversation: ConversationBackend,
        sessions: SessionStore | None = None,
    ):
        self.speech = speech
        self.conversation = conversation
        self.sessions = sessions or SessionStore()

    @property
    def configured(self) -> bool:
        return self.speech.configured

    def transcribe(self, audio: bytes, filename: str, content_type: str) -> Transcript:
        return self.speech.transcribe(audio, filename, content_type)

    def respond(self, text: str, session_id: str | None = None) -> tuple[str, ConversationReply, tuple[ConversationTurn, ...]]:
        resolved_session_id = session_id or str(uuid.uuid4())
        reply = self.conversation.answer(text)
        history = self.sessions.append(
            resolved_session_id,
            ConversationTurn(transcript=text, answer=reply.answer, mode=reply.mode),
        )
        return resolved_session_id, reply, history

    def speak(self, text: str) -> tuple[bytes, str]:
        return self.speech.synthesise(text)

    def process_turn(
        self,
        audio: bytes,
        filename: str,
        content_type: str,
        session_id: str | None = None,
        include_audio: bool = True,
    ) -> VoiceTurn:
        start = time.perf_counter()
        transcript = self.transcribe(audio, filename, content_type)
        transcribed = time.perf_counter()
        resolved_session_id, reply, history = self.respond(transcript.text, session_id)
        answered = time.perf_counter()
        speech_audio = None
        speech_content_type = None
        if include_audio:
            speech_audio, speech_content_type = self.speak(reply.answer)
        finished = time.perf_counter()
        return VoiceTurn(
            session_id=resolved_session_id,
            transcript=transcript,
            reply=reply,
            audio=speech_audio,
            audio_content_type=speech_content_type,
            timings_ms={
                "transcription": round((transcribed - start) * 1_000),
                "farmopti": round((answered - transcribed) * 1_000),
                "speech": round((finished - answered) * 1_000),
                "total": round((finished - start) * 1_000),
            },
            history=history,
        )

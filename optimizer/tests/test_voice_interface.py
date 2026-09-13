from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from voice_interface.config import VoiceConfig
from voice_interface.api import create_app
from voice_interface.elevenlabs_client import ElevenLabsVoiceClient
from voice_interface.models import ConversationReply, Transcript
from voice_interface.service import SessionStore, VoiceGateway


class FakeSpeech:
    configured = True
    max_audio_bytes = 1_000

    def transcribe(self, audio, filename, content_type):
        if not audio:
            raise ValueError("empty")
        return Transcript("Why was F2 sprayed?", "en")

    def synthesise(self, text):
        return f"audio:{text}".encode(), "audio/mpeg"


class FakeConversation:
    def answer(self, question):
        return ConversationReply(
            answer=f"Grounded answer for: {question}",
            mode="explain",
            metadata={"source": "optimiser evidence"},
        )


class FakeResponse:
    def __init__(self, payload=None, content=b"", content_type="application/json"):
        self.status_code = 200
        self._payload = payload or {}
        self.content = content
        self.headers = {"content-type": content_type, "request-id": "req_test"}

    def json(self):
        return self._payload


class FakeHttpClient:
    def __init__(self):
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url.endswith("/speech-to-text"):
            return FakeResponse({"text": "Harvest F1 tomorrow", "language_code": "en"})
        return FakeResponse(content=b"mp3-data", content_type="audio/mpeg")


class VoiceGatewayTests(unittest.TestCase):
    def test_complete_turn_runs_speech_farmopti_speech(self):
        gateway = VoiceGateway(FakeSpeech(), FakeConversation(), SessionStore(max_turns=2))
        result = gateway.process_turn(b"webm", "turn.webm", "audio/webm", "session-1")
        self.assertEqual(result.transcript.text, "Why was F2 sprayed?")
        self.assertIn("Grounded answer", result.reply.answer)
        self.assertTrue(result.audio.startswith(b"audio:"))
        self.assertEqual(len(result.history), 1)

    def test_sessions_are_bounded_and_can_be_cleared(self):
        store = SessionStore(max_sessions=1, max_turns=2)
        gateway = VoiceGateway(FakeSpeech(), FakeConversation(), store)
        for _ in range(3):
            gateway.respond("Question", "session-1")
        self.assertEqual(len(store.get("session-1")), 2)
        gateway.respond("Other", "session-2")
        self.assertEqual(store.get("session-1"), ())
        store.clear("session-2")
        self.assertEqual(store.get("session-2"), ())

    def test_elevenlabs_adapter_uses_server_key_and_models(self):
        http = FakeHttpClient()
        client = ElevenLabsVoiceClient(VoiceConfig(api_key="secret-test-key"), http)
        transcript = client.transcribe(b"audio", "turn.webm", "audio/webm")
        audio, content_type = client.synthesise("The current plan remains best.")
        self.assertEqual(transcript.text, "Harvest F1 tomorrow")
        self.assertEqual(audio, b"mp3-data")
        self.assertEqual(content_type, "audio/mpeg")
        self.assertEqual(http.calls[0][1]["headers"]["xi-api-key"], "secret-test-key")
        self.assertEqual(http.calls[1][1]["json"]["model_id"], "eleven_flash_v2_5")

    def test_transcription_multipart_is_encoded_as_bytes(self):
        import httpx

        def handler(request):
            body = request.read()
            self.assertIn(b'name="model_id"', body)
            self.assertIn(b'scribe_v2', body)
            self.assertIn(b'name="keyterms"', body)
            self.assertEqual(request.headers["xi-api-key"], "test-only")
            return httpx.Response(200, json={"text": "Why was F2 sprayed?"})

        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            client = ElevenLabsVoiceClient(VoiceConfig(api_key="test-only"), http)
            transcript = client.transcribe(b"webm", "turn.webm", "audio/webm")
        self.assertEqual(transcript.text, "Why was F2 sprayed?")

    def test_http_package_exposes_composable_and_complete_turns(self):
        from fastapi.testclient import TestClient

        client = TestClient(create_app(VoiceGateway(FakeSpeech(), FakeConversation())))
        self.assertEqual(client.get("/api/voice/health").json()["status"], "ready")

        response = client.post(
            "/api/voice/turn",
            files={"file": ("turn.webm", b"recording", "audio/webm")},
            data={"session_id": "farm-1", "include_audio": "true"},
        )
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["session_id"], "farm-1")
        self.assertEqual(result["transcript"]["text"], "Why was F2 sprayed?")
        self.assertTrue(result["audio_base64"])

        text_response = client.post(
            "/api/voice/respond",
            json={"session_id": "farm-1", "text": "What other times were feasible?"},
        )
        self.assertEqual(text_response.status_code, 200)
        self.assertEqual(len(text_response.json()["history"]), 2)

        speech_response = client.post(
            "/api/voice/speak",
            json={"text": "The schedule remains feasible."},
        )
        self.assertEqual(speech_response.headers["content-type"], "audio/mpeg")
        self.assertTrue(speech_response.content.startswith(b"audio:"))


if __name__ == "__main__":
    unittest.main()

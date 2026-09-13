from __future__ import annotations

from typing import Any

from voice_interface.config import VoiceConfig
from voice_interface.errors import (
    VoiceConfigurationError,
    VoiceInputError,
    VoiceProviderError,
)
from voice_interface.models import Transcript


SUPPORTED_AUDIO_TYPES = {
    "audio/aac", "audio/flac", "audio/m4a", "audio/mp4", "audio/mpeg",
    "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a", "audio/x-wav",
}


class ElevenLabsVoiceClient:
    """Small ElevenLabs adapter that keeps provider details out of FarmOpti."""

    def __init__(self, config: VoiceConfig, http_client: Any | None = None):
        self.config = config
        self._http_client = http_client

    @property
    def configured(self) -> bool:
        return bool(self.config.api_key and self.config.voice_id)

    @property
    def max_audio_bytes(self) -> int:
        return self.config.max_audio_bytes

    def _client(self):
        if not self.config.api_key:
            raise VoiceConfigurationError("ELEVENLABS_API_KEY is not configured on the server.")
        if self._http_client is not None:
            return self._http_client, False
        try:
            import httpx
        except ImportError as exc:
            raise VoiceConfigurationError(
                "Voice dependencies are missing. Install optimizer/requirements-voice.txt."
            ) from exc
        return httpx.Client(timeout=self.config.timeout_seconds), True

    def _raise_for_status(self, response) -> None:
        if 200 <= response.status_code < 300:
            return
        request_id = response.headers.get("request-id") or response.headers.get("x-request-id")
        detail = f"ElevenLabs request failed with status {response.status_code}"
        if request_id:
            detail += f" (request {request_id})"
        raise VoiceProviderError(detail)

    def transcribe(self, audio: bytes, filename: str, content_type: str) -> Transcript:
        if not audio:
            raise VoiceInputError("The audio recording is empty.")
        if len(audio) > self.config.max_audio_bytes:
            raise VoiceInputError(
                f"The recording exceeds the {self.config.max_audio_bytes // 1_000_000} MB limit."
            )
        clean_type = (content_type or "").split(";", 1)[0].lower()
        if clean_type not in SUPPORTED_AUDIO_TYPES:
            raise VoiceInputError(f"Unsupported audio type: {clean_type or 'unknown'}.")

        multipart = [
            ("file", (filename or "recording.webm", audio, clean_type)),
            ("model_id", (None, self.config.stt_model)),
            ("tag_audio_events", (None, "false")),
            ("diarize", (None, "false")),
        ]
        multipart.extend(("keyterms", (None, term)) for term in self.config.keyterms)
        client, owned = self._client()
        try:
            response = client.post(
                f"{self.config.base_url}/speech-to-text",
                headers={"xi-api-key": self.config.api_key},
                files=multipart,
            )
            self._raise_for_status(response)
            payload = response.json()
        except VoiceProviderError:
            raise
        except Exception as exc:
            raise VoiceProviderError("Could not transcribe the recording with ElevenLabs.") from exc
        finally:
            if owned:
                client.close()

        text = str(payload.get("text", "")).strip()
        if not text:
            raise VoiceProviderError("ElevenLabs returned an empty transcript.")
        return Transcript(
            text=text,
            language_code=payload.get("language_code"),
            provider_request_id=response.headers.get("request-id"),
        )

    def synthesise(self, text: str) -> tuple[bytes, str]:
        clean_text = " ".join(text.split()).strip()
        if not clean_text:
            raise VoiceInputError("The speech response is empty.")
        if len(clean_text) > self.config.max_reply_characters:
            clean_text = clean_text[: self.config.max_reply_characters].rsplit(" ", 1)[0] + "…"

        client, owned = self._client()
        try:
            response = client.post(
                f"{self.config.base_url}/text-to-speech/{self.config.voice_id}/stream",
                params={"output_format": self.config.output_format},
                headers={"xi-api-key": self.config.api_key, "Accept": "audio/mpeg"},
                json={
                    "text": clean_text,
                    "model_id": self.config.tts_model,
                    "voice_settings": {
                        "stability": 0.55,
                        "similarity_boost": 0.75,
                        "style": 0.0,
                        "use_speaker_boost": True,
                    },
                },
            )
            self._raise_for_status(response)
            audio = bytes(response.content)
        except VoiceProviderError:
            raise
        except Exception as exc:
            raise VoiceProviderError("Could not generate speech with ElevenLabs.") from exc
        finally:
            if owned:
                client.close()

        if not audio:
            raise VoiceProviderError("ElevenLabs returned empty speech audio.")
        return audio, response.headers.get("content-type", "audio/mpeg").split(";", 1)[0]

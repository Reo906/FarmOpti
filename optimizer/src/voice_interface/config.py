from __future__ import annotations

import os
from dataclasses import dataclass


DEFAULT_KEYTERMS = (
    "FarmOpti", "F1", "F2", "harvest", "harvester", "irrigate",
    "irrigation", "spray", "fertilise", "fertiliser", "plant",
    "wheat", "barley", "canola", "soil moisture", "pest pressure",
)


@dataclass(frozen=True)
class VoiceConfig:
    api_key: str
    voice_id: str = "JBFqnCBsd6RMkjVDRZzb"
    base_url: str = "https://api.elevenlabs.io/v1"
    stt_model: str = "scribe_v2"
    tts_model: str = "eleven_flash_v2_5"
    output_format: str = "mp3_22050_32"
    timeout_seconds: float = 60.0
    max_audio_bytes: int = 10_000_000
    max_reply_characters: int = 1_500
    keyterms: tuple[str, ...] = DEFAULT_KEYTERMS

    @classmethod
    def from_env(cls) -> "VoiceConfig":
        custom_keyterms = tuple(
            term.strip()
            for term in os.getenv("FARMOPTI_VOICE_KEYTERMS", "").split(",")
            if term.strip()
        )
        return cls(
            api_key=os.getenv("ELEVENLABS_API_KEY", "").strip(),
            voice_id=os.getenv("ELEVENLABS_VOICE_ID", cls.voice_id).strip(),
            base_url=os.getenv("ELEVENLABS_BASE_URL", cls.base_url).rstrip("/"),
            stt_model=os.getenv("ELEVENLABS_STT_MODEL", cls.stt_model).strip(),
            tts_model=os.getenv("ELEVENLABS_TTS_MODEL", cls.tts_model).strip(),
            output_format=os.getenv("ELEVENLABS_OUTPUT_FORMAT", cls.output_format).strip(),
            timeout_seconds=float(os.getenv("ELEVENLABS_TIMEOUT_SECONDS", cls.timeout_seconds)),
            max_audio_bytes=int(os.getenv("FARMOPTI_VOICE_MAX_AUDIO_BYTES", cls.max_audio_bytes)),
            max_reply_characters=int(os.getenv("FARMOPTI_VOICE_MAX_REPLY_CHARACTERS", cls.max_reply_characters)),
            keyterms=custom_keyterms or DEFAULT_KEYTERMS,
        )

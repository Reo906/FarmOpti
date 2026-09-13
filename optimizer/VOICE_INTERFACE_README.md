# FarmOpti ElevenLabs voice interface

This package adds speech input and output to the existing FarmOpti decision chatbot. ElevenLabs transcribes the farmer and voices FarmOpti's response. The existing **ExplanationService** still classifies the request, retrieves decision evidence, validates scenario changes, runs the optimiser, and generates the grounded answer.

## Boundary

~~~text
microphone
  -> ElevenLabs speech-to-text
  -> FarmOpti ExplanationService
     -> EXPLAIN: retrieve optimisation evidence
     -> SCENARIO: validate, run on copied inputs, compare with baseline
  -> ElevenLabs text-to-speech
  -> speaker + visible transcript
~~~

The package does not let ElevenLabs choose a farm action. Scenario questions remain temporary what-if runs. Any future endpoint that changes the active operating plan should require a separate explicit confirmation.

## Install and run

From the repository root:

~~~bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r optimizer/requirements-voice.txt
export ELEVENLABS_API_KEY="your server-side key"
python optimizer/voice_api.py
~~~

The API runs at **http://localhost:8000**. Interactive API documentation is available at **/docs**. The API key is read only from the server environment; never put it in browser code or commit it.

Open **http://localhost:8000/voice-demo** for the built-in test page. It supports push-to-talk, typed questions, visible transcripts, spoken replies, recent conversation history, and response metadata. Start with a typed question to verify FarmOpti and text-to-speech, then use the microphone to add speech-to-text to the test.

The existing FarmOpti conversation service also expects its configured Ollama model. With the repository defaults, ensure Ollama is running and the model is available:

~~~bash
ollama serve
ollama pull qwen2.5:3b
~~~

Browser microphone access works on localhost. Testing from a phone over a plain LAN HTTP address may be blocked by the browser; serve the app over HTTPS for a remote phone test.

The default voice ID is configurable. Override it with **ELEVENLABS_VOICE_ID**. Copy **optimizer/.env.example** for the complete list of settings, but export or load those settings through the team's deployment environment.

## API

### One-call browser flow

**POST /api/voice/turn** as multipart form data:

- **file**: WebM, MP4/M4A, MP3, WAV, FLAC, OGG, or AAC recording
- **session_id**: optional existing session
- **include_audio**: whether the JSON response should contain base64 MP3 audio

The response includes the transcript, FarmOpti answer, request mode, scenario comparison metadata, stage timings, recent session turns, and optional audio.

### Composable flow

- **POST /api/voice/transcribe** — audio file to transcript
- **POST /api/voice/respond** — text to FarmOpti answer
- **POST /api/voice/speak** — text to audio/mpeg
- **DELETE /api/voice/sessions/{session_id}** — clear in-memory transcript history
- **GET /api/voice/health** — configuration readiness

The composable endpoints let a frontend show and correct the transcript before sending it to FarmOpti. This is recommended when field noise makes recognition uncertain.

If the frontend is hosted on a different origin, list the permitted origins in **FARMOPTI_VOICE_ALLOWED_ORIGINS**. The standalone API does not enable cross-origin access by default.

## Plug into another FastAPI application

~~~python
from chatbot.explanation_service import ExplanationService
from voice_interface.api import create_voice_router
from voice_interface.config import VoiceConfig
from voice_interface.elevenlabs_client import ElevenLabsVoiceClient
from voice_interface.farmopti_adapter import FarmOptiConversationAdapter
from voice_interface.service import VoiceGateway

gateway = VoiceGateway(
    speech=ElevenLabsVoiceClient(VoiceConfig.from_env()),
    conversation=FarmOptiConversationAdapter(ExplanationService()),
)

app.include_router(create_voice_router(gateway))
~~~

The **SpeechProvider** and **ConversationBackend** protocols are intentionally small. The team can replace ElevenLabs, inject a pre-existing **ExplanationService**, or embed **VoiceGateway** without running the included HTTP API.

## Browser integration

**examples/browser_voice_client.js** contains a framework-independent push-to-talk client. It requests microphone access only when **start()** is called, records with browser noise suppression, uses the composable endpoints, retains the returned session ID, supports typed fallback through **sendText()**, plays the answer, and exposes these UI states:

~~~text
requesting_microphone -> listening -> transcribing -> evaluating -> speaking -> idle
~~~

The API returns recent turns for display, but FarmOpti currently evaluates each utterance as a self-contained request. Pronoun resolution across turns is deliberately outside this package's first version.

## Reliability and data handling

- Recordings are limited to 10 MB by default and held in memory.
- Session history is in-memory, bounded, and not written to disk.
- Provider errors do not expose the API key or response body.
- Transcription keyterms bias Scribe toward FarmOpti field IDs, crops, and operation names.
- ElevenLabs currently applies additional usage cost when keyterm prompting is enabled.
- FarmOpti calls are serialized until the scenario runner has explicit concurrency guarantees.
- Spoken responses are capped at 1,500 characters to control latency and cost.
- Text input and visible transcripts should remain available when microphone access, connectivity, or transcription fails.

## Verification

Tests use fake speech and conversation providers, so they make no network requests and incur no ElevenLabs usage:

~~~bash
cd optimizer
python -m unittest discover -s tests -v
~~~

Before merging, perform one live smoke test with a restricted ElevenLabs key:

1. Ask “Why was F2 sprayed?”
2. Confirm the visible transcript.
3. Confirm the answer matches the normal text chatbot.
4. Ask a self-contained scenario question.
5. Confirm the response reports the real scenario objective change.
6. Confirm the API key is absent from browser requests, logs, and committed files.

from typing import Annotated
import os
from pathlib import Path

from voice_interface.config import VoiceConfig
from voice_interface.constraint_store import ConstraintStore
from voice_interface.elevenlabs_client import ElevenLabsVoiceClient
from voice_interface.errors import VoiceInputError, VoiceInterfaceError
from voice_interface.farmopti_adapter import FarmOptiConversationAdapter
from voice_interface.service import VoiceGateway


def build_default_gateway() -> VoiceGateway:
    optimizer_dir = Path(__file__).resolve().parents[2]
    constraints = ConstraintStore.from_env(
        default_path=optimizer_dir / "runtime" / "confirmed_constraints.json"
    )
    return VoiceGateway(
        speech=ElevenLabsVoiceClient(VoiceConfig.from_env()),
        conversation=FarmOptiConversationAdapter(
            active_constraints=constraints.active_scenario
        ),
        constraints=constraints,
    )


def create_voice_router(gateway: VoiceGateway):
    try:
        from fastapi import APIRouter, File, Form, HTTPException, UploadFile
        from pydantic import BaseModel, Field
        from starlette.responses import Response
    except ImportError as exc:
        raise RuntimeError(
            "Voice API dependencies are missing. Install optimizer/requirements-voice.txt."
        ) from exc

    class TextTurnRequest(BaseModel):
        text: str = Field(min_length=1, max_length=2_000)
        session_id: str | None = Field(default=None, max_length=100)

    class SpeechRequest(BaseModel):
        text: str = Field(min_length=1, max_length=4_000)

    class ConstraintActionRequest(BaseModel):
        session_id: str = Field(min_length=1, max_length=100)
        proposal_id: str | None = Field(default=None, max_length=100)

    router = APIRouter(prefix="/api/voice", tags=["FarmOpti voice"])

    def api_error(exc: Exception):
        if isinstance(exc, VoiceInputError):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if isinstance(exc, VoiceInterfaceError):
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        raise HTTPException(status_code=500, detail="FarmOpti could not complete the voice turn.") from exc

    @router.get("/health")
    def health():
        return {
            "status": "ready" if gateway.configured else "needs_configuration",
            "elevenlabs_configured": gateway.configured,
            "confirmed_constraints": len(gateway.constraints.confirmed()),
        }

    @router.post("/transcribe")
    async def transcribe(file: Annotated[UploadFile, File()]):
        try:
            audio = await file.read(gateway.speech.max_audio_bytes + 1)
            transcript = gateway.transcribe(audio, file.filename or "recording.webm", file.content_type or "")
            return transcript.to_dict()
        except Exception as exc:
            api_error(exc)

    @router.post("/respond")
    def respond(request: TextTurnRequest):
        try:
            session_id, reply, history = gateway.respond(request.text, request.session_id)
            return {
                "session_id": session_id,
                "reply": reply.to_dict(),
                "history": [turn.to_dict() for turn in history],
            }
        except Exception as exc:
            api_error(exc)

    @router.post("/speak")
    def speak(request: SpeechRequest):
        try:
            audio, content_type = gateway.speak(request.text)
            return Response(content=audio, media_type=content_type)
        except Exception as exc:
            api_error(exc)

    @router.post("/turn")
    async def complete_turn(
        file: Annotated[UploadFile, File()],
        session_id: Annotated[str | None, Form()] = None,
        include_audio: Annotated[bool, Form()] = True,
    ):
        try:
            audio = await file.read(gateway.speech.max_audio_bytes + 1)
            turn = gateway.process_turn(
                audio,
                file.filename or "recording.webm",
                file.content_type or "",
                session_id=session_id,
                include_audio=include_audio,
            )
            return turn.to_dict(include_audio=include_audio)
        except Exception as exc:
            api_error(exc)

    @router.delete("/sessions/{session_id}")
    def clear_session(session_id: str):
        gateway.sessions.clear(session_id)
        gateway.constraints.clear_pending(session_id)
        return {"session_id": session_id, "cleared": True}

    @router.get("/constraints")
    def confirmed_constraints():
        return {
            "constraints": [
                constraint.to_dict()
                for constraint in gateway.constraints.confirmed()
            ]
        }

    @router.get("/sessions/{session_id}/constraint-proposal")
    def pending_constraint(session_id: str):
        proposal = gateway.constraints.pending(session_id)
        return {"proposal": proposal.to_dict() if proposal else None}

    @router.post("/constraints/confirm")
    def confirm_constraint(request: ConstraintActionRequest):
        try:
            proposal = gateway.confirm_constraint(request.session_id, request.proposal_id)
            return {"constraint": proposal.to_dict()}
        except Exception as exc:
            api_error(exc)

    @router.post("/constraints/reject")
    def reject_constraint(request: ConstraintActionRequest):
        try:
            proposal = gateway.reject_constraint(request.session_id, request.proposal_id)
            return {"constraint": proposal.to_dict()}
        except Exception as exc:
            api_error(exc)

    return router


def create_app(gateway: VoiceGateway | None = None):
    try:
        from fastapi import FastAPI
        from fastapi.responses import FileResponse
    except ImportError as exc:
        raise RuntimeError(
            "Voice API dependencies are missing. Install optimizer/requirements-voice.txt."
        ) from exc
    app = FastAPI(
        title="FarmOpti Voice API",
        version="0.1.0",
        description="Speech input/output adapter for the existing FarmOpti optimiser conversation service.",
    )
    allowed_origins = [
        origin.strip()
        for origin in os.getenv("FARMOPTI_VOICE_ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if allowed_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["Content-Type"],
        )
    app.include_router(create_voice_router(gateway or build_default_gateway()))

    examples_dir = Path(__file__).resolve().parents[2] / "examples"

    @app.get("/voice-demo", include_in_schema=False)
    def voice_demo():
        return FileResponse(examples_dir / "voice_demo.html", media_type="text/html")

    @app.get("/voice-demo/client.js", include_in_schema=False)
    def voice_demo_client():
        return FileResponse(
            examples_dir / "browser_voice_client.js",
            media_type="text/javascript",
        )

    return app

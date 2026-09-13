from __future__ import annotations

import json
import os
import tempfile
import uuid
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from voice_interface.errors import VoiceInputError


@dataclass(frozen=True)
class ConstraintProposal:
    proposal_id: str
    session_id: str
    source_text: str
    scenario: dict[str, Any]
    resolved_changes: list[dict[str, Any]]
    comparison: dict[str, Any]
    summary: dict[str, Any]
    schedule: list[dict[str, Any]]
    status: str
    created_at: str
    confirmed_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ConstraintStore:
    """Thread-safe proposal store with optional JSON persistence for confirmed rules."""

    def __init__(self, path: str | Path | None = None, max_confirmed: int = 100):
        self.path = Path(path) if path else None
        self.max_confirmed = max_confirmed
        self._pending: dict[str, ConstraintProposal] = {}
        self._confirmed: list[ConstraintProposal] = []
        self._lock = Lock()
        self._load()

    @classmethod
    def from_env(cls, default_path: str | Path | None = None) -> "ConstraintStore":
        configured = os.getenv("FARMOPTI_CONSTRAINT_STORE_PATH")
        if configured is not None and not configured.strip():
            return cls()
        return cls(configured or default_path)

    def _load(self) -> None:
        if not self.path or not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            records = payload.get("confirmed", []) if isinstance(payload, dict) else []
            self._confirmed = [ConstraintProposal(**record) for record in records]
        except (OSError, TypeError, ValueError) as exc:
            raise RuntimeError(f"Could not load confirmed FarmOpti constraints from {self.path}: {exc}") from exc

    def _persist(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "confirmed": [proposal.to_dict() for proposal in self._confirmed],
        }
        handle, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=self.path.parent,
            text=True,
        )
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as temporary:
                json.dump(payload, temporary, indent=2)
                temporary.write("\n")
            os.replace(temporary_name, self.path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise

    def propose(self, session_id: str, source_text: str, evaluation: dict[str, Any]) -> ConstraintProposal:
        scenario = evaluation.get("scenario")
        if not isinstance(scenario, dict) or not scenario.get("changes"):
            raise VoiceInputError("FarmOpti did not return a validated constraint change.")
        proposal = ConstraintProposal(
            proposal_id=str(uuid.uuid4()),
            session_id=session_id,
            source_text=source_text,
            scenario=deepcopy(scenario),
            resolved_changes=deepcopy(evaluation.get("resolved_changes") or []),
            comparison=deepcopy(evaluation.get("comparison") or {}),
            summary=deepcopy(evaluation.get("summary") or {}),
            schedule=deepcopy(evaluation.get("schedule") or []),
            status="pending_confirmation",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        with self._lock:
            self._pending[session_id] = proposal
        return proposal

    def pending(self, session_id: str) -> ConstraintProposal | None:
        with self._lock:
            return self._pending.get(session_id)

    def confirm(self, session_id: str, proposal_id: str | None = None) -> ConstraintProposal:
        with self._lock:
            proposal = self._pending.get(session_id)
            if proposal is None:
                raise VoiceInputError("There is no pending constraint change in this session.")
            if proposal_id and proposal.proposal_id != proposal_id:
                raise VoiceInputError("The pending constraint proposal does not match that proposal ID.")
            confirmed = ConstraintProposal(
                **{
                    **proposal.to_dict(),
                    "status": "confirmed",
                    "confirmed_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            self._confirmed.append(confirmed)
            self._confirmed = self._confirmed[-self.max_confirmed :]
            del self._pending[session_id]
            self._persist()
            return confirmed

    def reject(self, session_id: str, proposal_id: str | None = None) -> ConstraintProposal:
        with self._lock:
            proposal = self._pending.get(session_id)
            if proposal is None:
                raise VoiceInputError("There is no pending constraint change in this session.")
            if proposal_id and proposal.proposal_id != proposal_id:
                raise VoiceInputError("The pending constraint proposal does not match that proposal ID.")
            rejected = ConstraintProposal(**{**proposal.to_dict(), "status": "rejected"})
            del self._pending[session_id]
            return rejected

    def clear_pending(self, session_id: str) -> None:
        with self._lock:
            self._pending.pop(session_id, None)

    def confirmed(self) -> tuple[ConstraintProposal, ...]:
        with self._lock:
            return tuple(self._confirmed)

    def active_scenario(self) -> dict[str, Any] | None:
        with self._lock:
            changes = [
                deepcopy(change)
                for proposal in self._confirmed
                for change in proposal.scenario.get("changes", [])
            ]
        if not changes:
            return None
        return {
            "mode": "scenario",
            "description": "Confirmed farmer constraints",
            "changes": changes,
        }

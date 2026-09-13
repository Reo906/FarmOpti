# FarmOpti voice interaction feature

## Product intent

This feature gives farmers a conversational layer over FarmOpti. A farmer can speak instead of navigating a laptop in the field, hear the response, and still see the transcript and optimizer evidence on a phone, tablet, or dashboard.

The voice layer supports two connected jobs:

1. **Understand the dashboard and plan.** Ask about scheduled work, timing, resources, feasibility, alternatives, costs, and why the optimizer selected or skipped an action.
2. **Share farmer knowledge as constraints.** State a concrete operational rule or changed condition, preview the re-optimized plan, and explicitly confirm or discard the change.

ElevenLabs supplies speech-to-text and text-to-speech. It does not select farm actions or edit optimizer data. FarmOpti classifies the request, retrieves decision evidence, validates proposed changes against its schema, runs the mathematical optimizer, and produces the grounded response.

## Intended experience

For a dashboard question:

~~~text
Farmer speaks
  -> ElevenLabs transcribes
  -> FarmOpti reads optimization evidence
  -> dashboard receives the answer and metadata
  -> ElevenLabs speaks the answer
~~~

For experiential knowledge or a constraint change:

~~~text
Farmer: "Do not spray F2."
  -> transcript is shown
  -> FarmOpti converts the request to its validated scenario DSL
  -> the change is applied to temporary inputs
  -> the optimizer compares the proposed schedule with the baseline
  -> FarmOpti explains the operational and financial impact
  -> farmer says "confirm change" or "cancel change"
  -> a confirmed rule is stored and exposed to the dashboard/optimizer
~~~

The confirmation boundary is deliberate. Speech recognition or field noise cannot silently activate an operating constraint.

## What is implemented

- Push-to-talk browser recording plus typed fallback.
- ElevenLabs Scribe transcription and ElevenLabs speech generation.
- A provider-neutral Python package that can wrap the current FarmOpti chatbot or another dashboard conversation backend.
- Questions grounded in the existing optimizer decision evidence.
- Natural-language scenario changes for exposed FarmOpti inputs such as action selection and timing, water, labour, machines, economics, weather, field state, and management-plan values.
- Validation against real table names, fields, identifiers, types, and allowed operators before optimization.
- Re-optimization on temporary input copies and comparison with the baseline plan.
- A pending proposal for every valid spoken scenario, with voice/text confirmation and cancellation commands.
- Optional JSON persistence for confirmed farmer constraints.
- Confirmed constraints automatically included in later voice scenario evaluations.
- REST endpoints that let the dashboard retrieve pending and confirmed constraint records, including the evaluated schedule and comparison.
- A built-in test interface at **http://localhost:8000/voice-demo**.

## Constraint lifecycle

1. **Proposed** — FarmOpti has transcribed, parsed, validated, and evaluated the requested change. Nothing is active yet.
2. **Confirmed** — the farmer explicitly confirms the pending proposal. It is persisted when **FARMOPTI_CONSTRAINT_STORE_PATH** is configured and becomes part of future voice scenario evaluations.
3. **Rejected** — the farmer cancels the proposal. It is removed without changing the active constraint set.

Only the latest pending proposal is retained per conversation session. Confirmed constraints are process-wide because they represent shared farm operating knowledge.

## Dashboard integration contract

The host dashboard can use the composable endpoints to show the transcript before evaluation and render answers, scenario comparisons, and confirmation controls:

- **POST /api/voice/transcribe** — recording to transcript
- **POST /api/voice/respond** — transcript or typed text to a FarmOpti response
- **POST /api/voice/speak** — response text to audio
- **GET /api/voice/sessions/{session_id}/constraint-proposal** — current pending proposal
- **POST /api/voice/constraints/confirm** — activate the pending proposal
- **POST /api/voice/constraints/reject** — discard the pending proposal
- **GET /api/voice/constraints** — confirmed constraints and evaluated schedules

A dashboard can also send “confirm change” or “cancel change” through **/respond**, which makes the same workflow usable entirely by voice.

The framework-independent client in **examples/browser_voice_client.js** can be embedded in the existing interface. Applications with a different optimizer or dashboard model can implement the small **ConversationBackend** protocol and keep the speech and confirmation layers unchanged.

## Model boundary

Farmer knowledge must be expressible using an input or constraint exposed by the current optimizer schema. For example, FarmOpti can represent “do not spray F2,” “harvest F1 on September 25,” or “three more megalitres are available on September 20.” It will reject a rule involving an unknown concept rather than pretend the model enforces it.

Supporting open-ended knowledge such as “the west access track becomes boggy after sustained rain” requires adding an access-track variable and its scheduling effect to the optimizer first. Once that variable is exposed, the existing voice parser, validator, proposal, confirmation, and persistence flow can carry the rule.

Confirmed records are structured constraint overlays and include the schedule evaluated at confirmation time. The main dashboard decides when to promote that evaluated schedule into its displayed operating plan. A production deployment should add user identity, role-based permissions, an audit log, expiry and rollback controls, and a final operational authorization step appropriate to the farm.

## Run and verify

See [VOICE_INTERFACE_README.md](VOICE_INTERFACE_README.md) for installation, environment variables, API examples, automated tests, and the live smoke-test checklist.

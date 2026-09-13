# Voice Interface — ElevenLabs + FarmOpti

Branch: **`feature/voice-ui`** (based on `UI-design`)

This adds a push-to-talk voice layer to the Yallambee Ops dashboard. A farmer in the field can speak a question or a rule, hear the response aloud, and confirm it as a persistent constraint — all without touching a laptop.

ElevenLabs handles speech-to-text and text-to-speech only. All decision-making, scheduling, and constraint validation stays inside FarmOpti.

---

## How to run it

**Prerequisites:** Node.js 22+, npm, Ollama running locally with `qwen2.5-coder:7b-instruct`.

```bash
# 1. Install dependencies (if not already done)
cd system
npm install

# 2. Create your .env file
cp .env.example .env
```

Open `system/.env` and fill in:

```
ELEVENLABS_API_KEY=your_key_here
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb   # any ElevenLabs voice ID
```

Leave `LLM_API_KEY` empty — the chatbot uses Ollama locally.

```bash
# 3. Start Ollama (separate terminal)
ollama serve
ollama pull qwen2.5-coder:7b-instruct   # first time only

# 4. Start the app
npm run dev
```

Open **http://localhost:3000**.

---

## What to test

All three turns are in the **Decision assistant** card on the Command page.

### Turn 1 — Ask a question by voice
1. Hold the mic button and say: *"What is today's plan?"*
2. Release. The transcript appears, FarmOpti retrieves the optimisation evidence, and the answer is spoken back.
3. You should see the answer in the chat log and hear it through your speakers.

### Turn 2 — Ask a grounded explanation
1. Hold the mic and say: *"Why is F2 being sprayed?"*
2. FarmOpti pulls the counterfactual evidence and explains the weed-pressure and yield-penalty reasoning.

### Turn 3 — Propose and confirm a constraint (the key demo)
1. Say (or type): *"Do not spray F2."*
2. A **Confirm change / Cancel** card appears below the chat log, showing the objective change and rescheduled actions.
3. Click **Confirm change** (or say *"confirm change"*).
4. The **Active farm rules** panel appears below the assistant with the confirmed rule.
5. Ask *"What is today's plan?"* again — the new schedule no longer includes F2 spraying.

### Text fallback
Everything above works by typing into the input box too. The voice transcription is just the input layer.

---

## Architecture

```
ElevenLabs STT                   ElevenLabs TTS
     |                                 ^
     v                                 |
POST /api/voice/transcribe    POST /api/voice/speak
     |                                 |
     v                                 |
POST /api/voice/respond ─────────────>─┘
     |
     |── confirm/cancel command? ──> ConstraintStore.confirm/reject
     |
     └── regular question ──> ExplanationService.answer(text, { scenarioOverlay })
                                        |
                              classify: explain | scenario
                                        |
                              explain ──> retrieve evidence ──> LLM answer
                                        |
                              scenario ─> parse DSL ──> validate ──> run optimizer
                                                                      |
                                                            requestedScenario (new rule only)
                                                            effectiveScenario (rule + confirmed overlay)
                                                                      |
                                                         ConstraintStore.propose()
                                                         (stores requestedScenario only — no duplication)
```

### Key files

| File | Purpose |
|---|---|
| `system/lib/voice/elevenlabs.ts` | ElevenLabs STT (`transcribe`) and TTS (`speak`) |
| `system/lib/voice/constraintStore.ts` | Pending / confirmed rules, JSON persistence, `activeScenario()` overlay |
| `system/app/api/voice/transcribe/route.ts` | Audio → transcript |
| `system/app/api/voice/respond/route.ts` | Text → FarmOpti answer + proposal creation |
| `system/app/api/voice/speak/route.ts` | Text → MP3 audio |
| `system/app/api/voice/constraints/route.ts` | List confirmed rules |
| `system/app/api/voice/constraints/confirm/route.ts` | Activate a pending rule |
| `system/app/api/voice/constraints/reject/route.ts` | Discard a pending rule |
| `system/app/api/voice/sessions/[sessionId]/proposal/route.ts` | Get pending rule for a session |
| `system/components/YallambeeDashboard.tsx` | `DecisionAssistant` component — mic button, playback, proposal card |
| `system/components/ConfirmedConstraintsPanel.tsx` | Active rules display |
| `system/lib/optimizer/chatbot/explanationService.ts` | `answer()` extended with `scenarioOverlay` param |
| `system/lib/optimizer/chatbot/scenario/runner.ts` | `ScenarioRunResult` extended with `requestedScenario` |

---

## Integrating into the main program

### 1. Merge the branch

```bash
git checkout UI-design
git merge feature/voice-ui
```

### 2. Add your ElevenLabs key

```bash
echo "ELEVENLABS_API_KEY=your_key" >> system/.env
echo "ELEVENLABS_VOICE_ID=your_voice_id" >> system/.env
```

### 3. The voice panel is already in the dashboard

`DecisionAssistant` in `YallambeeDashboard.tsx` already has the mic button and proposal card wired in. No extra mounting needed — it's live the moment the branch is merged.

### 4. Confirmed constraints persist across restarts

By default, confirmed rules are saved to `system/runtime/confirmed_constraints.json`. The file is created automatically on the first confirmation. Set `FARMOPTI_CONSTRAINT_STORE_PATH=` (empty) in `.env` to disable persistence and keep rules in memory only.

### 5. Run the tests

```bash
cd system
npm test
```

All 6 voice unit tests should pass, including the multi-rule regression test that ensures confirmed constraints do not duplicate when two rules are confirmed in sequence.

---

## Design decisions worth knowing

**Why ElevenLabs is STT/TTS only.** The voice layer transcribes and synthesises. It never classifies, parses, or decides anything. FarmOpti's deterministic pipeline (classifier → DSL parser → validator → LP solver) is the only thing that produces decisions.

**Why there is a confirmation step.** Voice recognition in a noisy field environment is imperfect. A two-step propose-then-confirm flow means no constraint can be activated by mishearing. The farmer sees the preview (re-optimised schedule + objective change) before the rule takes effect.

**Why `requestedScenario` is stored separately from `scenario`.** When rules accumulate, each new proposal is evaluated against the full overlay of confirmed rules (so the preview is accurate). But only the farmer's new rule is persisted, not the merged overlay. This prevents prior rules from being duplicated every time a new one is confirmed.

**Why the API key is server-only.** `ELEVENLABS_API_KEY` is read in the API routes, never exposed to the browser. The client only speaks to `/api/voice/*`.

---

## Known limitations (follow-up work)

- **Cloudflare Workers deploy:** `ConstraintStore` uses `node:fs`. For a Workers production deploy, swap it for a KV or D1 binding. The `ScenarioRunner` also uses `os.tmpdir` — same issue.
- **Auth and audit:** Confirmed constraints are process-wide with no user identity or audit log. A production deployment needs role-based permissions and an audit trail.
- **Rollback:** There is no endpoint to remove a confirmed rule. Add a `DELETE /api/voice/constraints/:proposalId` route and a corresponding `ConstraintStore.remove()` method.
- **Mic access:** The browser must be served over HTTPS (or localhost) to access `getUserMedia`. Works in dev; requires a TLS certificate in production.

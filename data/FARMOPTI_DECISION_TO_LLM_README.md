# FarmOpti: Decision Extraction to LLM Explanation

This document explains how FarmOpti converts optimisation results into grounded natural-language responses.

The core design principle is:

```text
The optimiser makes decisions.
Deterministic code extracts evidence.
The LLM only interprets the evidence and communicates it.
```

The LLM is never asked to infer the reason for a scheduling decision directly from the final schedule.

---

## 1. High-Level Architecture

```text
FarmOpti optimisation
        ↓
Optimal schedule + field options
        ↓
Decision extraction
        ↓
Counterfactual analysis
        ↓
decision_trace.json
        ↓
Decision indexing
        ↓
decision_index.jsonl
        ↓
────────────────────────────────────────
User question
        ↓
Request classification
        │
        ├── EXPLAIN
        │      ↓
        │  Decision retrieval
        │      ↓
        │  Evidence consolidation
        │      ↓
        │  LLM explanation
        │
        └── SCENARIO
               ↓
           Scenario parser
               ↓
           Deterministic validation
               ↓
           Re-optimisation
               ↓
           Baseline comparison
               ↓
           LLM explanation
```

There are therefore two distinct stages:

1. **Decision evidence generation** — performed after optimisation.
2. **User interaction** — performed when the user asks a question.

---

# 2. Optimisation Outputs

The explanation system starts from the normal FarmOpti optimisation outputs:

```text
optimizer/outputs/
├── candidate_actions.csv
├── field_options.json
├── optimal_schedule.csv
└── optimization_summary.json
```

These contain the actual optimisation result:

- feasible action candidates;
- retained field-level strategies;
- selected whole-farm schedule;
- machine assignments;
- resource use;
- objective values.

These outputs tell us **what was selected**, but by themselves they are not always sufficient to explain **why**.

For that reason, FarmOpti generates an additional structured decision-evidence layer.

---

# 3. Decision Extraction

Implemented mainly in:

```text
lib/optimizer/decisionAnalysis/extractDecisions.ts
```

The decision analyser converts optimisation outputs into structured decision records.

It extracts evidence at several levels:

```text
Action decision
Timing decision
State transition
Field-option decision
Resource utilisation
Financial effect
```

The objective is to produce factual evidence before any LLM is involved.

---

## 3.1 Action Decision

For every management-plan action, the analyser records information such as:

```text
plan_id
field_id
operation
required
selected / skipped
selected candidate
selected time
```

Example:

```json
{
  "plan_id": "P03",
  "field_id": "F2",
  "operation": "spray",
  "required": false,
  "selected": true
}
```

This establishes the basic decision:

```text
P03 was selected.
```

---

# 4. Financial Evidence

For selected actions, FarmOpti records the immediate financial effect.

For an action \(a\):

\[
CF_a = R_a - C_a
\]

where:

- \(CF_a\) is the direct cash effect;
- \(R_a\) is immediate revenue;
- \(C_a\) is immediate cost.

For treatment actions such as spraying, irrigation and fertilisation:

\[
R_a = 0
\]

so the direct cash effect is usually negative.

Example:

```json
{
  "direct_cash_effect_aud": -747.0
}
```

This does **not** mean the action reduced the final whole-farm objective.

The treatment can modify field state and increase later crop value.

---

# 5. Field-State Transition Evidence

The selected actions are replayed through:

```text
lib/optimizer/fieldSimulator.ts
```

For each action, FarmOpti records:

```text
state before action
        ↓
action
        ↓
state after action
```

Example:

```json
{
  "pest_pressure": {
    "before": 0.46,
    "after": 0.046
  },
  "expected_yield_t_ha": {
    "before": 3.006,
    "after": 3.3171
  }
}
```

This allows the explanation system to describe the agronomic mechanism:

```text
spray
  ↓
lower pest pressure
  ↓
higher simulated expected yield
  ↓
higher crop value
```

The LLM is not asked to invent this causal chain. It receives the measured state transition.

---

# 6. Timing Evidence

For selected actions, the analyser also records timing evidence such as:

```text
selected time
earliest feasible time
latest feasible time
number of feasible candidates
alternative feasible timings
```

Example:

```json
{
  "selected_time": "2026-09-17T07:00:00",
  "earliest_feasible_time": "2026-09-16T07:00:00",
  "latest_feasible_time": "2026-09-22T13:00:00",
  "feasible_candidate_count": 18
}
```

This supports questions such as:

```text
Why was this date selected?
Could the action have happened later?
What other timings were feasible?
```

---

# 7. Field-Option Evidence

FarmOpti does not optimise each action independently.

The beam-search stage generates field-level action combinations:

```text
field_options.json
```

For a field, alternatives might be:

```text
Option A
- skip irrigation
- spray
- fertilise

Option B
- irrigate
- skip spray
- fertilise
```

The selected field option is compared with retained alternatives.

The decision evidence can therefore include:

```text
selected field option
selected field objective
direct cash component
terminal crop value
best retained alternative
difference from alternative
```

This captures action interactions within a field.

---

# 8. Counterfactual Analysis

Implemented in:

```text
lib/optimizer/decisionAnalysis/analyseCounterfactuals.ts
```

Counterfactual analysis provides stronger evidence than simply reading the selected schedule.

The optimiser is rerun after deliberately changing one decision.

---

## 8.1 Selected Optional Action

If optional action \(a\) was selected, FarmOpti reruns the optimisation while forbidding that action.

Baseline:

\[
V^*
\]

Counterfactual:

\[
V^*_{\neg a}
\]

Stored objective change:

\[
\Delta V = V^*_{\neg a} - V^*
\]

Example:

```text
Baseline objective:       $100,000
Without P03:               $97,913
Objective change:          -$2,087
```

This means:

```text
Removing P03 makes the best whole-farm solution approximately $2,087 worse.
```

This is strong evidence that P03 contributed positively to the selected plan.

---

## 8.2 Skipped Optional Action

If optional action \(a\) was skipped, FarmOpti reruns the optimiser while forcing it.

\[
\Delta V = V^*_{force(a)} - V^*
\]

If:

\[
\Delta V < 0
\]

then forcing the skipped action reduces the best achievable whole-farm objective.

This provides direct evidence for why the optimiser omitted the action.

---

## 8.3 Global Schedule Effects

Counterfactual analysis can also identify other actions that change as a consequence.

For example:

```text
force P12
    ↓
uses a shared machine
    ↓
P04 is rescheduled
    ↓
whole-farm objective changes
```

The recorded counterfactual can therefore contain:

```text
actions added
actions removed
actions rescheduled
objective change
```

This is important because the value of an action may depend on whole-farm interactions rather than only its local cost.

---

# 9. Canonical Decision Trace

The complete structured evidence is stored in:

```text
optimizer/outputs/decision_trace.json
```

Conceptually:

```json
{
  "summary": {
    "total_objective_value_aud": 100000
  },

  "actions": [
    {
      "plan_id": "P03",
      "field_id": "F2",
      "operation": "spray",
      "selected": true,
      "financial": {},
      "timing": {},
      "state_transition": {},
      "counterfactual": {},
      "importance": 0.83
    }
  ],

  "field_decisions": [],
  "resources": [],
  "counterfactuals": []
}
```

This file is the canonical evidence source.

It stores structured facts rather than generated prose.

---

# 10. Decision Importance

Not every decision should be included in every explanation.

FarmOpti therefore calculates an importance score using evidence such as:

```text
counterfactual objective impact
direct financial magnitude
optional vs required status
structural infeasibility
```

The importance score is primarily used for:

```text
default schedule summaries
retrieval ranking
prioritising major decisions
```

The underlying evidence remains available even for low-importance decisions.

---

# 11. Decision Indexing

Implemented in:

```text
lib/optimizer/decisionAnalysis/buildDecisionIndex.ts
```

The full `decision_trace.json` is hierarchical and relatively large.

For retrieval, it is decomposed into atomic decision records and stored in:

```text
optimizer/outputs/decision_index.jsonl
```

Example records:

```text
P03:selection
P03:counterfactual
P03:state
P03:timing
F2:field_option
water:2026-09-20
```

Each indexed record contains metadata such as:

```text
decision_id
type
plan_id
field_id
operation
selected
required
importance
text
```

The index is used for retrieval.

The detailed numerical evidence remains in `decision_trace.json`.

---

# 12. User Request Classification

Runtime interaction begins in:

```text
lib/optimizer/chatbot/explanationService.ts
```

Before retrieving evidence or changing the optimisation problem, FarmOpti classifies the request into one of two modes:

```text
EXPLAIN
SCENARIO
```

The classification prompt is kept in `explanationService.ts`.

It is separate from the scenario parser.

---

## 12.1 EXPLAIN

Use `EXPLAIN` when the user is asking about the existing optimisation result.

Examples:

```text
Why was F2 sprayed?
Why was P12 skipped?
Could F1 have been harvested later?
What harvest dates were feasible?
Why was this timing selected?
Was water a limiting constraint?
```

These questions are answered from existing decision evidence.

No new optimisation is required.

---

## 12.2 SCENARIO

Use `SCENARIO` when the user explicitly specifies a changed condition that should be evaluated.

Examples:

```text
What if F1 is harvested on 2026-09-25?
Add 3 ML of water on September 20.
Do not spray F2.
Increase wheat price to 450 AUD/t.
Make irrigation in F3 mandatory.
```

These requests modify the optimisation problem and therefore require re-optimisation.

---

## 12.3 Structured Classification

The classifier does not return free-form text.

It is constrained to a small schema:

```json
{
  "mode": "explain"
}
```

or:

```json
{
  "mode": "scenario"
}
```

The classification LLM does not need to understand the complete scenario DSL.

Its only responsibility is deciding which processing path should be used.

---

# 13. EXPLAIN Path: Decision Retrieval

For an explanation request, FarmOpti calls:

```text
lib/optimizer/chatbot/retrieveDecisions.ts
```

Example:

```text
Why was F2 sprayed?
```

The retriever extracts query metadata:

```text
field_id = F2
operation = spray
```

It then resolves the relevant plan:

```text
F2 + spray
    ↓
P03
```

Once a target decision is resolved, FarmOpti retrieves evidence associated with that decision.

Typical result:

```text
P03:selection
P03:counterfactual
P03:state
P03:timing
```

This prevents unrelated decisions from contaminating the explanation.

---

# 14. General Retrieval

If a precise target cannot be resolved, FarmOpti uses weighted retrieval.

The score combines:

\[
S =
w_t S_{text}
+
S_{metadata}
+
w_i I
\]

where:

- \(S_{text}\): lexical similarity;
- \(S_{metadata}\): plan, field, operation and evidence-type matching;
- \(I\): decision importance.

The weights are configurable in:

```text
optimizer/config.yaml
```

---

# 15. Evidence Consolidation

Retrieved records are not sent independently to the LLM.

For example:

```text
P03:selection
P03:counterfactual
P03:state
P03:timing
```

are consolidated into one object:

```json
{
  "plan_id": "P03",
  "field_id": "F2",
  "operation": "spray",

  "action_evidence": {
    "selected": true,
    "required": false,

    "financial": {
      "direct_cash_effect_aud": -747
    },

    "state_changes": {
      "pest_pressure": {
        "before": 0.46,
        "after": 0.046
      }
    },

    "counterfactual": {
      "baseline_objective_aud": 100000,
      "counterfactual_objective_aud": 97912.91,
      "objective_change_aud": -2087.09
    },

    "timing": {}
  }
}
```

This reduces:

```text
duplicate context
irrelevant evidence
LLM latency
risk of confusing different plans
```

---

# 16. LLM Explanation

The consolidated evidence is then passed to the LLM.

The LLM receives:

```text
user question
+
structured optimiser evidence
+
strict explanation instructions
```

The explanation prompt tells the model to:

```text
answer only the requested decision
use only supplied evidence
do not invent causal explanations
distinguish direct cost from total objective impact
use state transitions where relevant
use counterfactuals as strong decision evidence
do not confuse forced scenarios with the baseline schedule
state when evidence is insufficient
```

The LLM's role is therefore:

```text
structured evidence
        ↓
natural-language explanation
```

not:

```text
schedule
        ↓
guess why the optimiser chose it
```

---

# 17. Example EXPLAIN Flow

User:

```text
Why was F2 sprayed?
```

Processing:

```text
1. Classifier → EXPLAIN

2. Query metadata:
   field=F2
   operation=spray

3. Target resolution:
   F2 + spray → P03

4. Retrieval:
   P03:selection
   P03:counterfactual
   P03:state
   P03:timing

5. Evidence consolidation

6. LLM explanation
```

Possible evidence:

```text
direct spray cost: -$747
pest pressure: 0.46 → 0.046
expected yield: 3.006 → 3.317 t/ha
best solution without P03: approximately $2,087 worse
```

Possible final response:

```text
F2 was sprayed because the action improved the value of the overall farm plan despite its direct cost. The spray cost $747, reduced simulated pest pressure from 0.46 to 0.046, and increased expected yield from 3.006 to 3.317 t/ha. When the optimiser was rerun without P03, the best whole-farm objective was approximately $2,087 lower.
```

Every factual statement comes from optimiser-generated evidence.

---

# 18. SCENARIO Path

Scenario functionality is isolated under:

```text
optimizer/src/chatbot/scenario/
├── parser.ts
├── validator.ts
├── runner.ts
└── comparator.ts
```

Once `explanationService.ts` classifies the request as `SCENARIO`, it sends the request to `chatbot/scenario/parser.ts`.

The parser does **not** classify requests.

At this point, the request is already known to represent a scenario modification.

---

# 19. Scenario Parsing

The scenario parser converts natural language into a generic structured modification.

Example:

```text
What if the harvest day in F1 changes to 2026-09-25?
```

becomes conceptually:

```json
{
  "description": "Harvest F1 on 2026-09-25",
  "changes": [
    {
      "target": "action",
      "where": {
        "field_id": {
          "op": "eq",
          "value": "F1"
        },
        "operation": {
          "op": "eq",
          "value": "harvest"
        }
      },
      "constraints": {
        "date": {
          "op": "eq",
          "value": "2026-09-25"
        }
      }
    }
  ]
}
```

The LLM is not allowed to modify Python code or optimisation equations.

It only converts natural language into the scenario structure expected by FarmOpti.

---

# 20. Scenario Schema

The scenario parser is given two forms of machine-readable information.

## 20.1 Response Schema

The response schema specifies **how the LLM must structure the answer**.

It defines fields such as:

```text
description
changes
target
where
update
constraints
operator
value
```

Structured-output support is used so the model is not merely told:

```text
"please return JSON"
```

The output is programmatically constrained.

---

## 20.2 FarmOpti Context

The parser also receives the current FarmOpti entities and identifiers.

This can include:

```text
available targets
table columns
field IDs
plan IDs
machine IDs
operation names
supported operators
```

This tells the LLM **what it is allowed to reference**.

Therefore:

```text
response schema
→ controls HOW the model responds

FarmOpti context
→ controls WHAT the model can refer to
```

---

# 21. Deterministic Scenario Validation

Implemented in:

```text
lib/optimizer/chatbot/scenario/validator.ts
```

The LLM output is never passed directly to the optimiser.

The validator checks:

```text
target exists
field exists
operation exists
selectors match real data
requested column exists
operator is allowed
value type is valid
action selector resolves correctly
```

Example:

```text
field_id = F99
```

is rejected if F99 does not exist.

Likewise:

```text
available_water_ml = "banana"
```

is rejected because the value type is invalid.

The LLM therefore interprets language, but deterministic Python controls whether the requested modification is valid.

---

# 22. Scenario Execution

Implemented in:

```text
lib/optimizer/chatbot/scenario/runner.ts
```

The scenario runner applies the validated change to temporary optimisation inputs.

The original external-variable CSVs are not modified.

Conceptually:

```text
original inputs
      +
validated scenario changes
      ↓
temporary scenario state
      ↓
FarmOpti optimisation
```

Depending on the modification, FarmOpti may:

```text
reuse existing field options
```

or rerun:

```text
candidate generation
        ↓
field simulation
        ↓
beam search
        ↓
CP-SAT optimisation
```

The mathematical optimiser still makes the new scheduling decision.

---

# 23. Scenario Comparison

Implemented in:

```text
lib/optimizer/chatbot/scenario/comparator.ts
```

The scenario solution is compared with the original baseline.

Main financial comparison:

\[
\Delta V = V_{scenario} - V_{baseline}
\]

The comparator also records changes such as:

```text
actions added
actions removed
actions rescheduled
objective change
```

Example:

```json
{
  "baseline_objective_aud": 100000,
  "scenario_objective_aud": 101460,
  "objective_change_aud": 1460,

  "actions_added": ["P12"],
  "actions_removed": [],

  "actions_rescheduled": [
    {
      "plan_id": "P04",
      "old_time": "2026-09-21T07:00:00",
      "new_time": "2026-09-20T07:00:00"
    }
  ]
}
```

---

# 24. Scenario LLM Explanation

The final LLM receives:

```text
original user request
applied scenario
baseline objective
scenario objective
schedule differences
new optimisation summary
```

It then explains the computed result.

Example:

```text
Adding 3 ML of water increased the optimal whole-farm objective by approximately $1,460. The additional capacity caused P12 to be selected and allowed P04 to move to an earlier time.
```

The LLM does not calculate this result.

It only communicates the output of the re-optimisation.

---

# 25. Component Responsibilities

```text
decisionAnalysis/extractDecisions.ts
    Extract selected/skipped decisions, financial evidence, timing and state changes.

decisionAnalysis/analyseCounterfactuals.ts
    Re-run optimisation under controlled decision changes.

decisionAnalysis/buildDecisionIndex.ts
    Convert the canonical decision trace into retrieval-friendly records.

chatbot/retrieveDecisions.ts
    Resolve the user's target decision and retrieve relevant evidence.

chatbot/explanationService.ts
    Classify EXPLAIN vs SCENARIO, consolidate evidence and call the LLM.

chatbot/chatbot.ts
    Interactive terminal interface.

chatbot/scenario/parser.ts
    Convert an already-classified scenario request into structured modifications.

chatbot/scenario/validator.ts
    Check scenario modifications against real FarmOpti data.

chatbot/scenario/runner.ts
    Apply temporary modifications and rerun the optimiser.

chatbot/scenario/comparator.ts
    Compare the scenario solution with the baseline.

LLM
    Interpret natural language and translate structured evidence into natural language.
```

---

# 26. End-to-End Design Principle

FarmOpti follows:

\[
\boxed{
\text{Optimisation}
\rightarrow
\text{Decision Evidence}
\rightarrow
\text{Retrieval or Re-optimisation}
\rightarrow
\text{LLM Explanation}
}
\]

The system deliberately avoids:

\[
\text{Final schedule}
\rightarrow
\text{LLM guesses the reason}
\]

This separation provides:

```text
traceability
auditability
lower hallucination risk
clear financial reasoning
reproducible scenario analysis
```

The optimiser remains the source of truth for decisions and financial outcomes.

The LLM is the natural-language interface to that optimisation system.

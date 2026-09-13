# FarmOpti — Harvest Operations Optimiser

> **Hackathon prototype · Track 3: Solve a Business Problem**
>
> When conditions change during harvest, the system recalculates the economically optimal
> whole-operation plan rather than merely alerting the farm manager.

---

## What it demonstrates

Large Australian broadacre farms already collect machinery telemetry, weather forecasts and
crop data. But when rain moves forward, a combine develops a fault and resources become
constrained, the farm manager still has to mentally determine the best overall response.

FarmOpti models the farm as an operating system. When a disruption occurs it evaluates every
permitted strategy — field orderings, machine states, truck routes, contractor on/off — and
selects the lowest-cost plan. It then explains the decision in plain English.

**The 90-second demo flow:**

| Step | What happens |
|------|--------------|
| 1 — Normal | Dashboard shows the current optimal plan. Rain expected in 31 hours. H2 healthy. |
| 2 — Disruption | Click **Simulate Disruption**. Rain moves to 17 hours. H2 restricted to 70% by OEM. The old plan is replayed under the new conditions and flagged suboptimal. |
| 3 — Reoptimise | Click **Reoptimise Operation**. The engine evaluates 5,000+ candidate schedules and recommends hiring the contractor. Improvement ≈ **A$15,208**. |
| 4 — Knowledge | Type a rule in plain English. The interpreter proposes a structured constraint. Confirm it; the optimiser re-runs and the plan changes. |

---

## Architecture

```
system/app/            Next.js app router (layout + page)
system/components/
  FarmControl.tsx     Top-level UI component — all demo state and layout
   ui/                 shadcn component library (table, badge, etc.)
system/lib/farm/
  types.ts            Shared TypeScript types
  data.ts             Farm scenario: fields, machines, trucks, contractor, weather
  optimizer.ts        Exhaustive search over (strategy × route × field order)
  economics.ts        Objective function: weather loss + delay + penalties + costs
  parser.ts           Deterministic natural-language → constraint interpreter
  explanation.ts      Plain-English decision rationale generator
```

### How the optimiser works

The farm has 6 fields with known yield, price, moisture and rainfall-loss rates. Each hour of
the 48-hour planning horizon is simulated for each resource (H1, H2, optionally C1). The
optimiser enumerates:

- **4 strategies** — stop H2 / restricted H2 / restricted H2 + contractor / stop H2 + contractor
- **2 truck routes** — all trucks to regional receival vs. split receival + on-farm storage
- **720 field orderings** (6! permutations)

For each combination it runs a full hourly simulation — assigning resources to fields,
accumulating tonnes, tracking storage and delivery targets — then scores the result with the
economic objective function.

The **objective function** is:

```
min  weather loss
   + residual-work delay cost
   + delivery shortfall penalty
   + contractor hire cost
   + owned-machine operating cost
   + transport cost
```

All values use the scenario's rain probability as a multiplier on expected weather loss.

### Why the optimiser beats "do nothing"

Normal plan replayed under disruption: **A$95,720** total modelled cost  
Optimised disrupted plan: **A$80,512** total modelled cost  
Expected improvement: **A$15,208**

The improvement comes from hiring the contractor 9 hours, which harvests an extra ~30 ha of
high-value canola and wheat before the rain arrives, reducing expected crop and quality losses
by more than the A$4,950 contractor booking cost.

### Natural-language rule capture

The interpreter uses pattern matching to parse constraints of the form:

> "Never send H2 to North 4 within 24 hours of more than 15 mm rainfall."

It extracts field name, machine ID, rainfall threshold and window length, presents the
structured constraint for manager confirmation, then passes it to the next optimiser run as a
hard constraint. No LLM or API key is required — the fallback works offline.

---

## Synthetic data assumptions

| Parameter | Value | Reason |
|-----------|-------|--------|
| Farm | Glenara Farm, Riverina NSW | Fictional |
| Fields | 6 × 100–170 ha | Tractable demo size |
| H1 throughput | 12 ha/h | Typical 450 HP combine |
| H2 throughput (normal) | 10 ha/h | Slightly smaller unit |
| H2 throughput (restricted) | 7 ha/h (70%) | OEM-supplied state |
| Contractor | 14 ha/h, A$550/h, 9-hour window | Plausible external rate |
| Wheat price | A$300–310/t | Mid-2025 Australian average |
| Canola price | A$650/t | Mid-2025 premium |
| Rainfall-loss rate | A$60–250/ha | Varies by crop and moisture |
| Planning horizon | 48 hours | Covers pre-rain and post-rain work |
| Rain probability | 72% | Set in disruption scenario |

All financial outputs are computed from these inputs — they are not hardcoded.

---

## How to run

**Prerequisites:** Node.js 22+, npm.

```bash
cd system
npm install
npm run dev
```

Open `http://localhost:3000`.

**Run the optimiser tests:**

```bash
npm test
```

**Production build:**

```bash
npm run build
```

---

## What is simulated vs. what is real

| Component | Status |
|-----------|--------|
| Optimisation engine | Real — exhaustive search over permutations |
| Economic objective function | Real — computed from synthetic inputs |
| Natural-language interpreter | Real — deterministic regex/pattern parser |
| Farm data | Synthetic — realistic parameters, fictional farm |
| Weather | Synthetic — fixed scenarios, no live API |
| Machine telemetry | Synthetic — OEM state supplied as external input |
| Delivery commitments | Synthetic — real enforcement in objective |

---

## What a production version would require

1. **Data connectors** — Deere Operations Center, CNH FieldOps, Agworld/FMS, weather APIs,
   storage management systems.
2. **Predictive models** — ML estimates for actual ha/h by machine/field/operator, moisture
   trajectories, queue delays.
3. **Formal solver** — OR-Tools CP-SAT or MILP for larger operations (this prototype uses
   exhaustive search over a small field set).
4. **LLM constraint interpreter** — Replace the pattern matcher with a Claude API call for
   richer, more ambiguous manager language, with the deterministic fallback retained.
5. **Execution integration** — Push confirmed plans back into Agworld or OEM work-order systems.
6. **Farm-specific calibration** — Two seasons of historical data to learn real throughput rates
   and paddock-specific constraints.
7. **Shadow-trial validation** — Replay 20–30 real historical disruptions against actual
   decisions to measure incremental value before commercial deployment.

---

## Repository

`https://github.com/Vish01234/FarmOpti`

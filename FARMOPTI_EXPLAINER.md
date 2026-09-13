# FarmOpti — How it works

**For the team. Written to be read before the demo.**

---

## The one-sentence pitch

When harvest conditions change — rain moves forward, a machine develops a fault, a manager
adds a field rule — FarmOpti recalculates the economically best plan for the entire operation
and tells the farm manager exactly why the new decision is better.

Not a dashboard. Not an alert. A different answer.

---

## The problem it's solving

A large Australian broadacre farm might be running two combines, three trucks, six fields,
an optional contractor, two grain destinations, and a wheat delivery commitment — all at the
same time, all weather-dependent, all interdependent.

When something changes during harvest, the farm manager has to:

- Hold the current plan in their head
- Mentally adjust every resource that's affected
- Work out whether the change makes a contractor call worthwhile
- Sequence fields so the highest-risk crop gets off first
- Still hit the delivery commitment
- Do this under time pressure, often in a noisy vehicle

Today that calculation lives entirely in the manager's head. Existing software (John Deere
Operations Center, Case IH FieldOps, Agworld) shows them the data — telemetry, weather, job
lists — but doesn't compute the response. A farm manager using those tools is like a pilot
with instruments but no autopilot, and no co-pilot either.

FarmOpti is the co-pilot that does the maths and shows its working.

---

## What the demo shows

The app opens with a fictional Australian farm — **Glenara Farm, Riverina NSW** — already
halfway through harvest. There are six fields, two combine harvesters (H1 and H2), three
trucks, two grain destinations, six workers, an optional contractor, and a wheat delivery
due at the regional receival site.

The system has already computed the best plan for current conditions. Rain is 31 hours away.
Both combines are healthy.

**Step 1 — Normal plan (starting state)**

The operations dashboard shows:
- 800 ha remaining across six fields
- Current weather: 72% probability of 22 mm rain in 31 hours
- H1: 12 ha/hour, healthy
- H2: 10 ha/hour, healthy
- A Gantt-style 48-hour timeline showing which combine goes to which field and when
- Key stats: 510 ha harvested before rain, 290 ha exposed, expected contribution

The plan has been calculated — it uses only the owned fleet, no contractor.

---

**Step 2 — Simulate Disruption**

Click the button. Two things happen simultaneously:

1. **Rain moves from hour 31 to hour 17** — 14 hours earlier than forecast
2. **H2 develops elevated vibration** — its manufacturer-approved temporary state
   allows it to continue at **70% capacity (7 ha/hour)** pending inspection

The UI immediately flags: **"Current plan no longer optimal."**

The old plan is shown *replayed under the new conditions* — this is important. It's not
discarded; it's re-evaluated under the new facts so the comparison is fair. Under disruption
that plan costs **A$95,720** in total modelled loss and cost.

---

**Step 3 — Reoptimise Operation**

The engine evaluates every permitted combination of strategies:

- Should H2 keep running at 70%, or stop completely?
- Should the contractor be called?
- Which field should each combine go to first?
- Should trucks split between receival and on-farm storage?

It comes back with the best plan: **hire the contractor, run H2 at its approved 70%, prioritise
West 2 canola and River 8 wheat first, split the trucks.**

Total modelled cost of that plan: **A$80,512** — an improvement of **A$15,208** over the
replayed old plan, after paying the contractor's A$4,950 booking cost.

The comparison table shows all four strategies side by side with their costs, so the farm
manager can see exactly why the recommended plan wins and what the alternatives would cost.

---

**Step 4 — Manager Knowledge**

The knowledge panel unlocks. A farm manager types:

> "North 4 gets boggy after heavy rain. Never send H2 there within 24 hours of more than
> 15 mm rainfall."

The interpreter reads this and proposes a structured rule:

| Resource | Field | Trigger | Window | Constraint |
|----------|-------|---------|--------|------------|
| H2 | North 4 | Rainfall > 15 mm | 24 hours | Assignment prohibited |

The manager reviews it and clicks **Confirm & reoptimise**. The engine re-runs with H2
excluded from North 4 during the post-rain window. The plan updates. H2's North 4 work
shifts elsewhere.

This is the AI doing what AI is actually good at: translating something a human said in
natural language into a machine-readable constraint that a deterministic optimiser can enforce.
The AI does not decide the plan. It structures the manager's knowledge so the optimiser can
use it.

---

## How the optimiser actually works

This is not a language model guessing what sounds like a good harvest plan. It's a search.

**The search space**

The farm has 6 fields. There are 6! = **720 possible orderings** of those fields. For each
ordering, the system tries:

- 4 fleet strategies (stop H2 / restricted H2 / restricted H2 + contractor / stop H2 + contractor)
- 2 truck routing options (all trucks to regional receival / split receival + on-farm storage)

That's 720 × 4 × 2 = **5,760 candidate plans** per disruption event. Every single one is
evaluated.

**The simulation**

For each candidate plan, the system runs a full hour-by-hour simulation of the 48-hour
planning window:

```
For each hour from 0 to 47:
  Skip hours blocked by rain or labour changeovers
  For each active resource (H1, H2, optionally C1):
    Find the next eligible field in the candidate ordering
    Check: Is the field ready? Is it prohibited by a confirmed rule?
    Check: Is there destination capacity (storage or receival)?
    Calculate hectares worked (accounting for 15-min field-change penalty)
    Accumulate tonnes, costs, delivery progress
```

Labour changeovers are enforced — two 2-hour breaks are built into the schedule at hours
12–14 and 26–28. Rain stops work for 6 hours from the rain event. Fields aren't ready until
their moisture drops enough (North 4 is only ready from hour 24, Hill 5 from hour 30).

Only wheat can go to the regional receival. Canola and barley go to on-farm storage. The
"split" truck route assigns T1 and T2 to receival, T3 to storage; "all receival" sends all
three trucks to the regional site and loses the canola/barley destination.

**The economic score**

Every completed simulation produces a total modelled cost:

```
Total cost = weather loss
           + residual-work delay cost
           + delivery shortfall penalty
           + contractor hire cost
           + owned-machine operating cost
           + transport cost
```

**Weather loss** is the big one. For each hectare still standing when the rain arrives,
the system multiplies:

```
rain loss = hectares exposed × per-hectare loss rate × rain probability
```

Each field has a different per-hectare loss rate reflecting its crop, moisture and quality
sensitivity. West 2 canola has a loss rate of A$190/ha. River 8 wheat is A$250/ha.
East 3 barley is A$80/ha. This means the optimiser naturally prioritises high-exposure,
high-value crops before rain.

**Delivery shortfall penalty**: If the plan delivers fewer than 480 tonnes of wheat to
the regional receival by hour 30, the shortfall costs A$65/tonne.

**Residual-work delay cost**: Hectares not harvested by hour 48 cost A$85/ha as a proxy
for the delay value of getting to them later in poorer conditions.

The plan with the lowest total cost is labelled **best evaluated**.

---

## How the improvement number is calculated

The **A$15,208 improvement** is not hardcoded. It is:

```
improvement = cost_of_old_plan_replayed_under_disruption
            - cost_of_recommended_plan
            = A$95,720 - A$80,512
            = A$15,208
```

Both numbers use the same simulation, the same economic function, and the same disrupted
conditions. The comparison is honest.

The contractor costs A$4,950 for 9 hours. The plan still recommends hiring because the
extra throughput before the rain moves enough high-value canola and wheat off the paddock
to reduce expected weather loss by more than the booking cost.

---

## How the natural-language rule interpreter works

There is no API call here. The interpreter is a deterministic parser — it runs entirely
offline with no external dependency.

It checks for:

1. **One field name** from the known field list (River 8, North 4, West 2, South 6, East 3, Hill 5)
2. **One machine ID** (`H1`, `H2`, or `C1`)
3. **A prohibition word** (`never`, `do not`, `prohibit`, etc.)
4. **A rainfall quantity** — the pattern `more than X mm`
5. **A time window** — the pattern `within X hours`
6. **No exception clauses** (`unless`, `except`, `allow`) — these are rejected because they
   can't be safely parsed into a hard constraint

If all five are present and no exceptions appear, a rule is created. If anything is missing
or ambiguous, it rejects the input with an explanation of what's needed.

The resulting constraint is passed to the next optimiser run as a hard exclusion:

```python
def isProhibited(rule, resource, field, hour, scenario):
    rain_end = scenario.rainAt + scenario.rainDuration
    return (
        rule.resource == resource
        and rule.field == field
        and scenario.rainMm > rule.rainfallMm
        and rain_end <= hour < rain_end + rule.windowHours
    )
```

If the rule fires on any hour-resource-field combination during simulation, that assignment
is skipped. The optimiser finds the next best field instead.

The rule activates correctly because the rain in the disruption scenario is 22 mm, which
exceeds the 15 mm threshold, and the window covers the post-rain hours where North 4 would
otherwise be reachable.

---

## Why the LLM doesn't decide the plan

This is a deliberate design choice, and it's one of the things that makes this credible.

Language models are good at:
- Reading unstructured human language
- Structuring information into named fields
- Explaining why a mathematical result makes sense

Language models are unreliable at:
- Doing arithmetic consistently
- Respecting hard constraints without hallucinating exceptions
- Producing the same answer twice from the same inputs

The optimiser is deterministic. Run it twice with the same inputs, you get the same plan.
Run it with the same inputs but a confirmed rule added, the rule is always honoured.
Run it again tomorrow, you get the same economics.

That reproducibility is what makes the financial comparison trustworthy. If the recommendation
came from an LLM, you couldn't verify the A$15,208 figure independently. Because it comes
from arithmetic over a simulation, you can.

In the product architecture:

| Task | Who does it |
|------|-------------|
| Parse manager language into a constraint | LLM / deterministic parser |
| Explain the recommended plan in plain English | LLM |
| Schedule the farm | Deterministic simulator |
| Score each plan economically | Deterministic arithmetic |
| Select the best plan | Lowest cost wins |
| Authorise machine operation | External OEM system only |

---

## What's synthetic vs. what's real

| Component | Status |
|-----------|--------|
| Schedule simulation | Real code, runs on every click |
| Economic scoring | Real arithmetic, same function every time |
| Strategy comparison | Real — all 5,760 candidates are evaluated |
| Natural-language parser | Real — deterministic, no API needed |
| Farm, fields, machines, prices | Synthetic but realistic |
| Weather | Fixed scenarios, no live data |
| Machine telemetry | OEM state supplied as an external input |
| Contractor availability | Assumed available from hour 4 |

The financial outputs — A$95,720, A$80,512, A$15,208 — are calculated from the synthetic
inputs every time. They are not hardcoded.

---

## The 90-second demo script

| Time | Action | What to say |
|------|--------|-------------|
| 0:00 | Show normal plan | "Large farms have all the data — telemetry, weather, job lists. But when something changes, the manager still has to mentally recalculate the whole response." |
| 0:15 | Point at Gantt timeline | "Here's the current optimal plan: H1 to River 8, H2 to West 2, contractor not needed." |
| 0:25 | Click Simulate Disruption | "Rain moves forward 14 hours. H2 enters a manufacturer-approved restricted state. The existing plan is now outdated." |
| 0:40 | Click Reoptimise | "We evaluate over 5,000 candidate schedules — field orderings, machine states, truck routes, contractor on or off." |
| 0:55 | Point at improvement figure | "After paying the $4,950 contractor booking, expected loss is $15,208 lower. That's not an opinion — that's arithmetic over the same simulation." |
| 1:05 | Type the North 4 rule | "The manager knows North 4 gets boggy. They type it naturally." |
| 1:15 | Show structured constraint | "The system turns that into a machine-readable rule and asks for confirmation before using it." |
| 1:25 | Click Confirm | "The plan recalculates. H2 is excluded from North 4 in the post-rain window. The manager's knowledge is now in the system, not just in their head." |

---

## The file map

```
farmopti/
├── lib/farm/
│   ├── types.ts         All data types: Field, Scenario, Plan, Rule, Economics, etc.
│   ├── data.ts          The farm: 6 fields, machines, trucks, contractor, scenarios
│   ├── optimizer.ts     Exhaustive search + hourly simulation engine
│   ├── economics.ts     Objective function: 6 cost components summed to totalCost
│   ├── parser.ts        Natural-language → Rule (deterministic, offline)
│   └── explanation.ts   Plain-English rationale from a completed plan
├── components/
│   └── FarmControl.tsx  All UI: 4 demo phases, timeline, comparison, knowledge panel
└── app/
    ├── page.tsx         Entry point
    └── globals.css      All styling
```

---

## Run it

```bash
cd farmopti
npm install
npm run dev
# open http://localhost:3000
```

Reset button (top right) returns to the normal plan at any point.

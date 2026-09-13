# FarmOpti Optimisation Process

This README documents only the **optimisation pipeline** used by FarmOpti: how external farm variables and the farmer management plan are converted into a financially optimised schedule.

Run all stages (from `app/`):

```bash
npm install
npm run optimizer:pipeline
```

Ask the decision chatbot (requires a local Ollama server for natural-language explanations):

```bash
npm run optimizer:chatbot
```

---

## Todos

- Improve LLM answer
- Learn past to improve simulator
- LLM can change 

## 1. Overview

The optimisation process is:

```text
External variables + management plan
                ↓
      1. Candidate generation
                ↓
      candidate_actions.csv
                ↓
      2. Field-state simulation
                ↓
      3. Field-option search
           (beam search)
                ↓
       field_options.json
                ↓
      4. Global CP-SAT optimisation
                ↓
       optimal_schedule.csv
```

There are two search levels:

1. **Field-level search**
  Explore alternative action sequences for each field while accounting for interactions between actions.
2. **Whole-farm optimisation**
  Select the best field-level option for every field while satisfying shared machine, labour, water, and travel constraints.

---



# 2. External inputs

The optimiser reads the following external variables.

## `fields.csv`

Static field information:

- field ID
- area
- current crop
- planned crop
- irrigability
- field coordinates

Field coordinates are used for machine travel time.

---



## `field_state_daily.csv`

Daily **no-new-action baseline forecast** for each field.

Typical state variables are:

- growth stage
- crop readiness
- soil moisture
- soil temperature
- expected yield
- nitrogen index
- weed pressure
- pest pressure
- disease pressure
- seedbed readiness

This is the state trajectory expected if no new management action is applied.

---



## `weather_hourly.csv`

Hourly weather forecast used to determine whether an operation can be performed.

Examples:

- rainfall
- wind
- temperature

---



## `labour_availability_daily.csv`

Daily shared labour capacity:

L_t = \text{number of workers available at time }t

---



## `machines.csv` and `machine_availability_daily.csv`

Define:

- available machines
- machine type
- machine cost per hour
- machine working windows

---



## `water_availability_daily.csv`

Defines daily irrigation limits:

W_d^{\max}

\min
\left(
W_d^{available},
W_d^{delivery}
\right)

---



## `economics_daily.csv`

Contains date-specific prices and costs such as:

- crop price
- labour cost
- water cost
- seed cost
- fertiliser cost
- chemical cost

---



## `management_plan.csv`

Defines operations that the farmer wants or allows the optimiser to schedule.

Each plan contains information such as:

```text
plan_id
field_id
operation
target
amount
allowed_from
allowed_to
required
depends_on
min_gap_hours
```

`required = 1` means the operation must be scheduled.

`required = 0` means the optimiser may perform or skip the operation.

---



# 3. Step 1 — Candidate generation

Implemented in:

```text
app/lib/optimizer/candidateGeneration.ts
```

Candidate generation creates all individually feasible action timings.

For each management-plan operation, the system tests possible start times within the allowed window.

A timing is retained only if it satisfies conditions such as:

- allowed date range
- working hours
- weather limits
- machine availability
- minimum labour availability
- individual water requirement
- basic crop-state feasibility

The output is:

```text
candidate_actions.csv
```

---



## 3.1 Action duration

For field area A and operation work rate r:

D = \frac{A}{r}

where:

- D: operation duration in hours
- A: field area in hectares
- r: work rate in hectares/hour

---



## 3.2 Execution cost

For an action with duration D:

C_{exec}

D C_{machine}
+
D N_{workers} C_{labour}

where:

- C_{machine}: machine cost per hour
- N_{workers}: workers required
- C_{labour}: labour cost per worker-hour

---



# 4. Financial accounting principle

The optimiser separates:

\boxed{\text{direct financial effect}}

from:

\boxed{\text{future agronomic state effect}}

This prevents future yield benefits from being counted twice.

For action a:

CF_a = R_a - C_a

where:

- CF_a: direct cash effect
- R_a: immediate revenue
- C_a: immediate cost

For irrigation, spraying, fertilising, and planting:

R_a = 0

Their future benefit is represented through changes in field state.

Harvest creates actual crop revenue and therefore has:

R_{harvest} > 0

---



# 5. Direct financial effects by action



## Harvest

Revenue:

R_{harvest}

A Y P

where:

- A: field area
- Y: simulated expected yield in tonnes/ha
- P: crop price

Direct cash effect:

CF_{harvest}

## A Y P

C_{exec}

After harvest, the crop is removed from the simulated state.

---



## Irrigation

Water quantity:

Q_{water}

A q_{water}

where q_{water} is the configured ML/ha rate.

Direct irrigation cost:

C_{irrigation}

C_{exec}
+
Q_{water} P_{water}

Therefore:

CF_{irrigation}

-C_{irrigation}

No future yield benefit is added directly to the cash value.

---



## Spraying

Chemical cost:

C_{chemical}

A q_{chemical} P_{chemical}

Total cost:

C_{spray}

C_{exec}
+
C_{chemical}

Therefore:

CF_{spray}

-C_{spray}

---



## Fertilising

For fertiliser dose F:

C_{fertiliser}

A F P_{fertiliser}

Total cost:

C_{fertilise}

C_{exec}
+
C_{fertiliser}

Therefore:

CF_{fertilise}

-C_{fertilise}

---



## Planting

Seed cost:

C_{seed}

A q_{seed} P_{seed}

Total direct planting cost:

C_{plant}

C_{exec}
+
C_{seed}

Therefore:

CF_{plant}

-C_{plant}

Planting creates a crop state but does not immediately create revenue.

---



# 6. Step 2 — Field-state simulation

Implemented in:

```text
app/lib/optimizer/fieldSimulator.ts
```

The simulator evaluates a sequence of selected actions in chronological order.

This is necessary because actions interact.

For example:

```text
irrigation
    ↓
changes soil moisture
    ↓
later irrigation sees the updated moisture state
```

Similarly:

```text
spray       → changes pest/weed/disease pressure
fertilise   → changes nitrogen state
plant       → creates crop state
harvest     → removes crop state
```

---



# 7. State-transition equations

The current implementation uses lightweight configurable response equations.

---



## 7.1 Irrigation state effect

Moisture deficit:

d_M

\operatorname{clip}
\left(
\frac{M^*-M}{M^*},
0,
1
\right)

where:

- M: current simulated soil moisture
- M^*: target soil moisture

Estimated yield-state effect:

\Delta Y_{irr}

Y d_M \lambda_{irr}

where \lambda_{irr} is the configured maximum yield-loss fraction.

Updated state:

M'

\max(M,M^*)

Y'

\min
\left(
Y+\Delta Y_{irr},
Y_{potential}
\right)

---



## 7.2 Spray state effect

For pressure Q, spray efficacy e, and configured yield-loss fraction \lambda_s:

\Delta Y_{spray}

Y Q \lambda_s e

Pressure after treatment:

Q'

Q(1-e)

Expected yield state becomes:

Y'

\min
\left(
Y+\Delta Y_{spray},
Y_{potential}
\right)

---



## 7.3 Fertiliser state effect

Nitrogen deficit:

d_N

\operatorname{clip}
\left(
\frac{N^*-N}{N^*},
0,
1
\right)

Dose response:

\rho

1-
\exp
\left(
-\frac{F}{s}
\right)

where:

- F: fertiliser dose
- s: response-scale parameter

Yield-state effect:

\Delta Y_{fert}

Y d_N \lambda_f \rho

Nitrogen state update:

N'

N+(N^*-N)\rho

Yield state update:

Y'

\min
\left(
Y+\Delta Y_{fert},
Y_{potential}
\right)

---



## 7.4 Planting state effect

Moisture suitability:

S_M

\operatorname{clip}
\left(
1-
\frac{|M-M^*|}{\tau_M},
0,
1
\right)

Temperature suitability:

S_T

\min
\left(
1,
\frac{T}{T^*}
\right)

Overall suitability:

S

\operatorname{clip}
\left(
S_{seedbed} S_M S_T,
0,
1
\right)

Initial expected yield:

Y_{plant}

Y_{potential} S

The simulator then changes the field from an unplanted state to the selected crop.

---



# 8. Baseline forecast and action residuals

The daily field-state file is a no-action baseline:

B_{k,t}

for state variable k at time t.

When an action changes a variable, the simulator stores the difference between the simulated state and baseline:

R_{k,t}

## S_{k,t}

B_{k,t}

where:

- S_{k,t}: simulated state
- B_{k,t}: baseline state

When the simulator advances d days:

R_{k,t+d}

R_{k,t}\alpha_k^d

where \alpha_k is a configurable persistence/decay coefficient.

The future state is then:

S_{k,t+d}

B_{k,t+d}
+
R_{k,t+d}

This allows the system to use the external baseline forecast while still carrying action effects forward.

---



# 9. Step 3 — Field-option generation

Implemented in:

```text
app/lib/optimizer/fieldOptions.ts
```

A **field option** is one complete valid schedule for one field.

Example:

```text
F2 option A
- skip first irrigation
- perform pest spray on Sep 21
- perform irrigation on Sep 25
```

Another option may be:

```text
F2 option B
- perform first irrigation
- skip pest spray
- perform second irrigation
```

Each option is simulated from start to finish.

Therefore later actions are evaluated using the state created by earlier actions.

---



# 10. Optional and required actions

For a required management-plan operation:

required = 1

every valid field option must contain exactly one timing for that operation.

For an optional operation:

required = 0

the field search considers both:

```text
perform
```

and:

```text
skip
```

The action is selected only if it improves the final financial objective enough to justify its cost.

---



# 11. Dependencies and spacing

If action j depends on action i:

start_j
\ge
end_i
+
g_{ij}

where g_{ij} is the required minimum gap.

Repeated optional operations can also require spacing without one being a strict prerequisite of the other.

If both repeated actions are selected:

gap(i,j)
\ge
g_{min}

---



# 12. Same-field overlap

Two actions on the same field cannot overlap:

[start_i,end_i)
\cap
[start_j,end_j)

\varnothing

This is enforced even if they use different machines.

---



# 13. Beam search

Enumerating all action combinations is computationally expensive.

The optimiser therefore uses **beam search**.

For each field:

1. start with an empty schedule;
2. process each management-plan operation;
3. expand each retained partial schedule with possible candidate timings;
4. include a `skip` branch for optional actions;
5. simulate the resulting sequence;
6. remove infeasible sequences;
7. score valid sequences;
8. retain only the best K partial schedules.

Beam width:

K = \texttt{beamwidth}

The implementation also preserves diversity between different optional-action combinations so that globally useful but slightly lower-value field options are not removed too early.

The result is a bounded set of interaction-aware field schedules:

```text
field_options.json
```

---



# 14. Terminal crop value

An unharvested crop still has economic value at the end of the optimisation horizon.

For an existing crop:

V_{terminal}

A Y_H P_H

where:

- A: field area
- Y_H: simulated expected yield at the horizon end
- P_H: crop price

For a newly planted crop, remaining future production costs are deducted:

V_{terminal}

## A Y_H P_H

A C_{remaining}

If the crop has already been harvested:

V_{terminal}=0

because the crop value has already been realised through harvest revenue.

---



# 15. Financial value of a field option

For field option o, let A_o be its selected actions.

Total direct cash effect:

CF_o

\sum_{a\in A_o} CF_a

Field-option objective:

\boxed{
V_o

CF_o
+
V_{terminal,o}
}

or:

\boxed{
V_o

\sum_{a\in A_o}
(R_a-C_a)
+
V_{terminal,o}
}

This is the value passed to the global optimiser.

A treatment can therefore have:

CF_a < 0

but still be selected if the state improvement increases harvest or terminal crop value by more than the treatment cost.

---



# 16. Step 4 — Global whole-farm optimisation

Implemented in:

```text
app/lib/optimizer/scheduleOptimizer.ts
```

The global optimiser uses **Google OR-Tools CP-SAT**.

Suppose field f has possible options O_f.

Define:

x_{f,o}
\in
0,1

where:

x_{f,o}=1

means option o is selected for field f.

Exactly one option is selected for each field:

\sum_{o\in O_f}
x_{f,o}

1

---



# 17. Global financial objective

The whole-farm objective is:

\boxed{
\max
\sum_f
\sum_{o\in O_f}
V_{f,o}x_{f,o}
}

where:

V_{f,o}

CF_{f,o}
+
V_{terminal,f,o}

The solver therefore chooses the combination of field schedules with the highest total expected financial value.

---



# 18. Machine constraints

Each selected action must use one eligible machine.

For action a and machine m:

y_{a,m}
\in
0,1

with:

\sum_{m\in M_a}
y_{a,m}

x_{o(a)}

where o(a) is the field option containing action a.

If two actions overlap and need the same machine:

y_{i,m}
+
y_{j,m}
\le
1

---



# 19. Machine travel constraints

Distance between fields i and j:

d_{ij}

\sqrt{
(x_i-x_j)^2
+
(y_i-y_j)^2
}

Machine travel time:

T_{ij}

\frac{d_{ij}}{v}

where v is configured machine speed.

If the same machine performs action i followed by action j:

start_j

end_i
\ge
T_{ij}

Otherwise the pair of assignments is infeasible.

---



# 20. Labour constraint

At each time t:

\sum_{a:t\in a}
N_{workers,a}
x_{o(a)}
\le
L_t

where L_t is the labour capacity available at that time.

---



# 21. Water constraint

For each day d:

\sum_{a\in irrigation(d)}
Q_{water,a}
x_{o(a)}
\le
W_d^{max}

where:

W_d^{max}

\min
\left(
W_d^{available},
W_d^{delivery}
\right)

---



# 22. Final schedule

The CP-SAT solution determines:

- which field option is selected for every field;
- which optional actions are performed;
- exact action timing;
- assigned machine;
- labour usage;
- irrigation usage.

The selected actions are written to:

```text
optimal_schedule.csv
```

The optimisation summary is written to:

```text
optimization_summary.json
```

The key financial outputs are:

```text
total_direct_cash_effect_aud
total_terminal_value_aud
total_objective_value_aud
```

with:

\boxed{
TotalObjective

TotalDirectCashEffect
+
TotalTerminalValue
}

---



# 23. Complete optimisation logic

In compact form:

\boxed{
\text{External variables}
\rightarrow
\text{feasible candidate timings}
\rightarrow
\text{state-transition simulation}
\rightarrow
\text{interaction-aware field options}
\rightarrow
\text{whole-farm CP-SAT}
\rightarrow
\text{optimal schedule}
}

The important distinction is:

- **candidate generation** decides what timings are individually possible;
- **field simulation** determines how actions affect later field state;
- **beam search** explores combinations of required and optional actions within each field;
- **CP-SAT** selects the globally compatible combination with the highest total financial value.


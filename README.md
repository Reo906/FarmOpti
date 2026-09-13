# FarmOpti

FarmOpti is a working hackathon prototype for **Track 3: Solve a Business Problem**. It demonstrates how a large broadacre farm could recalculate its whole harvest plan when weather, machinery capacity, logistics, or manager knowledge changes.

The predefined demo follows four steps:

1. Review a calculated 48-hour harvest plan for six fields, two combines, three trucks, two destinations, labour, a contractor, and a wheat delivery commitment.
2. Simulate rain moving from hour 31 to hour 17 while combine H2 enters an externally approved 70% operating state.
3. Evaluate alternative field sequences, truck routes, machine choices, and contractor decisions, then compare their expected economics.
4. Interpret and confirm a manager's natural-language field rule before recalculating the plan.

## Architecture

The app is a React/TypeScript site at the repo root. Its main layers are:

- **lib/farm/data.ts** — synthetic farm state and operating assumptions
- **lib/farm/optimizer.ts** — deterministic schedule simulation and exhaustive candidate search
- **lib/farm/economics.ts** — consistent economic scoring
- **lib/farm/parser.ts** — validated, offline natural-language constraint fallback
- **lib/farm/explanation.ts** — explanations derived from the selected plan
- **components/FarmControl.tsx** — interactive control-centre experience

The search enumerates all 720 field orders for four permitted fleet strategies and two truck-routing modes. Each candidate runs through the same 48-hour simulation, applying crop readiness, forecast downtime, labour changeovers, machine throughput, destination eligibility and capacity, delivery timing, field-change overhead, and confirmed manager constraints. The lowest modelled total cost is labelled **best evaluated**.

## Synthetic assumptions

All farm names, field data, yields, prices, throughput, losses, costs, weather, machine state, and financial results are synthetic and illustrative. The prototype assumes one-hour planning buckets, continuous average truck flow, six hours of rain downtime, and fixed weather-loss rates per exposed hectare. H2's restricted state is supplied externally; FarmOpti neither diagnoses machinery nor authorises its operation.

## Run locally

Requires Node.js 22.13 or later.

~~~bash
npm install
npm run dev
~~~

Open the local URL printed in the terminal. Run verification with:

~~~bash
npm test
npm run build
~~~

## Simulated versus real

The schedule generation, constraint enforcement, strategy comparison, and economic calculations run in the application. Farm telemetry, weather, machine health, contractor availability, prices, and delivery data are simulated. The rule interpreter uses a strict deterministic parser so the demo needs no API key.

A production version would require farm-management and OEM integrations, live weather and receival data, calibrated field-level productivity and loss models, a more complete optimisation formulation, uncertainty testing, permissions and audit trails, safety and legal review, offline resilience, and shadow evaluation against real manager decisions.

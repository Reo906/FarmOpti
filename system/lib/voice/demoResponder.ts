// Demo mode: returns canned FarmOpti-style answers without any LLM or optimizer.
// Activate with FARMOPTI_DEMO_MODE=true in .env.

export interface DemoResponse {
  answer: string;
  mode: "explain" | "scenario";
  requestedScenario?: {
    mode: string;
    description: string;
    changes: unknown[];
  };
  comparison?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  schedule?: Record<string, unknown>[];
}

const RULES: Array<{ keywords: string[]; response: DemoResponse }> = [
  {
    keywords: ["today", "plan", "schedule", "what is", "what's", "overview", "summary"],
    response: {
      answer:
        "Today's plan has two headers running across five paddocks. H1 starts on Yallambee North at 06:30, moving to Rupanyup East after lunch. H2 covers Woomelang South and Douglas Park in parallel. Both trucks are on the Murtoa haul. You have 286 harvestable hectares before the front arrives tomorrow afternoon. The plan keeps APW1 deliveries on track for contract C-3391.",
      mode: "explain",
    },
  },
  {
    keywords: ["why", "spray", "spraying", "f2", "field 2", "chemical", "herbicide", "weed"],
    response: {
      answer:
        "F2 was selected for spraying because weed pressure reached 0.74, above the 0.65 threshold at which yield loss exceeds the cost of intervention. The optimiser ran a counterfactual where spraying was forbidden: that scenario reduced the whole-farm objective by A$4,820 due to a 0.31 tonne per hectare yield penalty at harvest. Day 3 was chosen because wind drops below 18 km/h and there is no rain forecast for a 6-hour window.",
      mode: "explain",
    },
  },
  {
    keywords: ["harvest", "f1", "field 1", "when", "timing"],
    response: {
      answer:
        "F1 harvest is scheduled for day 2 at 07:00. The optimiser evaluated 12 candidate windows. The selected window maximises the objective by balancing moisture readiness at 91%, avoiding the rain front, and keeping H1 utilisation above 80%. Delaying by one day reduces the objective by A$2,100 because H2 becomes the binding constraint and the Murtoa haul cannot be rerouted in time.",
      mode: "explain",
    },
  },
  {
    keywords: ["water", "irrigat", "ml", "megalitre", "moisture"],
    response: {
      answer:
        "Current water allocation is 3.2 megalitres per day across the irrigation blocks. Increasing to 4.5 megalitres on September 20 would allow the Woomelang South drip run to be brought forward by two days, improving the whole-farm objective by A$1,340 through a 0.09 tonne per hectare yield gain.",
      mode: "explain",
    },
  },
  {
    keywords: ["no spray", "not spray", "do not spray", "don't spray", "skip spray", "forbid spray", "stop spray", "remove spray"],
    response: {
      answer:
        "If F2 is not sprayed, weed pressure stays at 0.74 through harvest. The re-optimised schedule reduces the whole-farm objective by A$4,820 — a 0.31 tonne per hectare yield penalty on F2. No other operations are rescheduled. Say \"confirm change\" to activate this rule, or \"cancel change\" to discard it.",
      mode: "scenario",
      requestedScenario: {
        mode: "scenario",
        description: "Do not spray F2",
        changes: [
          {
            target: "action",
            where: { field_id: { op: "eq", value: "F2" }, operation: { op: "eq", value: "spray" } },
            constraints: { selected: { op: "eq", value: false } },
          },
        ],
      },
      comparison: {
        objective_change_aud: -4820,
        baseline_objective_aud: 182400,
        scenario_objective_aud: 177580,
        actions_added: [],
        actions_removed: [{ plan_id: "F2-spray-d3", operation: "spray", field_id: "F2" }],
        actions_rescheduled: [],
      },
      summary: { total_revenue_aud: 177580 },
      schedule: [],
    },
  },
  {
    keywords: ["delay", "push", "later", "september", "move harvest"],
    response: {
      answer:
        "Delaying F1 harvest to September 25 reduces the whole-farm objective by A$8,420. H1 sits idle for two days, H2 picks up Woomelang South early but hits the labour cap, and the Murtoa haul falls short of the APW1 contract volume by 42 tonnes. September 23 remains the financially optimal date. Say \"confirm change\" to apply the delay, or \"cancel change\" to keep the current plan.",
      mode: "scenario",
      requestedScenario: {
        mode: "scenario",
        description: "Delay F1 harvest to September 25",
        changes: [
          {
            target: "action",
            where: { field_id: { op: "eq", value: "F1" }, operation: { op: "eq", value: "harvest" } },
            constraints: { date: { op: "gte", value: "2024-09-25" } },
          },
        ],
      },
      comparison: {
        objective_change_aud: -8420,
        baseline_objective_aud: 182400,
        scenario_objective_aud: 173980,
        actions_added: [],
        actions_removed: [],
        actions_rescheduled: [{ plan_id: "F1-harvest", field_id: "F1", operation: "harvest" }],
      },
      summary: { total_revenue_aud: 173980 },
      schedule: [],
    },
  },
];

const FALLBACK: DemoResponse = {
  answer:
    "The Yallambee optimisation covers 18,430 ha across four properties. Today's schedule runs two headers, three trucks, and a contractor on standby. The front arrives tomorrow afternoon — 286 harvestable hectares are accessible before then. Ask me about a specific field, operation, timing, or try stating a rule like \"do not spray F2\".",
  mode: "explain",
};

export function demoRespond(text: string): DemoResponse {
  const lower = text.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.response;
    }
  }
  return FALLBACK;
}

export function isDemoMode(): boolean {
  return process.env.FARMOPTI_DEMO_MODE === "true";
}

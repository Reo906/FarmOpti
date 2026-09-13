'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CloudRain,
  Gauge,
  MapPin,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Tractor,
  Truck,
  Warehouse,
  Zap,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  delivery,
  disruption,
  exampleRule,
  fields,
  farmArea,
  HORIZON,
  normal,
  workers,
} from '@/lib/farm/data.ts';
import { explain, money, number } from '@/lib/farm/explanation.ts';
import { optimise, replay } from '@/lib/farm/optimizer.ts';
import { parseRule } from '@/lib/farm/parser.ts';
import type { Plan, Resource, Rule } from '@/lib/farm/types.ts';

// --- Pre-computed plans (run once at module load, not per render) ---
const initialSearch = optimise(normal);
const incumbentDisrupted = replay(initialSearch.best, disruption);
const disruptedSearch = optimise(disruption, [], initialSearch.best);
const fieldMap = Object.fromEntries(fields.map((f) => [f.id, f]));

type Phase = 'normal' | 'disrupted' | 'optimised' | 'rule';

// WebMCP type for optional AI tool registration
type WebMCPDocument = Document & {
  modelContext?: {
    registerTool: (
      tool: {
        name: string;
        title: string;
        description: string;
        inputSchema: object;
        annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
        execute: (input: Record<string, unknown>) => unknown;
      },
      options?: { signal: AbortSignal }
    ) => void | Promise<void>;
  };
};

// --- Helpers ---
const pct = (value: number) => `${Math.max(0, Math.min(100, value))}%`;

function groupAssignments(plan: Plan, resource: Resource) {
  const hours = plan.assignments.filter((a) => a.resource === resource);
  const groups: { start: number; end: number; field: string; destination: string }[] = [];
  for (const a of hours) {
    const prev = groups.at(-1);
    if (prev && prev.field === a.field && prev.destination === a.destination && prev.end === a.hour) {
      prev.end = a.hour + 1;
    } else {
      groups.push({ start: a.hour, end: a.hour + 1, field: a.field, destination: a.destination });
    }
  }
  return groups;
}

// --- Sub-components ---

function Metric({
  label,
  value,
  unit,
  detail,
  tone = 'plain',
}: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  tone?: 'plain' | 'danger' | 'success';
}) {
  return (
    <article className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>
        {value} {unit && <small>{unit}</small>}
      </strong>
      <p>{detail}</p>
    </article>
  );
}

function Timeline({
  plan,
  rainAt,
  constrained,
}: {
  plan: Plan;
  rainAt: number;
  constrained: boolean;
}) {
  const resources: Resource[] = plan.strategy.contractor ? ['H1', 'H2', 'C1'] : ['H1', 'H2'];
  return (
    <div className="timeline-wrap" aria-label="48-hour resource allocation timeline">
      <div className="timeline-scale" aria-hidden="true">
        <span>NOW</span>
        <span>+12H</span>
        <span>+24H</span>
        <span>+36H</span>
        <span>+48H</span>
      </div>
      <div className="timeline-body">
        <div
          className="rain-window"
          style={{ left: pct((rainAt / HORIZON) * 100), width: pct((6 / HORIZON) * 100) }}
        >
          <CloudRain size={14} />
          <span>RAIN</span>
        </div>
        {resources.map((resource) => (
          <div className="timeline-row" key={resource}>
            <b>{resource}</b>
            <div className="timeline-track">
              {groupAssignments(plan, resource).map((group, index) => {
                const field = fieldMap[group.field];
                return (
                  <span
                    className="timeline-block"
                    key={`${resource}-${group.start}-${index}`}
                    title={`${field.name} · ${group.destination}`}
                    style={{
                      left: pct((group.start / HORIZON) * 100),
                      width: pct(((group.end - group.start) / HORIZON) * 100),
                      background: field.color,
                    }}
                  >
                    <i>{field.name}</i>
                  </span>
                );
              })}
              {constrained && resource === 'H2' && (
                <span
                  className="constraint-window"
                  style={{
                    left: pct(((rainAt + 6) / HORIZON) * 100),
                    width: pct((Math.min(24, HORIZON - rainAt - 6) / HORIZON) * 100),
                  }}
                >
                  NO NORTH 4
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="legend-rain" /> Weather downtime
        </span>
        <span>
          <i className="legend-rule" /> Confirmed exclusion
        </span>
        <span>Block colour = field</span>
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: number }) {
  const steps = ['Plan', 'Disrupt', 'Optimise', 'Knowledge'];
  return (
    <div className="stepper" aria-label={`Demo step ${step + 1} of 4`}>
      {steps.map((label, index) => (
        <span key={label} className={index <= step ? 'active' : ''}>
          <i>{index + 1}</i>
          {label}
        </span>
      ))}
    </div>
  );
}

// --- Main component ---
export default function FarmControl() {
  const [phase, setPhase] = useState<Phase>('normal');
  const [busy, setBusy] = useState(false);
  const [ruleText, setRuleText] = useState(exampleRule);
  const [draftRule, setDraftRule] = useState<Rule | null>(null);
  const [confirmedRule, setConfirmedRule] = useState<Rule | null>(null);
  const [ruleError, setRuleError] = useState('');

  const ruleSearch = useMemo(
    () => (confirmedRule ? optimise(disruption, [confirmedRule], disruptedSearch.best) : null),
    [confirmedRule]
  );

  const scenario = phase === 'normal' ? normal : disruption;
  const plan =
    phase === 'normal'
      ? initialSearch.best
      : phase === 'disrupted'
        ? incumbentDisrupted
        : phase === 'rule' && ruleSearch
          ? ruleSearch.best
          : disruptedSearch.best;
  const activeSearch = phase === 'rule' && ruleSearch ? ruleSearch : disruptedSearch;
  const insights = explain(plan, scenario, confirmedRule ? [confirmedRule] : []);
  const benefit = incumbentDisrupted.economics.totalCost - plan.economics.totalCost;

  const step = phase === 'normal' ? 0 : phase === 'disrupted' ? 1 : phase === 'optimised' ? 2 : 3;

  // --- Actions ---
  const simulate = () => {
    setPhase('disrupted');
    setConfirmedRule(null);
    setDraftRule(null);
  };

  const run = () => {
    if (phase === 'normal') simulate();
    setBusy(true);
    window.setTimeout(() => {
      setPhase('optimised');
      setBusy(false);
    }, 750);
  };

  const stageRule = (text = ruleText) => {
    try {
      const parsed = parseRule(text);
      setDraftRule(parsed);
      setRuleError('');
      return parsed;
    } catch (error) {
      setDraftRule(null);
      setRuleError(error instanceof Error ? error.message : 'Could not interpret this rule.');
      throw error;
    }
  };

  const confirmRule = () => {
    if (!draftRule) return;
    setBusy(true);
    window.setTimeout(() => {
      setConfirmedRule(draftRule);
      setDraftRule(null);
      setPhase('rule');
      setBusy(false);
    }, 750);
  };

  const reset = () => {
    setPhase('normal');
    setBusy(false);
    setDraftRule(null);
    setConfirmedRule(null);
    setRuleError('');
    setRuleText(exampleRule);
  };

  // Register WebMCP tools so an AI assistant can drive the demo
  useEffect(() => {
    const context = (document as WebMCPDocument).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Parameters<typeof context.registerTool>[0]) =>
      Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);

    void register({
      name: 'simulate_harvest_disruption',
      title: 'Simulate harvest disruption',
      description: 'Move rain forward to hour 17 and restrict H2 to its externally approved 70% capacity.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () => {
        simulate();
        return { phase: 'disrupted', rainAt: 17, h2Capacity: 0.7 };
      },
    });

    void register({
      name: 'reoptimise_harvest_operation',
      title: 'Reoptimise harvest operation',
      description: 'Evaluate candidate strategies and display the lowest-cost feasible plan.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () => {
        run();
        return { phase: 'optimising', candidates: disruptedSearch.evaluated };
      },
    });

    void register({
      name: 'stage_manager_constraint',
      title: 'Stage manager constraint',
      description: 'Interpret and stage a manager rule for human confirmation.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: (input) => {
        if (typeof input.text !== 'string') throw new Error('text must be a string');
        setRuleText(input.text);
        return { staged: true, rule: stageRule(input.text) };
      },
    });

    return () => lifecycle.abort();
  }, [phase, ruleText]);

  return (
    <main className="workspace">
      {/* Top bar */}
      <header className="topbar">
        <div className="brand">
          FarmOpti <span>/ HARVEST CONTROL</span>
        </div>
        <div className="top-actions">
          <span className="live-dot">
            <i /> LIVE SIMULATION
          </span>
          <span className="demo-badge">SYNTHETIC DATA</span>
          <button
            className="icon-button"
            onClick={reset}
            title="Reset demonstration"
            aria-label="Reset demonstration"
          >
            <RotateCcw size={17} />
          </button>
        </div>
      </header>

      {/* Page heading */}
      <section className="heading">
        <div>
          <p className="eyebrow">
            <MapPin size={13} /> GLENARA FARM · RIVERINA, NSW
          </p>
          <h1>Harvest operations</h1>
          <p>48-hour plan · Updated from field, fleet, logistics and weather constraints</p>
        </div>
        <StepIndicator step={step} />
      </section>

      {/* Disruption alert */}
      {phase === 'disrupted' && (
        <section className="alert-banner" role="alert">
          <AlertTriangle />
          <div>
            <strong>Current plan no longer optimal</strong>
            <p>
              Rain is now 14 hours earlier and H2 has moved to an externally approved 70% operating
              limit.
            </p>
          </div>
          <button className="primary light" onClick={run}>
            Reoptimise operation <ArrowRight size={17} />
          </button>
        </section>
      )}

      {/* Success banner */}
      {(phase === 'optimised' || phase === 'rule') && (
        <section className="success-banner">
          <CheckCircle2 />
          <div>
            <strong>
              {phase === 'rule'
                ? 'Farm rule applied · plan recalculated'
                : 'Recommended response found'}
            </strong>
            <p>
              {number(activeSearch.evaluated)} candidate schedules evaluated against the same
              operating conditions.
            </p>
          </div>
          <strong className="impact">
            {money(benefit)} <small>expected improvement</small>
          </strong>
        </section>
      )}

      {/* Metrics row */}
      <section className="metrics">
        <Metric
          label="Remaining harvest"
          value={number(farmArea)}
          unit="ha"
          detail="6 fields · 2,506 modelled tonnes"
        />
        <Metric
          label="Rain arrives in"
          value={String(scenario.rainAt)}
          unit="hours"
          detail={`${Math.round(scenario.probability * 100)}% probability · ${scenario.rainMm} mm expected`}
          tone={phase === 'normal' ? 'plain' : 'danger'}
        />
        <Metric
          label="H2 permitted capacity"
          value={`${Math.round(scenario.h2Capacity * 100)}%`}
          detail={
            phase === 'normal'
              ? 'Normal telemetry · externally supplied'
              : 'Elevated vibration · inspect after shift'
          }
          tone={phase === 'normal' ? 'plain' : 'danger'}
        />
        <Metric
          label="Wheat commitment"
          value={number(delivery.tonnes)}
          unit="t"
          detail={`${number(plan.deliveredOnTime)} t scheduled by hour ${delivery.due}`}
          tone={plan.deliveredOnTime >= delivery.tonnes ? 'success' : 'danger'}
        />
      </section>

      {/* Main dashboard grid: timeline + decision brief */}
      <div className="dashboard-grid">
        <section className="panel plan-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">
                {phase === 'normal'
                  ? 'CURRENT OPTIMAL PLAN'
                  : phase === 'disrupted'
                    ? 'PREVIOUS PLAN · REPLAYED'
                    : 'RECOMMENDED PLAN'}
              </p>
              <h2>
                {phase === 'disrupted'
                  ? 'Conditions changed. Recalculate the response.'
                  : plan.strategy.label}
              </h2>
            </div>
            <span className={`status-chip ${phase === 'disrupted' ? 'status-danger' : ''}`}>
              {phase === 'disrupted' ? 'OUTDATED' : 'BEST EVALUATED'}
            </span>
          </div>

          <Timeline plan={plan} rainAt={scenario.rainAt} constrained={phase === 'rule'} />

          <div className="plan-stats">
            <div>
              <span>Harvested in window</span>
              <strong>{number(plan.harvested)} ha</strong>
            </div>
            <div>
              <span>Before rain</span>
              <strong>{number(plan.beforeRain)} ha</strong>
            </div>
            <div>
              <span>Forecast exposed</span>
              <strong>{number(plan.exposed)} ha</strong>
            </div>
            <div>
              <span>Expected contribution</span>
              <strong>{money(plan.economics.contribution)}</strong>
            </div>
          </div>

          {phase === 'normal' && (
            <button className="disrupt-button" onClick={simulate}>
              <Zap size={19} /> Simulate disruption{' '}
              <span>RAIN + MACHINE EVENT</span>
            </button>
          )}
          {phase === 'disrupted' && (
            <button className="primary wide" onClick={run}>
              <Sparkles size={18} /> Reoptimise operation
            </button>
          )}
        </section>

        <aside className="panel decision-panel">
          <p className="eyebrow">DECISION BRIEF</p>
          <h2>
            {phase === 'normal'
              ? 'Plan rationale'
              : phase === 'disrupted'
                ? 'What changed'
                : 'Why this plan wins'}
          </h2>
          <ol className="insight-list">
            {(phase === 'disrupted'
              ? [
                  'Rain moves from hour 31 to hour 17, increasing crop exposure.',
                  'H2 throughput falls from 10 to 7 ha/hour under the permitted restriction.',
                  'The previous schedule is replayed under the new facts for a fair comparison.',
                ]
              : insights
            ).map((insight, index) => (
              <li key={insight}>
                <span>{index + 1}</span>
                <p>{insight}</p>
              </li>
            ))}
          </ol>
          <div className="safety-note">
            <ShieldCheck size={19} />
            <p>
              <strong>Safety boundary</strong>H2&apos;s 70% state is an external constraint.
              FarmOpti does not diagnose or authorise machinery operation.
            </p>
          </div>
        </aside>
      </div>

      {/* Counterfactual comparison (appears after optimising) */}
      {(phase === 'optimised' || phase === 'rule') && (
        <section className="panel comparison-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">COUNTERFACTUAL</p>
              <h2>Same disruption. Different operating decisions.</h2>
            </div>
            <span className="method-note">Lowest modelled cost wins</span>
          </div>

          <div className="compare-cards">
            <article>
              <span>Previous plan under disruption</span>
              <strong>{money(incumbentDisrupted.economics.totalCost)}</strong>
              <p>Total modelled cost and loss</p>
            </article>
            <ChevronRight />
            <article className="winner">
              <span>Recommended response</span>
              <strong>{money(plan.economics.totalCost)}</strong>
              <p>{money(benefit)} lower expected cost</p>
            </article>
          </div>

          <Table className="alternatives-table">
            <TableHeader>
              <TableRow>
                <TableHead>Strategy</TableHead>
                <TableHead className="num">Before rain</TableHead>
                <TableHead className="num">Contractor</TableHead>
                <TableHead className="num">Weather loss</TableHead>
                <TableHead className="num">Total modelled cost</TableHead>
                <TableHead>Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeSearch.alternatives.map((item, index) => (
                <TableRow key={item.strategy.id} className={index === 0 ? 'selected-row' : ''}>
                  <TableCell>
                    <strong>{item.strategy.label}</strong>
                    <small>
                      {item.route === 'split'
                        ? '2 trucks to receival · 1 to storage'
                        : '3 trucks to receival'}
                    </small>
                  </TableCell>
                  <TableCell className="num">{number(item.beforeRain)} ha</TableCell>
                  <TableCell className="num">{money(item.economics.contractorCost)}</TableCell>
                  <TableCell className="num">{money(item.economics.weatherLoss)}</TableCell>
                  <TableCell className="num">
                    <strong>{money(item.economics.totalCost)}</strong>
                  </TableCell>
                  <TableCell>
                    {index === 0 ? <span className="best-pill">BEST</span> : 'Not selected'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="model-note">
            Expected values use synthetic assumptions. Total modelled cost = weather loss + residual-work
            delay + delivery penalties + contractor + owned-machine + transport costs.
          </p>
        </section>
      )}

      {/* Lower grid: fields + assets */}
      <section className="lower-grid">
        <section className="panel fields-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">FIELD STATE</p>
              <h2>Readiness and rainfall exposure</h2>
            </div>
            <span>800 ha total</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Crop</TableHead>
                <TableHead className="num">Area</TableHead>
                <TableHead className="num">Moisture</TableHead>
                <TableHead>Ready</TableHead>
                <TableHead>Priority</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field) => (
                <TableRow key={field.id}>
                  <TableCell>
                    <span className="field-dot" style={{ background: field.color }} />
                    <strong>{field.name}</strong>
                  </TableCell>
                  <TableCell>{field.crop}</TableCell>
                  <TableCell className="num">{field.hectares} ha</TableCell>
                  <TableCell className="num">{field.moisture}%</TableCell>
                  <TableCell>{field.ready === 0 ? 'Now' : `+${field.ready}h`}</TableCell>
                  <TableCell>
                    <span
                      className={`priority p-${
                        field.rainLoss >= 180 ? 'high' : field.rainLoss >= 100 ? 'medium' : 'low'
                      }`}
                    >
                      {field.rainLoss >= 180 ? 'VERY HIGH' : field.rainLoss >= 100 ? 'HIGH' : 'MONITOR'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <aside className="panel assets-panel">
          <p className="eyebrow">OPERATIONAL CAPACITY</p>
          <h2>Fleet, logistics and labour</h2>
          <div className="asset-list">
            <article>
              <Tractor />
              <div>
                <strong>H1 · Combine</strong>
                <span>12 ha/h · healthy</span>
              </div>
              <i className="ok" />
            </article>
            <article>
              <Tractor />
              <div>
                <strong>H2 · Combine</strong>
                <span>{phase === 'normal' ? '10 ha/h · healthy' : '7 ha/h · restricted'}</span>
              </div>
              <i className={phase === 'normal' ? 'ok' : 'warn'} />
            </article>
            <article>
              <Truck />
              <div>
                <strong>T1 · T2 · T3</strong>
                <span>2 receival / 1 storage in split plan</span>
              </div>
              <i className="ok" />
            </article>
            <article>
              <Warehouse />
              <div>
                <strong>2 destinations</strong>
                <span>Regional receival · on-farm storage</span>
              </div>
              <i className="ok" />
            </article>
          </div>
          <div className="labour">
            <span>Labour coverage</span>
            <strong>{workers.length} people</strong>
            <div>
              {workers.map((worker) => (
                <i key={worker}>{worker.split(' · ')[0]}</i>
              ))}
            </div>
            <p>Two scheduled 2-hour changeovers are enforced.</p>
          </div>
        </aside>
      </section>

      {/* Knowledge panel: manager rule capture */}
      <section
        className={`panel knowledge-panel ${
          phase === 'normal' || phase === 'disrupted' ? 'locked' : ''
        }`}
      >
        <div className="knowledge-intro">
          <span className="brain-icon">
            <BrainCircuit />
          </span>
          <div>
            <p className="eyebrow">MANAGER KNOWLEDGE</p>
            <h2>Turn experience into an explicit constraint</h2>
            <p>
              The interpreter proposes a structured rule. The manager confirms it before the optimiser
              can use it.
            </p>
          </div>
        </div>

        <div className="rule-compose">
          <label htmlFor="manager-rule">Operating rule</label>
          <textarea
            id="manager-rule"
            value={ruleText}
            onChange={(event) => setRuleText(event.target.value)}
            disabled={phase === 'normal' || phase === 'disrupted' || !!confirmedRule}
            rows={3}
          />
          <div className="rule-actions">
            <span>Deterministic interpreter · works offline</span>
            {!confirmedRule && (
              <button
                className="secondary"
                disabled={phase === 'normal' || phase === 'disrupted'}
                onClick={() => {
                  try {
                    stageRule();
                  } catch {}
                }}
              >
                <Sparkles size={16} /> Interpret rule
              </button>
            )}
          </div>
          {ruleError && (
            <p className="error-text" role="alert">
              {ruleError}
            </p>
          )}
        </div>

        {(draftRule || confirmedRule) && (
          <div className={`structured-rule ${confirmedRule ? 'confirmed' : ''}`}>
            <div className="rule-head">
              <span>
                {confirmedRule ? <CheckCircle2 /> : <Gauge />}
                {confirmedRule
                  ? 'CONFIRMED OPERATING CONSTRAINT'
                  : 'PROPOSED CONSTRAINT · REVIEW REQUIRED'}
              </span>
              {draftRule && (
                <button className="primary" onClick={confirmRule}>
                  Confirm &amp; reoptimise
                </button>
              )}
            </div>
            <dl>
              <div>
                <dt>Resource</dt>
                <dd>{(draftRule ?? confirmedRule)?.resource}</dd>
              </div>
              <div>
                <dt>Field</dt>
                <dd>{fieldMap[(draftRule ?? confirmedRule)!.field].name}</dd>
              </div>
              <div>
                <dt>Trigger</dt>
                <dd>Rainfall &gt; {(draftRule ?? confirmedRule)?.rainfallMm} mm</dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd>{(draftRule ?? confirmedRule)?.windowHours}h after rain</dd>
              </div>
              <div>
                <dt>Constraint</dt>
                <dd>Assignment prohibited</dd>
              </div>
            </dl>
            {confirmedRule && (
              <p>
                <CheckCircle2 size={15} /> H2&apos;s North 4 assignments after the rain have been
                removed and the schedule recalculated.
              </p>
            )}
          </div>
        )}

        {(phase === 'normal' || phase === 'disrupted') && (
          <div className="lock-copy">
            Reoptimise the disrupted operation to unlock manager knowledge capture.
          </div>
        )}
      </section>

      <footer>
        <span>FarmOpti prototype · Track 3: Solve a Business Problem</span>
        <span>All farm data and financial results are synthetic</span>
      </footer>

      {/* Loading overlay */}
      {busy && (
        <div className="optimising" role="status">
          <span>
            <Sparkles />
            <strong>Reoptimising operation</strong>
            <small>
              Testing field sequences, fleet states, truck routes and contractor choices…
            </small>
          </span>
        </div>
      )}
    </main>
  );
}

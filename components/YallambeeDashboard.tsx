'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Bug,
  CheckCircle2,
  Grid2X2,
  HardHat,
  Leaf,
  MessageCircle,
  PackageOpen,
  RotateCcw,
  Send,
  ShieldCheck,
  Tractor,
  Truck,
  Users,
  Warehouse,
  Wrench,
  X,
} from 'lucide-react';
import { yallambeeOpsDashboard } from '@/app/yallambee-ops';
import { managementPlanInputs, persistedDashboardPlan, persistedSchedule, persistedSummary, scheduleAnchorTime, type ManagementPlanInput } from '@/lib/ui/persisted-optimizer-output';
import type { DashboardView, FarmField, OptimiserCandidate } from '@/app/yallambee-ops';

type ViewKey = DashboardView;
type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';

const navGroups: { label: string; items: { id: ViewKey; label: string; icon: typeof Grid2X2; badge?: string; tone?: Tone }[] }[] = [
  {
    label: 'Today',
    items: [
      { id: 'command', label: 'Command', icon: Grid2X2 },
      { id: 'harvest', label: 'Harvest operations', icon: Tractor},
      { id: 'rules', label: 'Farm rules', icon: BookOpen},
    ],
  },
];

const titleByView: Record<ViewKey, string> = {
  command: 'Command',
  harvest: 'Harvest operations',
  grain: 'Grain & logistics',
  protection: 'Crop protection',
  agronomy: 'Paddocks & agronomy',
  fleet: 'Fleet & maintenance',
  people: 'People & safety',
  markets: 'Contracts & margin',
  rules: 'Farm rules',
};

const cropClass: Record<string, string> = {
  wheat: 'yc-crop-wheat',
  barley: 'yc-crop-barley',
  canola: 'yc-crop-canola',
  lentil: 'yc-crop-lentil',
  beans: 'yc-crop-beans',
  oats: 'yc-crop-oats',
};

const persistedPlan = persistedDashboardPlan();

function money(value: number) {
  return `A$${Math.abs(Math.round(value)).toLocaleString('en-AU')}`;
}

function signedMoney(value: number) {
  return `${value < 0 ? '−' : ''}A$${Math.abs(Math.round(value)).toLocaleString('en-AU')}`;
}

function hectares(value: number) {
  return `${Math.round(value).toLocaleString('en-AU')} ha`;
}

function Badge({ tone = 'mute', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`yc-pill yc-pill-${tone}`}>{children}</span>;
}

function StatCard({ label, value, unit, detail, meter, tone = 'green' }: { label: string; value: string; unit?: string; detail: React.ReactNode; meter?: number; tone?: 'green' | 'amber' | 'red' | 'blue' }) {
  return (
    <article className="yc-card yc-stat">
      <span className="yc-kicker">{label}</span>
      <strong>{value} {unit && <small>{unit}</small>}</strong>
      <span className="yc-detail">{detail}</span>
      {meter !== undefined && <div className="yc-meter"><i className={`yc-meter-${tone}`} style={{ width: `${Math.min(100, meter)}%` }} /></div>}
    </article>
  );
}

function FieldBadge({ field }: { field: FarmField }) {
  return <span className="yc-crop"><i className={cropClass[field.crop]} />{yallambeeOpsDashboard.crops[field.crop].label}</span>;
}

const TIMELINE_DAY_TICK_THRESHOLD_HOURS = 48;
const TIMELINE_PRESETS: { label: string; hours: number | null }[] = [
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 168 },
  { label: 'Full', hours: null },
];

function timelineClock(hour: number) {
  return new Date(scheduleAnchorTime + hour * 3_600_000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

function timelineDay(hour: number, withYear = false) {
  return new Date(scheduleAnchorTime + hour * 3_600_000).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
}

function timelineDateTime(hour: number) {
  return `${timelineDay(hour)}, ${timelineClock(hour)}`;
}

function Timeline({ plan, disrupted }: { plan: OptimiserCandidate; disrupted: boolean }) {
  const fullHours = Math.max(24, ...plan.blocks.map((block) => block.e));
  const [rangeHours, setRangeHours] = useState<number | null>(null);
  const totalHours = Math.min(fullHours, rangeHours ?? fullHours);
  const isFullRange = rangeHours === null;

  const rows = [...new Set(plan.blocks.map((block) => block.m))];
  const labels: Record<string, string> = Object.fromEntries(rows.map((row) => [row, row]));

  // Once a range spans more than ~2 days, hourly ticks get too cramped to
  // read, so switch to one tick per day. Every preset -- including "Full" --
  // fits within the visible width (fluid, not scaled by hours) so picking a
  // range means seeing that whole range at once, with no scrolling needed;
  // .yc-timeline-scroll stays only as a safety net for very narrow screens.
  const useDayTicks = totalHours > TIMELINE_DAY_TICK_THRESHOLD_HOURS;
  const tickStepHours = useDayTicks ? 24 : 6;
  const tickCount = Math.max(1, Math.ceil(totalHours / tickStepHours));
  let ticks = Array.from({ length: tickCount + 1 }, (_, index) => Math.min(totalHours, index * tickStepHours));
  let tickLabels = ticks.map((hour) => (useDayTicks ? timelineDay(hour) : timelineClock(hour)));
  // The final tick is clamped to totalHours, which can land on the same day
  // (or, at fine granularity, the same displayed time) as the tick before it.
  if (tickLabels.length > 1 && tickLabels.at(-1) === tickLabels.at(-2)) {
    ticks = ticks.slice(0, -1);
    tickLabels = tickLabels.slice(0, -1);
  }
  const gridlinePct = (tickStepHours / totalHours) * 100;

  return (
    <div className="yc-timeline">
      <div className="yc-timeline-toolbar">
        <span>Showing {isFullRange ? 'the full schedule' : TIMELINE_PRESETS.find((preset) => preset.hours === rangeHours)?.label}: {timelineDay(0, true)} → {timelineDay(totalHours, true)}</span>
        <div className="yc-timeline-presets">
          {TIMELINE_PRESETS.map((preset) => <button type="button" key={preset.label} className={`yc-timeline-preset ${(preset.hours === null ? isFullRange : preset.hours === rangeHours) ? 'yc-timeline-preset-active' : ''}`} onClick={() => setRangeHours(preset.hours)}>{preset.label}</button>)}
        </div>
      </div>
      <div className="yc-timeline-scroll"><div className="yc-timeline-content">
        <div className="yc-timeline-hours" style={{ gridTemplateColumns: `repeat(${ticks.length}, 1fr)` }}>{tickLabels.map((label, index) => <span key={ticks[index]}>{label}</span>)}</div>
        <div className="yc-timeline-stage" style={{ background: `repeating-linear-gradient(to right, transparent 0, transparent calc(${gridlinePct}% - 1px), rgba(14,26,22,.06) calc(${gridlinePct}% - 1px), rgba(14,26,22,.06) ${gridlinePct}%)` }}>
          {disrupted && 17.1 <= totalHours && <div className="yc-rain-shade" style={{ left: `${(17.1 / totalHours) * 100}%` }}><b>FRONT 23:18 · 22 MM</b></div>}
          {rows.map((row) => {
            const blocks = plan.blocks.filter((block) => block.m === row && block.s < totalHours);
            return (
              <div className="yc-lane" key={row}>
                <span>{labels[row]}</span>
                <div className="yc-track">
                  {blocks.map((block, index) => <i className={`yc-block ${cropClass[block.crop]}`} key={`${row}-${index}`} style={{ left: `${(block.s / totalHours) * 100}%`, width: `${Math.min(100 - (block.s / totalHours) * 100, ((Math.min(totalHours, block.e) - block.s) / totalHours) * 100)}%` }} title={`${block.name} · ${timelineDateTime(block.s)} → ${timelineDateTime(block.e)}`}>{block.name}</i>)}
                  {!blocks.length && <i className="yc-block yc-idle" style={{ left: 0, width: '100%' }}>No assignment in this window</i>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="yc-legend"><span><i className="yc-legend-wheat" /> Wheat</span><span><i className="yc-legend-canola" /> Canola</span><span><i className="yc-legend-lentil" /> Lentils</span><span><i className="yc-legend-haul" /> Haulage</span></div>
      </div></div>
    </div>
  );
}

function DecisionAssistant() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<{ role: 'assistant' | 'user'; text: string }[]>([
    { role: 'assistant', text: 'Ask why a schedule decision was made, what evidence supports it, or test a concrete scenario.' },
  ]);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [open, messages, busy]);

  const ask = async (prompt = question) => {
    const text = prompt.trim();
    if (!text || busy) return;
    setQuestion('');
    setMessages((current) => [...current, { role: 'user', text }]);
    setBusy(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
      });
      const result = (await response.json()) as { answer?: string; error?: string };
      setMessages((current) => [...current, { role: 'assistant', text: response.ok ? result.answer ?? 'No answer returned.' : result.error ?? 'The assistant could not answer that.' }]);
    } catch {
      setMessages((current) => [...current, { role: 'assistant', text: 'The decision assistant could not be reached. Check that the optimizer evidence outputs exist and the configured model is available.' }]);
    } finally {
      setBusy(false);
    }
  };

  return <div className="yc-chat-widget">
    {open && <section className="yc-card yc-chat-popup" aria-label="Decision assistant">
      <header>
        <div><h3>Decision assistant</h3><span>Evidence-grounded explanations</span></div>
        <Badge tone="info">FarmOpti</Badge>
        <button className="yc-icon-button yc-chat-close" onClick={() => setOpen(false)} aria-label="Close decision assistant"><X size={15} /></button>
      </header>
      <div className="yc-chat-log" ref={logRef}>
        {messages.map((message, index) => <p className={`yc-chat-bubble yc-chat-${message.role}`} key={`${message.role}-${index}`}>{message.text}</p>)}
        {busy && <p className="yc-chat-bubble yc-chat-assistant yc-chat-pending">Reviewing optimisation evidence...</p>}
      </div>
      <div className="yc-chat-suggestions">
        <button onClick={() => ask('Why was the selected harvest plan chosen?')}>Why this plan?</button>
        <button onClick={() => ask('What changed in the current optimisation?')}>What changed?</button>
      </div>
      <form className="yc-chat-form" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about a decision or scenario..." aria-label="Ask the decision assistant" />
        <button className="yc-btn yc-btn-dark" disabled={busy || !question.trim()} aria-label="Send question"><Send size={15} /></button>
      </form>
    </section>}
    <button className="yc-chat-fab" onClick={() => setOpen((current) => !current)} aria-label={open ? 'Close decision assistant' : 'Open decision assistant'} aria-expanded={open}>
      {open ? <X size={20} /> : <MessageCircle size={20} />}
    </button>
  </div>;
}

function OptimizerInputPanel() {
  const [selectedId, setSelectedId] = useState(managementPlanInputs[0]?.plan_id ?? '');
  const [drafts, setDrafts] = useState<Record<string, ManagementPlanInput>>(() => Object.fromEntries(managementPlanInputs.map((input) => [input.plan_id, { ...input }])));
  const [saved, setSaved] = useState(false);
  const draft = drafts[selectedId] ?? managementPlanInputs[0];

  const selectPlan = (planId: string) => {
    setSelectedId(planId);
    setSaved(false);
  };

  const update = (key: keyof ManagementPlanInput, value: string | boolean) => {
    setDrafts((current) => ({ ...current, [selectedId]: { ...current[selectedId], [key]: value } }));
    setSaved(false);
  };

  const exportPlan = () => {
    const rows = managementPlanInputs.map((input) => drafts[input.plan_id] ?? input);
    const header = 'plan_id,field_id,operation,target,amount,unit,allowed_from,allowed_to,required,depends_on,min_gap_hours';
    const csv = [header, ...rows.map((input) => [input.plan_id, input.field_id, input.operation, input.target, input.amount, input.unit, input.allowed_from, input.allowed_to, input.required ? '1' : '0', input.depends_on, input.min_gap_hours].join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = 'management_plan.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return <section className="yc-card yc-input-panel"><header><div><h3>Management plan editor</h3><span>Modify the fields used by the next optimizer pipeline run</span></div><Badge tone="info">UI draft</Badge></header><div className="yc-card-body"><div className="yc-input-grid"><label>Action<select value={selectedId} onChange={(event) => selectPlan(event.target.value)}>{managementPlanInputs.map((input) => <option key={input.plan_id} value={input.plan_id}>{input.plan_id} · {input.field_id} · {input.operation}</option>)}</select></label><label>Allowed from<input type="date" value={draft.allowed_from} onChange={(event) => update('allowed_from', event.target.value)} /></label><label>Allowed to<input type="date" value={draft.allowed_to} onChange={(event) => update('allowed_to', event.target.value)} /></label><label>Amount {draft.unit && `(${draft.unit})`}<input value={draft.amount} placeholder="Optional" onChange={(event) => update('amount', event.target.value)} /></label></div><div className="yc-input-meta"><span><b>{draft.field_id}</b> · {draft.operation} · {draft.target || 'no target'}</span><label className="yc-check"><input type="checkbox" checked={draft.required} onChange={(event) => update('required', event.target.checked)} /> Required action</label></div><div className="yc-input-actions"><span>{saved ? 'All edits are retained in this editor. Export the CSV to use them in the pipeline.' : 'Edit multiple actions, then export one complete management_plan.csv.'}</span><button className="yc-btn" onClick={() => setSaved(true)}>Save edits</button><button className="yc-btn yc-btn-dark" onClick={exportPlan}>Download management_plan.csv</button></div></div></section>;
}

function CommandView({ plan, evaluated, improvement, onNavigate }: { plan: OptimiserCandidate; evaluated: number; improvement: number; onNavigate: (view: ViewKey) => void }) {
  const alerts = [
    { tone: 'warn' as Tone, title: 'Field readiness is limiting the candidate set', text: 'The optimizer only schedules fields that meet readiness and weather feasibility rules.', view: 'harvest' as ViewKey, when: 'Current' },
    { tone: 'info' as Tone, title: 'Resource capacity is binding', text: 'Machine, labour and destination capacity are included when candidates are scored.', view: 'harvest' as ViewKey, when: 'Current' },
  ].filter(Boolean) as { tone: Tone; title: string; text: string; view: ViewKey; when: string }[];

  return <>
    <div className="yc-page-head"><div><h2>Command</h2><p>Everything that could change today&apos;s plan, in one place. This view reflects the latest persisted pipeline result.</p></div><div className="yc-actions"><button className="yc-btn" onClick={() => onNavigate('rules')}><BookOpen size={15} /> Farm rules</button><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('harvest')}><Tractor size={15} /> Open schedule</button></div></div>
    <section className="yc-hero"><div className="yc-hero-head"><div><h3>Persisted resource plan</h3><span>{plan.label} · {persistedSchedule.length} actions from the pipeline snapshot</span></div><div className="yc-hero-legend"><span><i className="yc-legend-wheat" /> Wheat</span><span><i className="yc-legend-canola" /> Other operations</span></div></div><Timeline plan={plan} disrupted={false} /></section>
    <div className="yc-grid yc-grid-4"><StatCard label="Scheduled actions" value={String(persistedSummary.num_scheduled_actions)} detail="Selected by the persisted optimizer" meter={100} /><StatCard label="Direct cash effect" value={money(persistedSummary.total_direct_cash_effect_aud)} detail="Sum of optimal_schedule.csv" tone="blue" /><StatCard label="Terminal value" value={money(persistedSummary.total_terminal_value_aud)} detail="Value carried into the objective" tone="green" /><StatCard label="Objective value" value={money(persistedSummary.total_objective_value_aud)} detail={`Status: ${persistedSummary.status}`} meter={100} tone="amber" /></div>
    <div className="yc-grid yc-grid-main"><section className="yc-card"><header><h3>Needs a decision</h3><span>{alerts.length} total</span></header><div className="yc-feed">{alerts.map((alert) => <button className="yc-feed-item" key={alert.title} onClick={() => onNavigate(alert.view)}><i className={`yc-severity yc-severity-${alert.tone}`} /><span><b>{alert.title}</b><small>{alert.text}</small></span><time>{alert.when}</time></button>)}</div></section><section className="yc-card"><header><h3>Optimiser result</h3><span>{evaluated.toLocaleString('en-AU')} candidates evaluated</span></header><div className="yc-card-body"><dl className="yc-kv"><dt>Selected strategy</dt><dd>{plan.label}</dd><dt>Route</dt><dd>{plan.haul > 25.5 ? 'Split route' : 'Receival route'}</dd><dt>Modelled cost</dt><dd>{money(Math.abs(plan.net))}</dd><dt>Improvement</dt><dd className={improvement > 0 ? 'yc-up' : ''}>{improvement > 0 ? '+' : ''}{money(improvement)}</dd></dl><p className="yc-result-note">These values come directly from the current optimiser run. The disruption view replays the incumbent plan before comparing alternatives.</p></div></section></div>
    <section className="yc-card yc-scope"><header><h3>Supported system scope</h3><Badge tone="ok">Connected</Badge></header><div className="yc-card-body"><p>The current system can optimise schedules, score economics, apply weather, machine, labour and field-state constraints, and explain recorded decisions.</p><button className="yc-btn" onClick={() => onNavigate('harvest')}>Open supported plan <ArrowRight size={15} /></button></div></section>
    <div className="yc-result-source"><CheckCircle2 size={15} /> Displaying the latest persisted pipeline result. Run the optimizer pipeline to refresh this snapshot.</div>
  </>;
}

function DetailView({ view, plan, disrupted, onNavigate }: { view: ViewKey; plan: OptimiserCandidate; disrupted: boolean; onNavigate: (view: ViewKey) => void }) {
  const fields = yallambeeOpsDashboard.fields;
  if (view === 'rules') return <><div className="yc-page-head"><div><h2>Farm rules & optimizer inputs</h2><p>Modify the management-plan inputs used by the existing optimizer pipeline. Changes are prepared in the browser and exported as a replacement CSV.</p></div><div className="yc-actions"><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('command')}><Grid2X2 size={15} /> Back to command</button></div></div><OptimizerInputPanel /><Table title="Current management plan"><thead><tr><th>Plan</th><th>Field</th><th>Operation</th><th>Target</th><th>Window</th><th>Required</th></tr></thead><tbody>{managementPlanInputs.map((input) => <tr key={input.plan_id}><td><b>{input.plan_id}</b></td><td>{input.field_id}</td><td>{input.operation}</td><td>{input.target || '—'}</td><td>{input.allowed_from} to {input.allowed_to}</td><td><Badge tone={input.required ? 'ok' : 'mute'}>{input.required ? 'Required' : 'Optional'}</Badge></td></tr>)}</tbody></Table></>;
  if (view === 'harvest') return <><div className="yc-page-head"><div><h2>Harvest operations</h2><p>This view mirrors the persisted schedule generated by the optimizer pipeline.</p></div><div className="yc-actions"><button className="yc-btn yc-btn-primary" onClick={() => onNavigate('command')}>Back to command</button></div></div><section className="yc-hero"><div className="yc-hero-head"><div><h3>Persisted resource plan</h3><span>{persistedSchedule.length} scheduled actions · source: optimal_schedule.csv</span></div></div><Timeline plan={plan} disrupted={disrupted} /></section><Table title="Persisted schedule assignments"><thead><tr><th>Field</th><th>Operation</th><th>Target</th><th>Machine</th><th>Start</th><th>End</th><th className="yc-right">Cash effect</th></tr></thead><tbody>{persistedSchedule.map((row) => <tr key={`${row.option_id}-${row.plan_id}`}><td><b>{row.field_id}</b><small>{row.plan_id} · {row.option_id}</small></td><td>{row.operation}</td><td>{row.target}</td><td>{row.machine_id}</td><td>{row.start_time}</td><td>{row.end_time}</td><td className="yc-right">{signedMoney(row.direct_cash_effect_aud)}</td></tr>)}</tbody></Table></>;
  const rows = view === 'fleet' ? yallambeeOpsDashboard.machines.map((machine) => [machine.id, machine.make, machine.oper ?? '—', machine.rate ? `${(machine.rate * (disrupted && machine.id === 'H2' ? 0.7 : 1)).toFixed(1)} ha/h` : '—', machine.health]) : view === 'people' ? yallambeeOpsDashboard.people.map((person) => [person.name, person.role, person.on, `${person.hours14} h`, person.fatigue]) : view === 'markets' ? yallambeeOpsDashboard.contracts.map((contract) => [contract.id, contract.buyer, contract.grade, `${contract.filled}/${contract.tonnes} t`, contract.due]) : yallambeeOpsDashboard.fields.map((field) => [field.name, field.prop, yallambeeOpsDashboard.crops[field.crop].label, `${field.moist}%`, field.ready]);
  const headings = view === 'fleet' ? ['Asset', 'Make', 'Operator', 'Rate', 'Health'] : view === 'people' ? ['Name', 'Role', 'On', '14-day hours', 'Fatigue'] : view === 'markets' ? ['Contract', 'Buyer', 'Grade', 'Filled', 'Due'] : ['Paddock', 'Property', 'Crop', 'Moisture', 'Ready'];
  return <><div className="yc-page-head"><div><h2>{titleByView[view]}</h2><p>Operational information connected to the same constraints used by the harvest plan.</p></div><div className="yc-actions"><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('harvest')}><Tractor size={15} /> See harvest impact</button></div></div><div className="yc-grid yc-grid-4"><StatCard label="Records" value={String(rows.length)} detail="Current synthetic operating dataset" /><StatCard label="Status" value={disrupted ? 'Changed' : 'Nominal'} detail={disrupted ? 'Reoptimisation required' : 'Tracking to plan'} tone={disrupted ? 'red' : 'green'} /><StatCard label="Coverage" value="100%" detail="Validated for this demo" meter={100} /><StatCard label="Updated" value="06:12" detail="Thu 4 Dec · harvest day 19" /></div><Table title="{titleByView[view]}"><thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}><b>{cellIndex === 0 ? cell : undefined}</b>{cellIndex !== 0 ? cell : undefined}</td>)}</tr>)}</tbody></Table></>;
}

function Table({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="yc-card yc-table-card"><header><h3>{title}</h3><span>Live synthetic data</span></header><div className="yc-table-wrap"><table>{children}</table></div></section>;
}

export default function YallambeeDashboard() {
  const [view, setView] = useState<ViewKey>('command');
  const [disrupted, setDisrupted] = useState(false);
  const plan = persistedPlan;
  const evaluated = persistedSummary.num_scheduled_actions;
  const improvement = 0;

  const reset = () => { setView('command'); setDisrupted(false); };
  return <div className="yc-shell"><DecisionAssistant /><aside className="yc-rail"><div className="yc-brand"><div><Warehouse size={21} /><h1>Yallambee Ops</h1></div><p>FarmOpti persisted output<br />schedule snapshot · pipeline result</p></div><nav className="yc-nav">{navGroups.map((group) => <div key={group.label}><span className="yc-nav-group">{group.label}</span>{group.items.map(({ id, label, icon: Icon, badge, tone }) => <button className={`yc-nav-link ${view === id ? 'yc-nav-active' : ''}`} key={id} onClick={() => setView(id)}><Icon size={16} /><span>{label}</span>{badge && <Badge tone={tone}>{badge}</Badge>}</button>)}</div>)}</nav><div className="yc-rail-foot">Persisted schedule<br /><b>{persistedSummary.num_scheduled_actions}</b> actions selected</div></aside><main className="yc-main"><header className="yc-top"><span>FarmOpti · <b>{titleByView[view]}</b></span><span className="yc-top-spacer" /><span><i className="yc-dot" /> Pipeline snapshot</span><span className="yc-divider" /><span>Status <b>{persistedSummary.status}</b></span><span className="yc-divider" /><span>Objective <b>{money(persistedSummary.total_objective_value_aud)}</b></span><span className="yc-divider" /><span><b>{persistedSchedule.length} schedule rows</b></span><button className="yc-icon-button" onClick={reset} aria-label="Reset dashboard" title="Reset dashboard"><RotateCcw size={15} /></button></header><div className="yc-page">{view === 'command' ? <CommandView plan={plan} evaluated={evaluated} improvement={improvement} onNavigate={setView} /> : <DetailView view={view} plan={plan} disrupted={false} onNavigate={setView} />}<footer className="yc-footer"><span>FarmOpti · persisted optimiser output</span><span>Source: optimization_summary.json + optimal_schedule.csv</span></footer></div></main></div>;
}

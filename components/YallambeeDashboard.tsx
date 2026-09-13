'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  Loader2,
  MessageCircle,
  PackageOpen,
  RotateCcw,
  Send,
  ShieldCheck,
  Tractor,
  Truck,
  Upload,
  Users,
  Warehouse,
  Wrench,
  X,
} from 'lucide-react';
import { yallambeeOpsDashboard } from '@/app/yallambee-ops';
import { dashboardPlanFrom, defaultResourcePlanId, managementPlanInputs, parseSchedule, persistedDashboardPlan, persistedDecisionIndex, persistedHighWindWindows, persistedRainWindows, persistedResourcePlans, persistedSchedule, persistedSummary, scheduleAnchorFrom, type ManagementPlanInput, type PersistedOptimizerSummary, type PersistedScheduleRow, type ResourcePlanOption, type WeatherWindow } from '@/lib/ui/persisted-optimizer-output';
import { whyReasonsForPlan } from '@/lib/ui/plan-reasons';
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

type OptimizerOutput = {
  summary: PersistedOptimizerSummary;
  schedule: PersistedScheduleRow[];
  plan: OptimiserCandidate;
  anchorTime: number;
  live: boolean;
  resourcePlans: ResourcePlanOption[];
  selectedPlanId: string;
  selectResourcePlan: (id: string) => void;
};

const initialOutput: OptimizerOutput = {
  summary: persistedSummary,
  schedule: persistedSchedule,
  plan: persistedDashboardPlan(),
  anchorTime: scheduleAnchorFrom(persistedSchedule),
  live: false,
  resourcePlans: persistedResourcePlans,
  selectedPlanId: defaultResourcePlanId,
  selectResourcePlan: () => undefined,
};

const OptimizerOutputContext = createContext<OptimizerOutput>(initialOutput);

function useOptimizerOutput() {
  return useContext(OptimizerOutputContext);
}

type CalibrationSummary = {
  training_rows: number;
  trained_models: string[];
  skipped_models: string[];
};

type TrainAndRunResponse = {
  error?: string;
  calibration?: CalibrationSummary;
  summary?: PersistedOptimizerSummary;
  scheduleCsv?: string;
};

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

function timelineClock(anchorTime: number, hour: number) {
  return new Date(anchorTime + hour * 3_600_000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

function timelineDay(anchorTime: number, hour: number, withYear = false) {
  return new Date(anchorTime + hour * 3_600_000).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
}

function timelineDateTime(anchorTime: number, hour: number) {
  return `${timelineDay(anchorTime, hour)}, ${timelineClock(anchorTime, hour)}`;
}

function midnightHoursFrom(anchorTime: number, totalHours: number) {
  const dayMs = 86_400_000;
  let midnight = Math.floor(anchorTime / dayMs) * dayMs;
  if (midnight <= anchorTime) midnight += dayMs;
  const hours: number[] = [];
  const end = anchorTime + totalHours * 3_600_000;
  while (midnight < end) {
    hours.push((midnight - anchorTime) / 3_600_000);
    midnight += dayMs;
  }
  return hours;
}

function weatherBoxes(windows: WeatherWindow[], anchorTime: number, totalHours: number) {
  return windows
    .map((window) => ({
      start: (window.start - anchorTime) / 3_600_000,
      end: (window.end - anchorTime) / 3_600_000,
    }))
    .filter((window) => window.end > 0 && window.start < totalHours)
    .map((window) => {
      const start = Math.max(0, window.start);
      const end = Math.min(totalHours, window.end);
      return { left: (start / totalHours) * 100, width: ((end - start) / totalHours) * 100 };
    });
}

function Timeline({ plan, disrupted, anchorTime: anchorOverride }: { plan: OptimiserCandidate; disrupted: boolean; anchorTime?: number }) {
  const { anchorTime: contextAnchor } = useOptimizerOutput();
  const anchorTime = anchorOverride ?? contextAnchor;
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
  let tickLabels = ticks.map((hour) => (useDayTicks ? timelineDay(anchorTime, hour) : timelineClock(anchorTime, hour)));
  // The final tick is clamped to totalHours, which can land on the same day
  // (or, at fine granularity, the same displayed time) as the tick before it.
  if (tickLabels.length > 1 && tickLabels.at(-1) === tickLabels.at(-2)) {
    ticks = ticks.slice(0, -1);
    tickLabels = tickLabels.slice(0, -1);
  }
  const midnightHours = midnightHoursFrom(anchorTime, totalHours);
  const rainBoxes = weatherBoxes(persistedRainWindows, anchorTime, totalHours);
  const windBoxes = weatherBoxes(persistedHighWindWindows, anchorTime, totalHours);

  return (
    <div className="yc-timeline">
      <div className="yc-timeline-toolbar">
        <span>Showing {isFullRange ? 'the full schedule' : TIMELINE_PRESETS.find((preset) => preset.hours === rangeHours)?.label}: {timelineDay(anchorTime, 0, true)} → {timelineDay(anchorTime, totalHours, true)}</span>
        <div className="yc-timeline-presets">
          {TIMELINE_PRESETS.map((preset) => <button type="button" key={preset.label} className={`yc-timeline-preset ${(preset.hours === null ? isFullRange : preset.hours === rangeHours) ? 'yc-timeline-preset-active' : ''}`} onClick={() => setRangeHours(preset.hours)}>{preset.label}</button>)}
        </div>
      </div>
      <div className="yc-timeline-scroll"><div className="yc-timeline-content">
        <div className="yc-timeline-hours" style={{ gridTemplateColumns: `repeat(${ticks.length}, 1fr)` }}>{tickLabels.map((label, index) => <span key={ticks[index]}>{label}</span>)}</div>
        <div className="yc-timeline-stage">
          {midnightHours.length > 0 && <div className="yc-day-lines" aria-hidden="true">{midnightHours.map((hour) => <i className="yc-day-line" key={hour} style={{ left: `${(hour / totalHours) * 100}%` }} />)}</div>}
          {disrupted && 17.1 <= totalHours && <div className="yc-rain-shade" style={{ left: `${(17.1 / totalHours) * 100}%` }}><b>FRONT 23:18 · 22 MM</b></div>}
          {rainBoxes.length > 0 && <div className="yc-weather-layer" aria-hidden="true">{rainBoxes.map((box, index) => <i className="yc-rain-box" key={`rain-${box.left}-${index}`} style={{ left: `${box.left}%`, width: `${box.width}%` }} />)}</div>}
          {windBoxes.length > 0 && <div className="yc-weather-layer" aria-hidden="true">{windBoxes.map((box, index) => <i className="yc-wind-box" key={`wind-${box.left}-${index}`} style={{ left: `${box.left}%`, width: `${box.width}%` }} />)}</div>}
          {rows.map((row) => {
            const blocks = plan.blocks.filter((block) => block.m === row && block.s < totalHours);
            return (
              <div className="yc-lane" key={row}>
                <span>{labels[row]}</span>
                <div className="yc-track">
                  {blocks.map((block, index) => <i className={`yc-block ${cropClass[block.crop]}`} key={`${row}-${index}`} style={{ left: `${(block.s / totalHours) * 100}%`, width: `${Math.min(100 - (block.s / totalHours) * 100, ((Math.min(totalHours, block.e) - block.s) / totalHours) * 100)}%` }} title={`${block.name} · ${timelineDateTime(anchorTime, block.s)} → ${timelineDateTime(anchorTime, block.e)}`}>{block.name}</i>)}
                  {!blocks.length && <i className="yc-block yc-idle" style={{ left: 0, width: '100%' }}>No assignment in this window</i>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="yc-legend"><span><i className="yc-legend-wheat" /> Wheat</span><span><i className="yc-legend-canola" /> Canola</span><span><i className="yc-legend-lentil" /> Lentils</span><span><i className="yc-legend-haul" /> Haulage</span><span><i className="yc-legend-rain" /> Rain</span><span><i className="yc-legend-wind" /> High wind</span></div>
      </div></div>
    </div>
  );
}

function ResourcePlanSection({ disrupted, showLegend = false }: { disrupted: boolean; showLegend?: boolean }) {
  const { live, resourcePlans, selectedPlanId, selectResourcePlan, plan, schedule, summary, anchorTime } = useOptimizerOutput();
  const selected = resourcePlans.find((item) => item.id === selectedPlanId) ?? resourcePlans[0];
  const displayPlan = selected?.dashboardPlan ?? plan;
  const displaySchedule = selected?.schedule ?? schedule;
  const displaySummary = selected?.summary ?? summary;
  const displayAnchor = selected?.anchorTime ?? anchorTime;

  return (
    <section className="yc-hero">
      <div className="yc-hero-head">
        <div>
          <h3>{live ? 'Updated resource plan' : 'Persisted resource plan'}</h3>
          <span>{selected ? `${selected.name} · ${displaySummary.num_scheduled_actions} actions / ${displaySchedule.length} work segments` : `${displayPlan.label} · ${displaySchedule.length} actions from the pipeline ${live ? 'run' : 'snapshot'}`}</span>
        </div>
        {showLegend && <div className="yc-hero-legend"><span><i className="yc-legend-wheat" /> Wheat</span><span><i className="yc-legend-canola" /> Other operations</span><span><i className="yc-legend-rain" /> Rain</span><span><i className="yc-legend-wind" /> High wind</span></div>}
      </div>
      {resourcePlans.length > 0 && (
        <div className="yc-plan-cards" role="radiogroup" aria-label="Resource plan options">
          {resourcePlans.map((item) => {
            const isSelected = item.id === (selected?.id ?? selectedPlanId);
            return (
              <button type="button" role="radio" aria-checked={isSelected} key={item.id} className={`yc-plan-card${isSelected ? ' yc-plan-card-selected' : ''}`} onClick={() => selectResourcePlan(item.id)}>
                {isSelected && <CheckCircle2 className="yc-plan-card-check" size={15} aria-hidden="true" />}
                <strong className="yc-plan-card-name">{item.name}</strong>
                <span className="yc-plan-card-explain">{item.explanation}</span>
                <div className="yc-plan-card-value">
                  <b>{money(item.netValueAud)}</b>
                  {item.optimalityPercent && <span className="yc-plan-card-ratio">{item.optimalityPercent}</span>}
                </div>
                <span className="yc-plan-card-value-label">Net financial value</span>
                <div className="yc-plan-card-foot">
                  <span className="yc-plan-card-benefit">{item.benefit}</span>
                  {item.diffLabel && <span className="yc-plan-card-diffs">{item.diffLabel}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <Timeline plan={displayPlan} disrupted={disrupted} anchorTime={displayAnchor} />
    </section>
  );
}

function WhyThisPlanPanel() {
  const { resourcePlans, selectedPlanId, schedule, summary } = useOptimizerOutput();
  const selected = resourcePlans.find((item) => item.id === selectedPlanId) ?? resourcePlans[0];
  const whyReasons = selected?.whyReasons ?? whyReasonsForPlan({
    summary: selected?.summary ?? summary,
    schedule: selected?.schedule ?? schedule,
    index: persistedDecisionIndex,
  });
  if (whyReasons.length === 0) return null;

  return (
    <section className="yc-card" aria-label="Why this plan">
      <header>
        <h3>Why this plan</h3>
      </header>
      <div className="yc-feed">
        {whyReasons.map((reason) => (
          <div className="yc-feed-item yc-feed-reason" key={reason.id}>
            <i className={`yc-severity yc-severity-${reason.tone}`} />
            <span>{reason.text}</span>
          </div>
        ))}
      </div>
    </section>
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

function HistoryUploadDialog({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied: (output: OptimizerOutput, calibration: CalibrationSummary) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!open) {
      setError('');
      setFileName('');
      setDragOver(false);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const upload = async (file: File) => {
    if (busy) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Upload a .csv file.');
      return;
    }
    setFileName(file.name);
    setError('');
    setBusy(true);
    try {
      const historyCsv = await file.text();
      const response = await fetch('/api/optimizer/train-and-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ historyCsv }),
      });
      const result = (await response.json()) as TrainAndRunResponse;
      if (!response.ok || !result.summary || !result.scheduleCsv || !result.calibration) {
        throw new Error(result.error ?? 'Training and optimisation did not return a new schedule.');
      }
      const schedule = parseSchedule(result.scheduleCsv);
      onApplied({
        summary: result.summary,
        schedule,
        plan: dashboardPlanFrom(result.summary, schedule),
        anchorTime: scheduleAnchorFrom(schedule),
        live: true,
        resourcePlans: persistedResourcePlans,
        selectedPlanId: defaultResourcePlanId,
        selectResourcePlan: () => undefined,
      }, result.calibration);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Training and optimisation failed.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const takeFile = (file?: File | null) => {
    if (file) void upload(file);
  };

  if (!open) return null;

  return (
    <div className="yc-modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <section className="yc-modal" role="dialog" aria-modal="true" aria-labelledby="yc-history-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h3 id="yc-history-title">Calibrate farm model</h3>
            <span>Use past operations to improve the next schedule</span>
          </div>
          <button className="yc-icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Close upload dialog"><X size={15} /></button>
        </header>
        <div className="yc-modal-body">
          <label
            className={`yc-dropzone${dragOver ? ' yc-dropzone-active' : ''}${busy ? ' yc-dropzone-busy' : ''}`}
            onDragOver={(event) => { event.preventDefault(); if (!busy) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => { event.preventDefault(); setDragOver(false); takeFile(event.dataTransfer.files[0]); }}
          >
            <input className="yc-file-input" ref={inputRef} type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => takeFile(event.target.files?.[0])} />
            {busy ? <Loader2 size={22} className="yc-spin" /> : <Upload size={22} />}
            <strong>{busy ? 'Calibrating farm model' : fileName || 'Drop a CSV here'}</strong>
            <small>{busy ? 'This can take a minute.' : 'or click to choose a file'}</small>
          </label>
          {error && <p className="yc-upload-status yc-upload-error">{error}</p>}
        </div>
        <div className="yc-modal-actions">
          <button className="yc-btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="yc-btn yc-btn-dark" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? <Loader2 size={15} className="yc-spin" /> : <Upload size={15} />}
            {busy ? 'Working…' : 'Choose file'}
          </button>
        </div>
      </section>
    </div>
  );
}

function CommandView({ evaluated, improvement, onNavigate, onOpenUpload, historyStatus }: { evaluated: number; improvement: number; onNavigate: (view: ViewKey) => void; onOpenUpload: () => void; historyStatus?: string }) {
  const { plan, summary, live } = useOptimizerOutput();
  const alerts = [
    { tone: 'warn' as Tone, title: 'Field readiness is limiting the candidate set', text: 'The optimizer only schedules fields that meet readiness and weather feasibility rules.', view: 'harvest' as ViewKey, when: 'Current' },
    { tone: 'info' as Tone, title: 'Resource capacity is binding', text: 'Machine, labour and destination capacity are included when candidates are scored.', view: 'harvest' as ViewKey, when: 'Current' },
  ].filter(Boolean) as { tone: Tone; title: string; text: string; view: ViewKey; when: string }[];

  return <>
    <div className="yc-page-head"><div><h2>Command</h2><p>Everything that could change today&apos;s plan, in one place. This view reflects the latest {live ? 'trained' : 'persisted'} pipeline result.</p></div><div className="yc-actions"><button className="yc-btn" type="button" onClick={onOpenUpload}><Upload size={15} /> Calibrate farm model</button><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('harvest')}><Tractor size={15} /> Open schedule</button></div></div>
    <ResourcePlanSection disrupted={false} showLegend />
    <WhyThisPlanPanel />
    <div className="yc-grid yc-grid-4"><StatCard label="Scheduled actions" value={String(summary.num_scheduled_actions)} detail={live ? 'Selected after history retraining' : 'Selected by the persisted optimizer'} meter={100} /><StatCard label="Direct cash effect" value={money(summary.total_direct_cash_effect_aud)} detail="Sum of optimal_schedule.csv" tone="blue" /><StatCard label="Terminal value" value={money(summary.total_terminal_value_aud)} detail="Value carried into the objective" tone="green" /><StatCard label="Objective value" value={money(summary.total_objective_value_aud)} detail={`Status: ${summary.status}`} meter={100} tone="amber" /></div>
    <div className="yc-grid yc-grid-main"><section className="yc-card"><header><h3>Needs a decision</h3><span>{alerts.length} total</span></header><div className="yc-feed">{alerts.map((alert) => <button className="yc-feed-item" key={alert.title} onClick={() => onNavigate(alert.view)}><i className={`yc-severity yc-severity-${alert.tone}`} /><span><b>{alert.title}</b><small>{alert.text}</small></span><time>{alert.when}</time></button>)}</div></section><section className="yc-card"><header><h3>Optimiser result</h3><span>{evaluated.toLocaleString('en-AU')} actions selected</span></header><div className="yc-card-body"><dl className="yc-kv"><dt>Selected strategy</dt><dd>{plan.label}</dd><dt>Route</dt><dd>{plan.haul > 25.5 ? 'Split route' : 'Receival route'}</dd><dt>Modelled cost</dt><dd>{money(Math.abs(plan.net))}</dd><dt>Improvement</dt><dd className={improvement > 0 ? 'yc-up' : ''}>{improvement > 0 ? '+' : ''}{money(improvement)}</dd></dl><p className="yc-result-note">These values come directly from the current optimiser run. Upload history.csv to retrain the simulator and refresh this plan.</p></div></section></div>
    <section className="yc-card yc-scope"><header><h3>Supported system scope</h3><Badge tone="ok">Connected</Badge></header><div className="yc-card-body"><p>The current system can optimise schedules, score economics, apply weather, machine, labour and field-state constraints, and explain recorded decisions.</p><button className="yc-btn" onClick={() => onNavigate('harvest')}>Open supported plan <ArrowRight size={15} /></button></div></section>
    <div className="yc-result-source"><CheckCircle2 size={15} /> {historyStatus || (live ? 'Displaying the schedule produced after the latest history.csv upload.' : 'Displaying the latest persisted pipeline result. Upload history.csv to retrain and refresh this snapshot.')}</div>
  </>;
}

function DetailView({ view, plan, disrupted, onNavigate, onOpenUpload, historyStatus }: { view: ViewKey; plan: OptimiserCandidate; disrupted: boolean; onNavigate: (view: ViewKey) => void; onOpenUpload: () => void; historyStatus?: string }) {
  const { schedule, live, resourcePlans, selectedPlanId } = useOptimizerOutput();
  const selectedResourcePlan = resourcePlans.find((item) => item.id === selectedPlanId) ?? resourcePlans[0];
  const harvestSchedule = selectedResourcePlan?.schedule ?? schedule;
  if (view === 'rules') return <><div className="yc-page-head"><div><h2>Farm rules & optimizer inputs</h2><p>Upload farm history to retrain calibration models and re-run the optimizer, or edit management-plan inputs for a later pipeline run.</p></div><div className="yc-actions"><button className="yc-btn" type="button" onClick={onOpenUpload}><Upload size={15} /> Calibrate farm model</button><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('command')}><Grid2X2 size={15} /> Back to command</button></div></div><section className="yc-card yc-input-panel"><header><div><h3>Farm history</h3><span>Retrain calibration models, then re-run the optimizer</span></div><Badge tone="info">Train & optimise</Badge></header><div className="yc-card-body"><p className="yc-upload-copy">Upload a history.csv to train farm-specific irrigation, fertiliser, spray and yield models, then re-run the optimizer with the new simulator.</p><div className="yc-input-actions"><span>{historyStatus || 'Choose a history.csv file to start training and optimisation.'}</span><button className="yc-btn yc-btn-dark" type="button" onClick={onOpenUpload}><Upload size={15} /> Calibrate farm model</button></div></div></section><OptimizerInputPanel /><Table title="Current management plan"><thead><tr><th>Plan</th><th>Field</th><th>Operation</th><th>Target</th><th>Window</th><th>Required</th></tr></thead><tbody>{managementPlanInputs.map((input) => <tr key={input.plan_id}><td><b>{input.plan_id}</b></td><td>{input.field_id}</td><td>{input.operation}</td><td>{input.target || '—'}</td><td>{input.allowed_from} to {input.allowed_to}</td><td><Badge tone={input.required ? 'ok' : 'mute'}>{input.required ? 'Required' : 'Optional'}</Badge></td></tr>)}</tbody></Table></>;
  if (view === 'harvest') return <><div className="yc-page-head"><div><h2>Harvest operations</h2><p>This view mirrors the {live ? 'latest trained' : 'persisted'} schedule generated by the optimizer pipeline.</p></div><div className="yc-actions"><button className="yc-btn" type="button" onClick={onOpenUpload}><Upload size={15} /> Calibrate farm model</button><button className="yc-btn yc-btn-primary" onClick={() => onNavigate('command')}>Back to command</button></div></div><ResourcePlanSection disrupted={disrupted} /><WhyThisPlanPanel /><Table title={live ? 'Updated schedule assignments' : 'Persisted schedule assignments'}><thead><tr><th>Field</th><th>Operation</th><th>Target</th><th>Machine</th><th>Work hours</th><th>Remaining</th><th>Start</th><th>End</th><th>Complete</th><th className="yc-right">Cash effect</th></tr></thead><tbody>{harvestSchedule.map((row) => <tr key={`${row.option_id}-${row.plan_id}-${row.start_time}`}><td><b>{row.field_id}</b><small>{row.plan_id} · {row.option_id}</small></td><td>{row.operation}</td><td>{row.target}</td><td>{row.machine_id}</td><td>{row.work_hours ?? '—'}</td><td>{row.remaining_workload_hours ?? '—'}</td><td>{row.start_time}</td><td>{row.end_time}</td><td>{row.completion_time ?? row.end_time}</td><td className="yc-right">{signedMoney(row.direct_cash_effect_aud)}</td></tr>)}</tbody></Table></>;
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
  const [output, setOutput] = useState<OptimizerOutput>(initialOutput);
  const [selectedPlanId, setSelectedPlanId] = useState(defaultResourcePlanId);
  const [historyStatus, setHistoryStatus] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const evaluated = output.summary.num_scheduled_actions;
  const improvement = 0;
  const outputValue = useMemo<OptimizerOutput>(() => ({
    ...output,
    selectedPlanId,
    selectResourcePlan: setSelectedPlanId,
  }), [output, selectedPlanId]);

  const applyHistoryRun = (next: OptimizerOutput, calibration: CalibrationSummary) => {
    setOutput(next);
    setSelectedPlanId(defaultResourcePlanId);
    setHistoryStatus(`Trained ${calibration.training_rows} events (${calibration.trained_models.join(', ') || 'no models'}). Optimiser selected ${next.summary.num_scheduled_actions} actions.`);
    setUploadOpen(false);
    setView('command');
  };

  const reset = () => { setView('command'); setDisrupted(false); setSelectedPlanId(defaultResourcePlanId); };
  return <OptimizerOutputContext.Provider value={outputValue}><div className="yc-shell"><HistoryUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onApplied={applyHistoryRun} /><DecisionAssistant /><aside className="yc-rail"><div className="yc-brand"><div><Warehouse size={21} /><h1>Yallambee Ops</h1></div><p>FarmOpti {output.live ? 'live output' : 'persisted output'}<br />{output.live ? 'retrained from history.csv' : 'schedule snapshot · pipeline result'}</p></div><nav className="yc-nav">{navGroups.map((group) => <div key={group.label}><span className="yc-nav-group">{group.label}</span>{group.items.map(({ id, label, icon: Icon, badge, tone }) => <button className={`yc-nav-link ${view === id ? 'yc-nav-active' : ''}`} key={id} onClick={() => setView(id)}><Icon size={16} /><span>{label}</span>{badge && <Badge tone={tone}>{badge}</Badge>}</button>)}</div>)}</nav><div className="yc-rail-foot">{output.live ? 'Updated schedule' : 'Persisted schedule'}<br /><b>{output.summary.num_scheduled_actions}</b> actions selected</div></aside><main className="yc-main"><header className="yc-top"><span>FarmOpti · <b>{titleByView[view]}</b></span><span className="yc-top-spacer" /><span><i className={output.live ? 'yc-dot yc-dot-amber' : 'yc-dot'} /> {output.live ? 'Live pipeline result' : 'Pipeline snapshot'}</span><span className="yc-divider" /><span>Status <b>{output.summary.status}</b></span><span className="yc-divider" /><span>Objective <b>{money(output.summary.total_objective_value_aud)}</b></span><span className="yc-divider" /><span><b>{output.schedule.length} schedule rows</b></span><button className="yc-icon-button" onClick={reset} aria-label="Reset dashboard" title="Reset dashboard"><RotateCcw size={15} /></button></header><div className="yc-page">{view === 'command' ? <CommandView evaluated={evaluated} improvement={improvement} onNavigate={setView} onOpenUpload={() => setUploadOpen(true)} historyStatus={historyStatus} /> : <DetailView view={view} plan={output.plan} disrupted={false} onNavigate={setView} onOpenUpload={() => setUploadOpen(true)} historyStatus={historyStatus} />}<footer className="yc-footer"><span>FarmOpti · {output.live ? 'live optimiser output' : 'persisted optimiser output'}</span><span>Source: {output.live ? 'latest history.csv training run' : 'optimization_summary.json + optimal_schedule.csv'}</span></footer></div></main></div></OptimizerOutputContext.Provider>;
}

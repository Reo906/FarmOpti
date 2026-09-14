'use client';

import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Bug,
  CheckCircle2,
  Home,
  HardHat,
  Leaf,
  Loader2,
  MessageCircle,
  PackageOpen,
  ChevronLeft,
  ChevronRight,
  Plus,
  Send,
  ShieldCheck,
  Tractor,
  Trash2,
  Truck,
  Upload,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { yallambeeOpsDashboard } from '@/app/yallambee-ops';
import { dashboardPlanFrom, defaultResourcePlanId, managementPlanInputs, parseSchedule, persistedDashboardPlan, persistedDecisionIndex, persistedHighWindWindows, persistedPlanChangeSummary, persistedRainWindows, persistedResourcePlans, persistedSchedule, persistedSummary, scheduleAnchorFrom, type ManagementPlanInput, type PersistedOptimizerSummary, type PersistedScheduleRow, type PlanChangeSummary, type ResourcePlanOption, type WeatherWindow } from '@/lib/ui/persisted-optimizer-output';
import { whyReasonsForPlan } from '@/lib/ui/plan-reasons';
import type { DashboardView, FarmField, HarvestBlock, OptimiserCandidate } from '@/app/yallambee-ops';

type ViewKey = DashboardView;
type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';

const navGroups: { label: string; items: { id: ViewKey; label: string; icon: typeof Home; badge?: string; tone?: Tone }[] }[] = [
  {
    label: 'Today',
    items: [
      { id: 'command', label: 'Home', icon: Home },
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

// Timeline blocks are colour-coded by operation (what's being done) rather
// than crop, since the same field goes through several operations across
// the schedule and the operation is what a machine/labour conflict hinges on.
const operationClass: Record<string, string> = {
  harvest: 'yc-op-harvest',
  plant: 'yc-op-plant',
  spray: 'yc-op-spray',
  fertilise: 'yc-op-fertilise',
  irrigate: 'yc-op-irrigate',
};

function capitalize(text: string): string {
  return text.length ? text[0].toUpperCase() + text.slice(1) : text;
}

type OptimizerOutput = {
  summary: PersistedOptimizerSummary;
  schedule: PersistedScheduleRow[];
  plan: OptimiserCandidate;
  anchorTime: number;
  live: boolean;
  changeSummary: PlanChangeSummary;
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
  changeSummary: persistedPlanChangeSummary,
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
  changeSummary?: PlanChangeSummary;
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

function StatCard({ label, value, unit, detail, meter, tone = 'green' }: { label: string; value: string; unit?: string; detail?: React.ReactNode; meter?: number; tone?: 'green' | 'amber' | 'red' | 'blue' }) {
  return (
    <article className="yc-card yc-stat">
      <span className="yc-kicker">{label}</span>
      <strong>{value} {unit && <small>{unit}</small>}</strong>
      {detail !== undefined && <span className="yc-detail">{detail}</span>}
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

// Hour 0 is scheduleAnchorTime, whatever time of day that happens to be (e.g.
// 08:00) -- but "1 day" should mean an actual calendar day, midnight to
// midnight, not an arbitrary 24h slice starting wherever the data begins.
// This finds the hour-offset of the midnight at or before the anchor, i.e.
// the true start of "day 1" (typically negative, since the anchor is usually
// partway through that day).
function calendarDayZeroHour(anchorTime: number): number {
  const anchor = new Date(anchorTime);
  const midnight = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return (midnight - anchorTime) / 3_600_000;
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
  const dayZeroHour = calendarDayZeroHour(anchorTime);
  const [rangeHours, setRangeHours] = useState<number | null>(null);
  const [pageIndex, setPageIndex] = useState(0);

  // The detail card can't just be an absolutely-positioned child of the
  // block: .yc-timeline-viewport is overflow-hidden so one page doesn't
  // bleed into the next, and that clips any descendant that extends past
  // its box -- cutting the card off for the bottom row. So on hover we
  // compute the block's position relative to the outer .yc-timeline (a
  // sibling of .yc-timeline-viewport, unclipped) and render the card there.
  const timelineRef = useRef<HTMLDivElement>(null);
  const [hoverDetail, setHoverDetail] = useState<{ block: HarvestBlock; left: number; top: number } | null>(null);

  const showDetail = (block: HarvestBlock, target: HTMLElement) => {
    const container = timelineRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const blockRect = target.getBoundingClientRect();
    const left = Math.min(Math.max(0, blockRect.left - containerRect.left), Math.max(0, containerRect.width - 200));
    const top = blockRect.bottom - containerRect.top + 8;
    setHoverDetail({ block, left, top });
  };

  // The preset is a zoom level -- how many hours fill one screen ("page") --
  // not a content filter. Pages are calendar-day-aligned (day 0 starts at
  // dayZeroHour, the midnight at/before the schedule's start) so "1 day"
  // is a real Wed-00:00-to-Thu-00:00, not an arbitrary 24h window. Like a
  // calendar app, only the current page renders; the buttons/swipe below
  // move one page at a time instead of free-scrolling a long strip.
  const isFullRange = rangeHours === null;
  const hoursPerFrame = rangeHours ?? fullHours;
  const totalPages = isFullRange ? 1 : Math.max(1, Math.ceil((fullHours - dayZeroHour) / hoursPerFrame));
  const page = Math.min(pageIndex, totalPages - 1);
  const viewStart = isFullRange ? 0 : dayZeroHour + page * hoursPerFrame;
  const viewEnd = viewStart + hoursPerFrame;

  // Direction drives which way the page slides in -- set right before the
  // page actually changes, then read once by the (re-keyed, so remounted)
  // content below to pick which slide-in animation to play.
  const [direction, setDirection] = useState<1 | -1>(1);
  const selectPreset = (hours: number | null) => {
    setRangeHours(hours);
    setPageIndex(0);
  };
  const goPrev = () => {
    setDirection(-1);
    setPageIndex((current) => Math.max(0, current - 1));
  };
  const goNext = () => {
    setDirection(1);
    setPageIndex((current) => Math.min(totalPages - 1, current + 1));
  };

  const rows = [...new Set(plan.blocks.map((block) => block.m))];
  const labels: Record<string, string> = Object.fromEntries(rows.map((row) => [row, row]));
  const operations = [...new Set(plan.blocks.map((block) => block.operation))].sort();

  // Once a page spans more than ~2 days, hourly ticks get too cramped to
  // read, so switch to one tick per day -- and past a week, even full date
  // labels ("Wed, 16 Sept") start overlapping each other, so space them
  // every 2 days instead of thinning gridlines along with them.
  const useDayTicks = hoursPerFrame > TIMELINE_DAY_TICK_THRESHOLD_HOURS;
  const tickStepHours = useDayTicks ? (hoursPerFrame > 168 ? 48 : 24) : 3;
  const tickCount = Math.max(1, Math.ceil(hoursPerFrame / tickStepHours));
  let ticks = Array.from({ length: tickCount + 1 }, (_, index) => Math.min(viewEnd, viewStart + index * tickStepHours));
  let tickLabels = ticks.map((hour) => (useDayTicks ? timelineDay(anchorTime, hour) : timelineClock(anchorTime, hour)));
  // The final tick is clamped to viewEnd, which can land on the same day
  // (or, at fine granularity, the same displayed time) as the tick before it.
  if (tickLabels.length > 1 && tickLabels.at(-1) === tickLabels.at(-2)) {
    ticks = ticks.slice(0, -1);
    tickLabels = tickLabels.slice(0, -1);
  }
  // A day-aligned page's last hour-of-day tick is midnight again -- label it
  // "24:00" so the axis reads as ending the day, not starting a new one.
  if (!useDayTicks && tickLabels.length > 0) tickLabels[tickLabels.length - 1] = '24:00';
  // Ticks mark points in time, not equal-width bands, so they're positioned
  // by real percentage (matching the gridlines and the blocks below exactly)
  // rather than divided into N even CSS-grid columns, which would bunch
  // every tick left of where its timestamp actually falls.
  const tickPct = (hour: number) => ((hour - viewStart) / hoursPerFrame) * 100;
  // Weather windows are absolute timestamps; weatherBoxes() positions them
  // relative to a given anchor over a given span, so shifting the anchor by
  // viewStart re-expresses them relative to the current page instead of the
  // whole schedule, matching how blocks are positioned below.
  const rainBoxes = weatherBoxes(persistedRainWindows, anchorTime + viewStart * 3_600_000, hoursPerFrame);
  const windBoxes = weatherBoxes(persistedHighWindWindows, anchorTime + viewStart * 3_600_000, hoursPerFrame);

  return (
    <div className="yc-timeline" ref={timelineRef}>
      <div className="yc-timeline-toolbar">
        <div className="yc-timeline-controls">
          <div className="yc-timeline-presets">
            {TIMELINE_PRESETS.map((preset) => <button type="button" key={preset.label} className={`yc-timeline-preset ${(preset.hours === null ? isFullRange : preset.hours === rangeHours) ? 'yc-timeline-preset-active' : ''}`} onClick={() => selectPreset(preset.hours)}>{preset.label}</button>)}
          </div>
          {!isFullRange && <span className="yc-timeline-range-label">{timelineDay(anchorTime, viewStart, true)} - {timelineDay(anchorTime, viewEnd, true)}</span>}
        </div>
      </div>
      <div className="yc-timeline-body">
        {!isFullRange && <button type="button" className="yc-timeline-nav-btn" onClick={goPrev} disabled={page === 0} aria-label="Previous"><ChevronLeft size={18} /></button>}
        <div className="yc-timeline-viewport"><div key={page} className={`yc-timeline-content ${direction > 0 ? 'yc-timeline-slide-next' : 'yc-timeline-slide-prev'}`}>
          <div className="yc-timeline-header-row"><span className="yc-timeline-machine-header">Machine</span><div className="yc-timeline-hours">{ticks.map((hour, index) => <span key={hour} className="yc-timeline-tick-label" style={{ left: `${tickPct(hour)}%`, transform: index === 0 ? 'translateX(0)' : index === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{tickLabels[index]}</span>)}</div></div>
          <div className="yc-timeline-stage">
            {/* Scoped to exactly the track column's width (past the 80px+8px
                machine-label gutter every .yc-lane reserves), so a gridline at
                tickPct(hour)% lands on the identical x as the tick label above
                it and any block edge at that same hour -- not shifted left by
                the gutter the way positioning this relative to the full row
                width would be. */}
            <div className="yc-timeline-gridlines">{ticks.map((hour) => <i key={hour} className="yc-timeline-gridline" style={{ left: `${tickPct(hour)}%` }} />)}</div>
            {rainBoxes.length > 0 && <div className="yc-weather-layer" aria-hidden="true">{rainBoxes.map((box, index) => <i className="yc-rain-box" key={`rain-${box.left}-${index}`} style={{ left: `${box.left}%`, width: `${box.width}%` }} />)}</div>}
            {windBoxes.length > 0 && <div className="yc-weather-layer" aria-hidden="true">{windBoxes.map((box, index) => <i className="yc-wind-box" key={`wind-${box.left}-${index}`} style={{ left: `${box.left}%`, width: `${box.width}%` }} />)}</div>}
            {disrupted && viewStart <= 17.1 && 17.1 <= viewEnd && <div className="yc-rain-shade" style={{ left: `${((17.1 - viewStart) / hoursPerFrame) * 100}%` }}><b>FRONT 23:18 · 22 MM</b></div>}
            {rows.map((row) => {
              const blocks = plan.blocks
                .filter((block) => block.m === row && block.s < viewEnd && block.e > viewStart)
                .map((block) => ({ ...block, s: Math.max(viewStart, block.s), e: Math.min(viewEnd, block.e) }));
              return (
                <div className="yc-lane" key={row}>
                  <span>{labels[row]}</span>
                  <div className="yc-track">
                    {blocks.map((block, index) => <i className={`yc-block ${operationClass[block.operation] ?? 'yc-op-other'}`} key={`${row}-${index}`} style={{ left: `${((block.s - viewStart) / hoursPerFrame) * 100}%`, width: `${((block.e - block.s) / hoursPerFrame) * 100}%` }} onMouseEnter={(event) => showDetail(block, event.currentTarget)} onMouseLeave={() => setHoverDetail(null)}>
                      <b>{block.name}</b> {capitalize(block.crop)}
                    </i>)}
                    {!blocks.length && <i className="yc-block yc-idle" style={{ left: 0, width: '100%' }}>No assignment</i>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="yc-legend">{operations.map((operation) => <span key={operation}><i className={operationClass[operation] ?? 'yc-op-other'} /> {capitalize(operation)}</span>)}<span><i className="yc-legend-rain" /> Rain</span><span><i className="yc-legend-wind" /> High wind</span></div>
        </div></div>
        {!isFullRange && <button type="button" className="yc-timeline-nav-btn" onClick={goNext} disabled={page >= totalPages - 1} aria-label="Next"><ChevronRight size={18} /></button>}
      </div>
      {hoverDetail && <div className="yc-block-detail" style={{ left: `${hoverDetail.left}px`, top: `${hoverDetail.top}px` }}>
        <strong>{hoverDetail.block.name} · {capitalize(hoverDetail.block.crop)}</strong>
        <span>{capitalize(hoverDetail.block.operation)} ({hoverDetail.block.target}) · {hoverDetail.block.m}</span>
        <span>{timelineDateTime(anchorTime, hoverDetail.block.s)} → {timelineDateTime(anchorTime, hoverDetail.block.e)}</span>
        <span>{hoverDetail.block.workers} worker{hoverDetail.block.workers === 1 ? '' : 's'} · {signedMoney(hoverDetail.block.cashEffect)} direct cash effect</span>
        <span>{hoverDetail.block.planId}</span>
      </div>}
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
          <h3>{live ? 'Resource plan' : 'Resource plan'}</h3>
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
                {/* <span className="yc-plan-card-value-label">Net financial value</span> */}
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

function PlanRationalePanel() {
  const { resourcePlans, selectedPlanId, schedule, summary } = useOptimizerOutput();
  const selected = resourcePlans.find((item) => item.id === selectedPlanId) ?? resourcePlans[0];
  const whyReasons = selected?.whyReasons ?? whyReasonsForPlan({
    summary: selected?.summary ?? summary,
    schedule: selected?.schedule ?? schedule,
    index: persistedDecisionIndex,
  });
  if (whyReasons.length === 0) return null;

  return (
    <section className="yc-card" aria-label="Plan rationale">
      <header>
        <h3>Plan rationale</h3>
        <span>Evidence behind the selected resource plan</span>
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

interface ChatMessage {
  role: 'assistant' | 'user';
  text: string;
  proposal?: unknown;
  proposalStatus?: 'pending' | 'applied' | 'discarded';
}

function DecisionAssistant() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
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
      const result = (await response.json()) as { answer?: string; error?: string; needsConfirmation?: boolean; proposal?: unknown };
      if (!response.ok) {
        setMessages((current) => [...current, { role: 'assistant', text: result.error ?? 'The assistant could not answer that.' }]);
      } else {
        setMessages((current) => [
          ...current,
          {
            role: 'assistant',
            text: result.answer ?? 'No answer returned.',
            proposal: result.needsConfirmation ? result.proposal : undefined,
            proposalStatus: result.needsConfirmation ? 'pending' : undefined,
          },
        ]);
      }
    } catch {
      setMessages((current) => [...current, { role: 'assistant', text: 'The decision assistant could not be reached. Check that the optimizer evidence outputs exist and the configured model is available.' }]);
    } finally {
      setBusy(false);
    }
  };

  const respondToProposal = async (index: number, approve: boolean) => {
    const message = messages[index];
    if (!message?.proposal || busy) return;

    if (!approve) {
      setMessages((current) => current.map((m, i) => (i === index ? { ...m, proposalStatus: 'discarded' } : m)));
      setMessages((current) => [...current, { role: 'assistant', text: 'Discarded -- no changes made.' }]);
      return;
    }

    setMessages((current) => current.map((m, i) => (i === index ? { ...m, proposalStatus: 'applied' } : m)));
    setBusy(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal: message.proposal }),
      });
      const result = (await response.json()) as { answer?: string; error?: string };
      setMessages((current) => [...current, { role: 'assistant', text: response.ok ? result.answer ?? 'Applied.' : result.error ?? 'Could not apply that change.' }]);
    } catch {
      setMessages((current) => [...current, { role: 'assistant', text: 'Could not reach the optimizer to apply that change.' }]);
    } finally {
      setBusy(false);
    }
  };

  return <div className="yc-chat-widget">
    {open && <section className="yc-card yc-chat-popup" aria-label="Decision assistant">
      <header>
        <div><h3>Decision assistant</h3></div>
        <Badge tone="info">FarmOpti</Badge>
        <button className="yc-icon-button yc-chat-close" onClick={() => setOpen(false)} aria-label="Close decision assistant"><X size={15} /></button>
      </header>
      <div className="yc-chat-log" ref={logRef}>
        {messages.map((message, index) => <Fragment key={`${message.role}-${index}`}>
          <p className={`yc-chat-bubble yc-chat-${message.role}`}>{message.text}</p>
          {message.proposalStatus === 'pending' && <div className="yc-chat-confirm">
            <button className="yc-btn yc-btn-dark" onClick={() => respondToProposal(index, true)} disabled={busy}>Yes, apply it</button>
            <button className="yc-btn" onClick={() => respondToProposal(index, false)} disabled={busy}>No</button>
          </div>}
        </Fragment>)}
        {busy && <p className="yc-chat-bubble yc-chat-assistant yc-chat-pending">Reviewing optimisation evidence...</p>}
      </div>
      <div className="yc-chat-suggestions">
        <button onClick={() => ask('Explain a current optimised schedule')}>Explain a current optimised schedule</button>
        <button onClick={() => ask('I want to make a change in the plan')}>I want to make a change in the plan</button>
      </div>
      <form className="yc-chat-form" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about a decision or scenario..." aria-label="Ask the decision assistant" />
        <button className="yc-btn yc-btn-dark" disabled={busy || !question.trim()} aria-label="Send question"><Send size={15} /></button>
      </form>
    </section>}
    <button className={`yc-chat-fab ${open ? 'yc-chat-fab-open' : ''}`} onClick={() => setOpen((current) => !current)} aria-label={open ? 'Close decision assistant' : 'Open decision assistant'} aria-expanded={open}>
      {open ? <X size={20} /> : <><MessageCircle size={20} /><span>Ask FarmOpti</span></>}
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
        changeSummary: result.changeSummary ?? initialOutput.changeSummary,
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
  const { summary, live, changeSummary } = useOptimizerOutput();
  return <>
    <div className="yc-page-head"><div><h2>Home</h2></div><div className="yc-actions"><button className="yc-btn" type="button" onClick={onOpenUpload}><Upload size={15} /> Calibrate farm model</button></div></div>
    <ResourcePlanSection disrupted={false} showLegend />
    <PlanRationalePanel />
    <div className="yc-grid yc-grid-4"><StatCard label="Upcoming jobs" value={String(summary.num_scheduled_actions)} detail={live ? 'Selected after history retraining' : 'Selected by the persisted optimizer'} /><StatCard label="Total cash effect" value={money(summary.total_direct_cash_effect_aud)} /><StatCard label="Future crop value" value={money(summary.total_terminal_value_aud)} /><StatCard label="Total farm value" value={money(summary.total_objective_value_aud)} detail={`Status: ${summary.status}`} /></div>
    <div className="yc-result-source"><CheckCircle2 size={15} /> {historyStatus || (live ? 'Displaying the schedule produced after the latest history.csv upload.' : 'Displaying the latest persisted pipeline result. Upload history.csv to retrain and refresh this snapshot.')}</div>
    <div className="yc-grid yc-grid-2">
      <section className="yc-card yc-change-card"><header><div><h3>What changed</h3><span>{changeSummary.narrative}</span></div><Badge tone="info"><BarChart3 size={13} /> {changeSummary.change_bullets.length}</Badge></header><div className="yc-card-body">{changeSummary.change_bullets.length === 0 ? <p className="yc-empty-note">No changes yet -- this is the current optimizer output. Add a farm rule or retrain from history to see what moves.</p> : <ul className="yc-bullet-list">{changeSummary.change_bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul>}</div></section>
      <section className="yc-card yc-change-card"><header><div><h3>Why this plan</h3><span>Reasons this optimised approach is worth keeping</span></div><Badge tone="ok"><ShieldCheck size={13} /> {changeSummary.positive_bullets.length}</Badge></header><div className="yc-card-body"><ul className="yc-bullet-list yc-bullet-list-positive">{changeSummary.positive_bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul></div></section>
    </div>
  </>;
}

interface RuleTrigger {
  variable: 'rain_mm' | 'wind_kmh' | 'temperature_c';
  op: 'gt' | 'gte' | 'lt' | 'lte';
  value: number;
}

interface FarmRule {
  id: string;
  description: string;
  resource: string;
  field_id: string;
  operation: string;
  trigger: RuleTrigger | null;
  window_hours: number;
  created_at: string;
}

const TRIGGER_OP_LABEL: Record<RuleTrigger['op'], string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };
const TRIGGER_VARIABLE_LABEL: Record<RuleTrigger['variable'], string> = { rain_mm: 'rainfall (mm)', wind_kmh: 'wind (km/h)', temperature_c: 'temperature (°C)' };

function describeRuleScope(rule: Pick<FarmRule, 'resource' | 'field_id' | 'operation'>): string {
  return [
    rule.resource === 'any' ? 'any machine' : rule.resource,
    rule.operation === 'any' ? 'any operation' : rule.operation,
    rule.field_id === 'any' ? 'any field' : rule.field_id,
  ].join(' · ');
}

function describeRuleCondition(rule: Pick<FarmRule, 'trigger' | 'window_hours'>): string {
  if (!rule.trigger) return 'always prohibited';
  return `prohibited within ${rule.window_hours}h of ${TRIGGER_VARIABLE_LABEL[rule.trigger.variable]} ${TRIGGER_OP_LABEL[rule.trigger.op]} ${rule.trigger.value}`;
}

function ConfirmModal({ title, body, confirmLabel, busy, onConfirm, onCancel }: { title: string; body: string; confirmLabel: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div className="yc-modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <div className="yc-modal">
      <header><AlertTriangle size={18} /><h3>{title}</h3></header>
      <p className="yc-modal-body">{body}</p>
      <div className="yc-modal-actions">
        <button className="yc-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="yc-btn yc-btn-dark" onClick={onConfirm} disabled={busy}>{busy ? 'Applying...' : confirmLabel}</button>
      </div>
    </div>
  </div>;
}

function FarmRulesPanel({ onOutputChange }: { onOutputChange: (next: OptimizerOutput) => void }) {
  // Guards against a stale poll loop (from a confirm that's still generating
  // its LLM narration) applying its result after a newer confirm has already
  // superseded it -- which would pair an old narration with the wrong
  // schedule/summary. Each confirmPending() call claims the next value here
  // and a poll only applies its result while it still holds the latest one.
  const confirmGenerationRef = useRef(0);
  const [rules, setRules] = useState<FarmRule[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [machines, setMachines] = useState<{ id: string; type: string }[]>([]);
  const [operations, setOperations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resultBanner, setResultBanner] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  // Rule changes don't regenerate resourcePlans (alternative_plans.json isn't
  // refetched here), so the fast/live output below just carries the current
  // selection through unchanged rather than resetting it.
  const { resourcePlans, selectedPlanId, selectResourcePlan } = useOptimizerOutput();

  const [description, setDescription] = useState('');
  const [resource, setResource] = useState('any');
  const [fieldId, setFieldId] = useState('any');
  const [operation, setOperation] = useState('any');
  const [conditional, setConditional] = useState(false);
  const [variable, setVariable] = useState<RuleTrigger['variable']>('rain_mm');
  const [op, setOp] = useState<RuleTrigger['op']>('gt');
  const [value, setValue] = useState('15');
  const [windowHours, setWindowHours] = useState('24');

  const [pending, setPending] = useState<{ kind: 'add' | 'remove'; proposal: unknown; summary: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch('/api/rules');
      const body = (await response.json()) as { rules?: FarmRule[]; fields?: string[]; machines?: { id: string; type: string }[]; operations?: string[]; error?: string };
      if (!response.ok) {
        setLoadError(body.error ?? 'Could not load farm rules.');
        return;
      }
      setRules(body.rules ?? []);
      setFields(body.fields ?? []);
      setMachines(body.machines ?? []);
      setOperations(body.operations ?? []);
    } catch {
      setLoadError("Could not reach the local optimizer helper. Start it with `npm run optimizer:server`.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const startAdd = () => {
    if (!description.trim()) return;
    const rule = {
      description: description.trim(),
      resource,
      field_id: fieldId,
      operation,
      trigger: conditional ? { variable, op, value: Number(value) } : null,
      window_hours: conditional ? Number(windowHours) : 0,
    };
    const proposal = { kind: 'rule_change', description: rule.description, action: 'add', rule };
    setPending({ kind: 'add', proposal, summary: `${describeRuleScope(rule)} — ${describeRuleCondition(rule)}` });
  };

  const startRemove = (rule: FarmRule) => {
    const proposal = { kind: 'rule_change', description: `Remove rule ${rule.id}`, action: 'remove', rule };
    setPending({ kind: 'remove', proposal, summary: `${rule.id}: ${rule.description}` });
  };

  // confirmPending already showed the fast, deterministic plan-change
  // summary -- the nicer LLM-phrased version takes several more seconds to
  // generate in the background on the sidecar, so poll briefly for it and
  // swap it in once it lands, rather than making the confirm action itself
  // wait on the LLM call.
  const pollForNarratedSummary = (baseOutput: OptimizerOutput, generation: number, attempt = 0) => {
    // Ollama serialises requests, so if the user confirms another change
    // while this one's narration is still generating, this poll can end up
    // waiting behind that one too -- 20 attempts at 2s comfortably covers
    // that worst case (observed up to ~30s for a second queued call).
    if (attempt >= 20 || confirmGenerationRef.current !== generation) return;
    setTimeout(async () => {
      if (confirmGenerationRef.current !== generation) return; // a newer confirm has since started; this result would no longer match the displayed plan
      try {
        const response = await fetch('/api/plan-change-summary');
        if (response.ok) {
          const summary = (await response.json()) as PlanChangeSummary;
          if (summary.source === 'llm' && summary.generated_at !== baseOutput.changeSummary.generated_at && confirmGenerationRef.current === generation) {
            onOutputChange({ ...baseOutput, changeSummary: summary });
            return;
          }
        }
      } catch {
        // ignore and retry -- this is a background enhancement, not required for the confirm action to succeed
      }
      pollForNarratedSummary(baseOutput, generation, attempt + 1);
    }, 2000);
  };

  const confirmPending = async () => {
    if (!pending) return;
    const generation = ++confirmGenerationRef.current;
    setBusy(true);
    setResultBanner(null);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal: pending.proposal }),
      });
      const result = (await response.json()) as { answer?: string; error?: string; summary?: PersistedOptimizerSummary; scheduleCsv?: string; changeSummary?: PlanChangeSummary };
      if (!response.ok) {
        setResultBanner({ tone: 'warn', text: result.error ?? 'Could not apply that change.' });
      } else {
        setResultBanner({ tone: 'ok', text: result.answer ?? 'Applied.' });
        setDescription('');
        await load();
        if (result.summary && result.scheduleCsv && confirmGenerationRef.current === generation) {
          const schedule = parseSchedule(result.scheduleCsv);
          const fastOutput: OptimizerOutput = {
            summary: result.summary,
            schedule,
            plan: dashboardPlanFrom(result.summary, schedule),
            anchorTime: scheduleAnchorFrom(schedule),
            live: true,
            changeSummary: result.changeSummary ?? initialOutput.changeSummary,
            resourcePlans,
            selectedPlanId,
            selectResourcePlan,
          };
          onOutputChange(fastOutput);
          pollForNarratedSummary(fastOutput, generation);
        }
      }
    } catch {
      setResultBanner({ tone: 'warn', text: 'Could not reach the local optimizer helper.' });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return <section className="yc-card yc-rules-panel">
    <header><div><h3>Farm rules</h3><span>Hard scheduling exclusions the optimizer must respect</span></div><Badge tone="info">{rules.length} active</Badge></header>
    <div className="yc-card-body">
      {loadError && <p className="yc-rules-error">{loadError} <button className="yc-btn" onClick={() => void load()}>Retry</button></p>}
      {resultBanner && <p className={`yc-rules-banner yc-rules-banner-${resultBanner.tone}`}>{resultBanner.text}</p>}
      {loading ? <p>Loading rules...</p> : <ul className="yc-rules-list">
        {rules.length === 0 && <li className="yc-rules-empty">No rules yet.</li>}
        {rules.map((rule) => <li key={rule.id}>
          <div><b>{rule.id}</b> — {rule.description}<small>{describeRuleScope(rule)} · {describeRuleCondition(rule)}</small></div>
          <button className="yc-icon-button" onClick={() => startRemove(rule)} aria-label={`Remove ${rule.id}`}><Trash2 size={15} /></button>
        </li>)}
      </ul>}

      <div className="yc-rules-form">
        <h4>Add a rule</h4>
        <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="e.g. Never spray F3 within 24h of heavy rain" /></label>
        <div className="yc-rules-form-grid">
          <label>Machine<select value={resource} onChange={(event) => setResource(event.target.value)}><option value="any">Any machine</option>{machines.map((m) => <option key={m.id} value={m.id}>{m.id} ({m.type})</option>)}</select></label>
          <label>Field<select value={fieldId} onChange={(event) => setFieldId(event.target.value)}><option value="any">Any field</option>{fields.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
          <label>Operation<select value={operation} onChange={(event) => setOperation(event.target.value)}><option value="any">Any operation</option>{operations.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
        </div>
        <label className="yc-check"><input type="checkbox" checked={conditional} onChange={(event) => setConditional(event.target.checked)} /> Only when a weather condition holds</label>
        {conditional && <div className="yc-rules-form-grid">
          <label>Variable<select value={variable} onChange={(event) => setVariable(event.target.value as RuleTrigger['variable'])}><option value="rain_mm">Rainfall (mm)</option><option value="wind_kmh">Wind (km/h)</option><option value="temperature_c">Temperature (°C)</option></select></label>
          <label>Comparison<select value={op} onChange={(event) => setOp(event.target.value as RuleTrigger['op'])}><option value="gt">greater than</option><option value="gte">at least</option><option value="lt">less than</option><option value="lte">at most</option></select></label>
          <label>Value<input type="number" value={value} onChange={(event) => setValue(event.target.value)} /></label>
          <label>Window (hours)<input type="number" value={windowHours} onChange={(event) => setWindowHours(event.target.value)} /></label>
        </div>}
        <button className="yc-btn yc-btn-dark" onClick={startAdd} disabled={!description.trim()}><Plus size={15} /> Propose rule</button>
      </div>
    </div>

    {pending && <ConfirmModal
      title={pending.kind === 'add' ? 'Add this farm rule?' : 'Remove this farm rule?'}
      body={`${pending.summary}\n\nThis will persist and the optimizer will re-run immediately.`}
      confirmLabel={pending.kind === 'add' ? 'Yes, add it' : 'Yes, remove it'}
      busy={busy}
      onConfirm={() => void confirmPending()}
      onCancel={() => setPending(null)}
    />}
  </section>;
}

function DetailView({ view, disrupted, onNavigate, onOutputChange }: { view: ViewKey; disrupted: boolean; onNavigate: (view: ViewKey) => void; onOutputChange: (next: OptimizerOutput) => void }) {
  const { summary, schedule, live, resourcePlans, selectedPlanId } = useOptimizerOutput();
  const selectedResourcePlan = resourcePlans.find((item) => item.id === selectedPlanId) ?? resourcePlans[0];
  const harvestSchedule = selectedResourcePlan?.schedule ?? schedule;
  const harvestSummary = selectedResourcePlan?.summary ?? summary;
  if (view === 'rules') return <><div className="yc-page-head"><div><h2>Farm rules</h2><p>Add or remove hard scheduling rules the optimizer enforces live. The management plan editor below is a draft tool for preparing a replacement CSV -- it doesn't feed the running optimizer directly.</p></div><div className="yc-actions"><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('command')}><Home size={15} /> Back to command</button></div></div><FarmRulesPanel onOutputChange={onOutputChange} /><OptimizerInputPanel /><Table title="Current management plan"><thead><tr><th>Plan</th><th>Field</th><th>Operation</th><th>Target</th><th>Window</th><th>Required</th></tr></thead><tbody>{managementPlanInputs.map((input) => <tr key={input.plan_id}><td><b>{input.plan_id}</b></td><td>{input.field_id}</td><td>{input.operation}</td><td>{input.target || '—'}</td><td>{input.allowed_from} to {input.allowed_to}</td><td><Badge tone={input.required ? 'ok' : 'mute'}>{input.required ? 'Required' : 'Optional'}</Badge></td></tr>)}</tbody></Table></>;
  if (view === 'harvest') return <><div className="yc-page-head"><div><h2>Harvest operations</h2><p>This view mirrors the {live ? 'latest trained' : 'persisted'} schedule generated by the optimizer pipeline.</p><span className="yc-detail">{harvestSummary.num_scheduled_actions} actions / {harvestSchedule.length} work segments · source: optimal_schedule.csv</span></div><div className="yc-actions"><button className="yc-btn yc-btn-primary" onClick={() => onNavigate('command')}>Back to command</button></div></div><Table title={live ? 'Updated schedule assignments' : 'Persisted schedule assignments'}><thead><tr><th>Field</th><th>Operation</th><th>Target</th><th>Machine</th><th>Work hours</th><th>Remaining</th><th>Start</th><th>End</th><th>Complete</th><th className="yc-right">Cash effect</th></tr></thead><tbody>{harvestSchedule.map((row) => <tr key={`${row.option_id}-${row.plan_id}-${row.start_time}`}><td><b>{row.field_id}</b><small>{row.plan_id} · {row.option_id}</small></td><td>{row.operation}</td><td>{row.target}</td><td>{row.machine_id}</td><td>{row.work_hours ?? '—'}</td><td>{row.remaining_workload_hours ?? '—'}</td><td>{row.start_time}</td><td>{row.end_time}</td><td>{row.completion_time ?? row.end_time}</td><td className="yc-right">{signedMoney(row.direct_cash_effect_aud)}</td></tr>)}</tbody></Table></>;
  const rows = view === 'fleet' ? yallambeeOpsDashboard.machines.map((machine) => [machine.id, machine.make, machine.oper ?? '—', machine.rate ? `${(machine.rate * (disrupted && machine.id === 'H2' ? 0.7 : 1)).toFixed(1)} ha/h` : '—', machine.health]) : view === 'people' ? yallambeeOpsDashboard.people.map((person) => [person.name, person.role, person.on, `${person.hours14} h`, person.fatigue]) : view === 'markets' ? yallambeeOpsDashboard.contracts.map((contract) => [contract.id, contract.buyer, contract.grade, `${contract.filled}/${contract.tonnes} t`, contract.due]) : yallambeeOpsDashboard.fields.map((field) => [field.name, field.prop, yallambeeOpsDashboard.crops[field.crop].label, `${field.moist}%`, field.ready]);
  const headings = view === 'fleet' ? ['Asset', 'Make', 'Operator', 'Rate', 'Health'] : view === 'people' ? ['Name', 'Role', 'On', '14-day hours', 'Fatigue'] : view === 'markets' ? ['Contract', 'Buyer', 'Grade', 'Filled', 'Due'] : ['Paddock', 'Property', 'Crop', 'Moisture', 'Ready'];
  return <><div className="yc-page-head"><div><h2>{titleByView[view]}</h2><p>Operational information connected to the same constraints used by the harvest plan.</p></div><div className="yc-actions"><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('harvest')}><Tractor size={15} /> See harvest impact</button></div></div><div className="yc-grid yc-grid-4"><StatCard label="Records" value={String(rows.length)} detail="Current synthetic operating dataset" /><StatCard label="Status" value={disrupted ? 'Changed' : 'Nominal'} detail={disrupted ? 'Reoptimisation required' : 'Tracking to plan'} tone={disrupted ? 'red' : 'green'} /><StatCard label="Coverage" value="100%" detail="Validated for this demo" meter={100} /><StatCard label="Updated" value="06:12" detail="Thu 4 Dec · harvest day 19" /></div><Table title="{titleByView[view]}"><thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}><b>{cellIndex === 0 ? cell : undefined}</b>{cellIndex !== 0 ? cell : undefined}</td>)}</tr>)}</tbody></Table></>;
}

function Table({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="yc-card yc-table-card"><header><h3>{title}</h3>
  {/* <span>Live synthetic data</span> */}
  </header><div className="yc-table-wrap"><table>{children}</table></div></section>;
}

export default function YallambeeDashboard() {
  const [view, setView] = useState<ViewKey>('command');
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

  return <OptimizerOutputContext.Provider value={outputValue}><div className="yc-shell"><HistoryUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onApplied={applyHistoryRun} /><DecisionAssistant /><aside className="yc-rail"><div className="yc-brand"><div><img className="yc-brand-logo" src="/farmOpti.png" alt="FarmOpti logo" width={22} height={22} /><h1>FarmOpti</h1></div></div><nav className="yc-nav">{navGroups.map((group) => <div key={group.label}><span className="yc-nav-group">{group.label}</span>{group.items.map(({ id, label, icon: Icon, badge, tone }) => <button className={`yc-nav-link ${view === id ? 'yc-nav-active' : ''}`} key={id} onClick={() => setView(id)}><Icon size={16} /><span>{label}</span>{badge && <Badge tone={tone}>{badge}</Badge>}</button>)}</div>)}</nav></aside><main className="yc-main"><div className="yc-page">{view === 'command' ? <CommandView evaluated={evaluated} improvement={improvement} onNavigate={setView} onOpenUpload={() => setUploadOpen(true)} historyStatus={historyStatus} /> : <DetailView view={view} disrupted={false} onNavigate={setView} onOutputChange={setOutput} />}</div></main></div></OptimizerOutputContext.Provider>;
}

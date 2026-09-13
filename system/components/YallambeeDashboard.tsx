'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Bug,
  CheckCircle2,
  CloudRain,
  Grid2X2,
  HardHat,
  Leaf,
  Mic,
  MicOff,
  PackageOpen,
  RotateCcw,
  Send,
  ShieldCheck,
  Tractor,
  Truck,
  Users,
  Warehouse,
  Wrench,
} from 'lucide-react';
import { yallambeeOpsDashboard } from '@/app/yallambee-ops';
import type { DashboardView, FarmField, OptimiserCandidate } from '@/app/yallambee-ops';
import { ConfirmedConstraintsPanel } from '@/components/ConfirmedConstraintsPanel';

type ViewKey = DashboardView;
type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';

const navGroups: { label: string; items: { id: ViewKey; label: string; icon: typeof Grid2X2; badge?: string; tone?: Tone }[] }[] = [
  {
    label: 'Today',
    items: [
      { id: 'command', label: 'Command', icon: Grid2X2 },
      { id: 'harvest', label: 'Harvest operations', icon: Tractor, badge: 'LIVE', tone: 'mute' },
      { id: 'rules', label: 'Farm rules', icon: BookOpen, badge: '3', tone: 'mute' },
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

function money(value: number) {
  return `A$${Math.abs(Math.round(value)).toLocaleString('en-AU')}`;
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

function Timeline({ plan, disrupted }: { plan: OptimiserCandidate; disrupted: boolean }) {
  const span = 18;
  const rows = ['H1', 'H2', ...(plan.contractor ? ['C1'] : []), 'T1', 'T2', 'T3'];
  const labels: Record<string, string> = { H1: 'H1 header', H2: 'H2 header', C1: 'Delaney', T1: 'Truck T1', T2: 'Truck T2', T3: 'Truck T3' };
  return (
    <div className="yc-timeline">
      <div className="yc-timeline-hours">{[6, 8, 10, 12, 14, 16, 18, 20, 22].map((hour) => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}</div>
      <div className="yc-timeline-stage">
        {disrupted && <div className="yc-rain-shade" style={{ left: `${Math.min(100, (17.1 / span) * 100)}%` }}><b>FRONT 23:18 · 22 MM</b></div>}
        {rows.map((row) => {
          const blocks = row === 'H1' || row === 'H2' || row === 'C1' ? plan.blocks.filter((block) => block.m === row) : [];
          return (
            <div className="yc-lane" key={row}>
              <span>{labels[row]}</span>
              <div className="yc-track">
                {blocks.map((block, index) => <i className={`yc-block ${cropClass[block.crop]}`} key={`${row}-${index}`} style={{ left: `${(block.s / span) * 100}%`, width: `${Math.max(3, ((Math.min(span, block.e) - block.s) / span) * 100)}%` }}>{block.name}</i>)}
                {row === 'H2' && disrupted && !blocks.length && <i className="yc-block yc-idle" style={{ left: 0, width: '100%' }}>Restricted state</i>}
                {row.startsWith('T') && <i className={`yc-block yc-haul ${row === 'T3' && plan.haul <= 25.5 ? 'yc-idle' : ''}`} style={{ left: '7%', width: row === 'T3' && plan.haul <= 25.5 ? '88%' : '40%' }}>{row === 'T3' && plan.haul <= 25.5 ? 'Yard · no driver' : 'Murtoa haulage'}</i>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="yc-legend"><span><i className="yc-legend-wheat" /> Wheat</span><span><i className="yc-legend-canola" /> Canola</span><span><i className="yc-legend-lentil" /> Lentils</span><span><i className="yc-legend-haul" /> Haulage</span></div>
    </div>
  );
}

type MicState = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';

interface PendingProposal {
  proposalId: string;
  sourceText: string;
  sessionId: string;
}

function DecisionAssistant() {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<{ role: 'assistant' | 'user'; text: string }[]>([
    { role: 'assistant', text: 'Ask why a schedule decision was made, what evidence supports it, or propose a constraint by voice or text.' },
  ]);
  const [busy, setBusy] = useState(false);
  const [micState, setMicState] = useState<MicState>('idle');
  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(null);
  const sessionId = useRef(crypto.randomUUID());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const askViaVoice = useCallback(async (transcript: string) => {
    if (!transcript.trim() || busy) return;
    setQuestion('');
    setMessages((m) => [...m, { role: 'user', text: transcript }]);
    setBusy(true);
    setMicState('thinking');
    try {
      const response = await fetch('/api/voice/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.current, text: transcript }),
      });
      const result = (await response.json()) as {
        answer?: string;
        error?: string;
        mode?: string;
        pendingProposal?: PendingProposal | null;
      };
      const answerText = response.ok
        ? result.answer ?? 'No answer returned.'
        : result.error ?? 'The assistant could not answer that.';
      setMessages((m) => [...m, { role: 'assistant', text: answerText }]);
      if (result.pendingProposal) setPendingProposal({ ...result.pendingProposal, sessionId: sessionId.current });
      if (result.mode === 'confirm' || result.mode === 'cancel') setPendingProposal(null);

      // Speak the response.
      setMicState('speaking');
      const speakResponse = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: answerText }),
      });
      if (speakResponse.ok) {
        const audioBlob = await speakResponse.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          void audio.play();
        });
        URL.revokeObjectURL(audioUrl);
      }
    } catch {
      setMessages((m) => [...m, { role: 'assistant', text: 'The decision assistant could not be reached.' }]);
    } finally {
      setBusy(false);
      setMicState('idle');
    }
  }, [busy]);

  const ask = async (prompt = question) => {
    const text = prompt.trim();
    if (!text || busy) return;
    setQuestion('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const response = await fetch('/api/voice/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.current, text }),
      });
      const result = (await response.json()) as {
        answer?: string;
        error?: string;
        mode?: string;
        pendingProposal?: PendingProposal | null;
      };
      const answerText = response.ok
        ? result.answer ?? 'No answer returned.'
        : result.error ?? 'The assistant could not answer that.';
      setMessages((m) => [...m, { role: 'assistant', text: answerText }]);
      if (result.pendingProposal) setPendingProposal({ ...result.pendingProposal, sessionId: sessionId.current });
      if (result.mode === 'confirm' || result.mode === 'cancel') setPendingProposal(null);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', text: 'The decision assistant could not be reached. Check that the optimizer evidence outputs exist and the configured model is available.' }]);
    } finally {
      setBusy(false);
    }
  };

  const startRecording = useCallback(async () => {
    if (micState !== 'idle' || busy) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setMicState('transcribing');
        const blob = new Blob(chunksRef.current, { type: 'audio/webm;codecs=opus' });
        const form = new FormData();
        form.append('audio', blob, 'recording.webm');
        try {
          const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
          const json = (await res.json()) as { transcript?: string; error?: string };
          if (!res.ok || !json.transcript) {
            setMicState('error');
            setMessages((m) => [...m, { role: 'assistant', text: json.error ?? 'Could not transcribe the recording.' }]);
            setBusy(false);
            return;
          }
          await askViaVoice(json.transcript);
        } catch {
          setMicState('error');
          setBusy(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setMicState('recording');
    } catch {
      setMicState('error');
    }
  }, [micState, busy, askViaVoice]);

  const stopRecording = useCallback(() => {
    if (micState !== 'recording') return;
    mediaRecorderRef.current?.stop();
  }, [micState]);

  useEffect(() => {
    if (micState === 'error') {
      const id = setTimeout(() => setMicState('idle'), 3000);
      return () => clearTimeout(id);
    }
  }, [micState]);

  const confirmProposal = async () => {
    if (!pendingProposal) return;
    await ask('confirm change');
  };

  const cancelProposal = async () => {
    if (!pendingProposal) return;
    await ask('cancel change');
  };

  const micLabel: Record<MicState, string> = {
    idle: 'Hold to speak',
    recording: 'Release to send',
    transcribing: 'Transcribing…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
    error: 'Mic error',
  };

  return (
    <section className="yc-card yc-assistant">
      <header>
        <div><h3>Decision assistant</h3><span>Voice or text · evidence-grounded</span></div>
        <Badge tone="info">FarmOpti + ElevenLabs</Badge>
      </header>
      <div className="yc-chat-log">
        {messages.map((message, index) => (
          <p className={`yc-chat-bubble yc-chat-${message.role}`} key={`${message.role}-${index}`}>{message.text}</p>
        ))}
        {busy && micState === 'thinking' && <p className="yc-chat-bubble yc-chat-assistant">Reviewing optimisation evidence…</p>}
        {micState === 'transcribing' && <p className="yc-chat-bubble yc-chat-assistant">Transcribing…</p>}
        {micState === 'speaking' && <p className="yc-chat-bubble yc-chat-assistant">Speaking response…</p>}
      </div>
      {pendingProposal && (
        <div className="yc-constraint-preview">
          <p><strong>Proposed rule:</strong> {pendingProposal.sourceText}</p>
          <div className="yc-constraint-actions">
            <button className="yc-btn yc-btn-primary" onClick={() => void confirmProposal()}>Confirm change</button>
            <button className="yc-btn" onClick={() => void cancelProposal()}>Cancel</button>
          </div>
        </div>
      )}
      <div className="yc-chat-suggestions">
        <button onClick={() => void ask('Why was the selected harvest plan chosen?')}>Why this plan?</button>
        <button onClick={() => void ask('What changed in the current optimisation?')}>What changed?</button>
      </div>
      <form className="yc-chat-form" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about a decision, or speak a constraint…"
          aria-label="Ask the decision assistant"
        />
        <button
          type="button"
          className={`yc-btn yc-mic-btn ${micState === 'recording' ? 'yc-mic-active' : ''} ${micState === 'error' ? 'yc-mic-error' : ''}`}
          aria-label={micLabel[micState]}
          title={micLabel[micState]}
          onMouseDown={() => void startRecording()}
          onMouseUp={stopRecording}
          onTouchStart={(e) => { e.preventDefault(); void startRecording(); }}
          onTouchEnd={stopRecording}
          disabled={busy && micState === 'thinking'}
        >
          {micState === 'error' ? <MicOff size={15} /> : <Mic size={15} />}
        </button>
        <button className="yc-btn yc-btn-dark" disabled={busy || !question.trim()} aria-label="Send question">
          <Send size={15} />
        </button>
      </form>
    </section>
  );
}

function CommandView({ plan, disrupted, onNavigate, onDisrupt, onOptimise }: { plan: OptimiserCandidate; disrupted: boolean; onNavigate: (view: ViewKey) => void; onDisrupt: () => void; onOptimise: () => void }) {
  const fields = yallambeeOpsDashboard.fields;
  const remaining = fields.reduce((sum, field) => sum + Math.max(0, field.ha - field.done), 0);
  const total = fields.reduce((sum, field) => sum + field.ha, 0);
  const completed = Math.round(((total - remaining) / total) * 100);
  const alerts = [
    disrupted ? { tone: 'bad' as Tone, title: 'Rain front moved forward 14 hours', text: 'The current plan is no longer optimal. H2 is capped at dealer-approved 70% throughput.', view: 'harvest' as ViewKey, when: '22 min ago' } : null,
    { tone: 'warn' as Tone, title: 'Field readiness is limiting the candidate set', text: 'The optimizer only schedules fields that meet readiness and weather feasibility rules.', view: 'harvest' as ViewKey, when: 'Current' },
    { tone: 'info' as Tone, title: 'Resource capacity is binding', text: 'Machine, labour and destination capacity are included when candidates are scored.', view: 'harvest' as ViewKey, when: 'Current' },
  ].filter(Boolean) as { tone: Tone; title: string; text: string; view: ViewKey; when: string }[];

  return <>
    <div className="yc-page-head"><div><h2>Command</h2><p>Everything that could change today&apos;s plan, in one place. {disrupted ? <b>Two conditions have changed since the plan was set.</b> : 'Conditions are tracking to plan.'}</p></div><div className="yc-actions"><button className="yc-btn" onClick={() => onNavigate('rules')}><BookOpen size={15} /> Farm rules</button><button className="yc-btn yc-btn-dark" onClick={() => onNavigate('harvest')}><Tractor size={15} /> Open harvest plan</button></div></div>
    {disrupted && <div className="yc-alert"><AlertTriangle size={20} /><div><strong>Current plan is no longer optimal</strong><span>The front moved forward and H2 is restricted. Rebuild the operation against the new facts.</span></div><button className="yc-btn yc-btn-light" onClick={onOptimise}>Reoptimise <ArrowRight size={15} /></button></div>}
    <section className="yc-hero"><div className="yc-hero-head"><div><h3>Next 18 hours</h3><span>{plan.label} · {plan.contractor ? 'contractor engaged' : 'own fleet only'} · crews stop 21:30</span></div><div className="yc-hero-legend"><span><i className="yc-legend-wheat" /> Wheat</span><span><i className="yc-legend-canola" /> Canola</span><span><i className="yc-legend-lentil" /> Lentils</span></div></div><Timeline plan={plan} disrupted={disrupted} /></section>
    <div className="yc-grid yc-grid-4"><StatCard label="Standing crop" value={String(Math.round(remaining))} unit="ha" detail={`${completed}% of the program is off`} meter={completed} /><StatCard label="Harvestable before rain" value={String(Math.round(plan.harvested))} unit="ha" detail={plan.truckLimited ? <span className="yc-down">Truck-limited · haulage is the bottleneck</span> : 'Header capacity is the bottleneck'} meter={(plan.harvested / remaining) * 100} tone="blue" /><StatCard label="Exposed to the front" value={String(Math.round(plan.exposedHa))} unit="ha" detail={`Weighted loss ${money(plan.lossValue)} at ${Math.round((disrupted ? 0.8 : 0.35) * 100)}% rain probability`} meter={(plan.exposedHa / remaining) * 100} tone="red" /><StatCard label="APW1 still owed" value="420" unit="t" detail="Contract C-3391 closes 18 Dec" meter={72} tone="amber" /></div>
    <div className="yc-grid yc-grid-main"><section className="yc-card"><header><h3>Needs a decision</h3><span>{alerts.length} total</span></header><div className="yc-feed">{alerts.map((alert) => <button className="yc-feed-item" key={alert.title} onClick={() => onNavigate(alert.view)}><i className={`yc-severity yc-severity-${alert.tone}`} /><span><b>{alert.title}</b><small>{alert.text}</small></span><time>{alert.when}</time></button>)}</div></section><section className="yc-card"><header><h3>Six-day outlook</h3><span>Bureau · Rupanyup</span></header><div className="yc-card-body yc-outlook">{yallambeeOpsDashboard.weather.map((day) => <div className="yc-weather" key={day.day}><span>{day.day} <em>{day.max}°</em></span><i><b style={{ width: `${Math.min(100, day.rain * 4)}%`, background: day.rain ? 'var(--yc-blue)' : 'transparent' }} /></i><strong>{day.rain ? `${day.rain} mm` : '—'}</strong></div>)}<dl className="yc-kv"><dt>Front arrival</dt><dd>{disrupted ? '23:18 tonight' : 'tomorrow afternoon'}</dd><dt>Confidence</dt><dd>{disrupted ? '80%' : '35%'}</dd><dt>Fire danger</dt><dd>GFDI 21 · High</dd><dt>Harvest ban</dt><dd>GFDI 35</dd></dl></div></section></div>
    <div className="yc-grid yc-grid-main"><DecisionAssistant /><section className="yc-card yc-scope"><header><h3>Supported system scope</h3><Badge tone="ok">Connected</Badge></header><div className="yc-card-body"><p>The current system can optimise schedules, score economics, apply weather, machine, labour and field-state constraints, and explain recorded decisions.</p><button className="yc-btn" onClick={() => onNavigate('harvest')}>Open supported plan <ArrowRight size={15} /></button></div></section></div>
    <ConfirmedConstraintsPanel />
    {!disrupted && <button className="yc-disrupt" onClick={onDisrupt}><CloudRain size={17} /> Simulate disruption <span>RAIN + MACHINE EVENT</span></button>}
  </>;
}

function DetailView({ view, plan, disrupted, onNavigate }: { view: ViewKey; plan: OptimiserCandidate; disrupted: boolean; onNavigate: (view: ViewKey) => void }) {
  const fields = yallambeeOpsDashboard.fields;
  if (view === 'harvest') return <><div className="yc-page-head"><div><h2>Harvest operations</h2><p>The optimiser rebuilds field order, headers, chaser bins, trucks, contractor and constraints whenever conditions change.</p></div><div className="yc-actions"><button className="yc-btn yc-btn-primary" onClick={() => onNavigate('command')}>Back to command</button></div></div><section className="yc-hero"><div className="yc-hero-head"><div><h3>Resource plan</h3><span>{plan.blocks.length} work blocks · {disrupted ? 'front arrives tonight' : 'front holds off until tomorrow'}</span></div></div><Timeline plan={plan} disrupted={disrupted} /></section><Table title="Field order and assignment"><thead><tr><th>Paddock</th><th>Crop</th><th>Property</th><th className="yc-right">Area</th><th className="yc-right">Standing</th><th>Status</th></tr></thead><tbody>{fields.map((field) => <tr key={field.id}><td><b>{field.name}</b><small>{field.variety}</small></td><td><FieldBadge field={field} /></td><td>{field.prop}</td><td className="yc-right">{field.ha} ha</td><td className="yc-right">{Math.max(0, field.ha - field.done)} ha</td><td><Badge tone={field.whp ? 'bad' : field.done === field.ha ? 'ok' : 'warn'}>{field.whp ? 'Withholding' : field.done === field.ha ? 'Complete' : 'Ready'}</Badge></td></tr>)}</tbody></Table></>;
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
  const [optimised, setOptimised] = useState(false);
  const dashboard = yallambeeOpsDashboard;
  const plan = useMemo<OptimiserCandidate>(() => ({
    id: optimised ? 'C' : 'B',
    label: optimised ? 'H2 restricted + contractor' : 'Both headers, own fleet',
    detail: optimised ? 'Delaney joins from 12:12 · T3 added to the Murtoa run.' : 'Existing field order, two trucks.',
    h2: disrupted ? 'restricted' : 'off',
    contractor: optimised,
    sequence: dashboard.fields.filter((field) => field.done < field.ha).map((field) => field.id),
    haul: optimised ? 29.5 : 25.5,
    blocks: dashboard.fields.filter((field) => field.done < field.ha).slice(0, 5).flatMap((field, index) => [{ m: index % 2 === 0 ? 'H1' : 'H2', f: field.id, name: field.name, crop: field.crop, s: index * 2, e: index * 2 + 1.7, ha: Math.min(45, field.ha - field.done) }]),
    harvested: optimised ? 324 : 286,
    exposedHa: disrupted ? (optimised ? 132 : 198) : 74,
    lossValue: disrupted ? (optimised ? 18420 : 33600) : 9240,
    opCost: optimised ? 11200 : 8740,
    contractorCost: optimised ? 4950 : 0,
    penalty: disrupted ? 920 : 0,
    net: optimised ? -35570 : -44100,
    truckLimited: !optimised,
    blockedByRule: false,
    deadline: disrupted ? 17.1 : 31.2,
  }), [dashboard.fields, disrupted, optimised]);

  const reset = () => { setView('command'); setDisrupted(false); setOptimised(false); };
  return <div className="yc-shell"><aside className="yc-rail"><div className="yc-brand"><div><Warehouse size={21} /><h1>Yallambee Ops</h1></div><p>Yallambee Cropping Co.<br />4 properties · 18,430 ha</p></div><nav className="yc-nav">{navGroups.map((group) => <div key={group.label}><span className="yc-nav-group">{group.label}</span>{group.items.map(({ id, label, icon: Icon, badge, tone }) => <button className={`yc-nav-link ${view === id ? 'yc-nav-active' : ''}`} key={id} onClick={() => setView(id)}><Icon size={16} /><span>{label}</span>{badge && <Badge tone={tone}>{id === 'harvest' && disrupted ? 'REPLAN' : badge}</Badge>}</button>)}</div>)}</nav><div className="yc-rail-foot">Harvest 2026–27 · day 19<br /><b>Mick Farrar</b> — operations manager</div></aside><main className="yc-main"><header className="yc-top"><span>Yallambee Cropping Co. · <b>{titleByView[view]}</b></span><span className="yc-top-spacer" /><span><i className={`yc-dot ${disrupted ? 'yc-dot-amber' : ''}`} /> {disrupted ? 'H2 restricted · 14 of 15 reporting' : '14 of 15 assets reporting'}</span><span className="yc-divider" /><span>Fire danger <b>GFDI 21 · High</b></span><span className="yc-divider" /><span><i className="yc-dot yc-dot-amber" /> Rain in <b>{disrupted ? '17h 06m' : '31h 12m'}</b></span><span className="yc-divider" /><span><b>06:12</b> Thu 4 Dec</span><button className="yc-icon-button" onClick={reset} aria-label="Reset dashboard" title="Reset dashboard"><RotateCcw size={15} /></button></header><div className="yc-page">{view === 'command' ? <CommandView plan={plan} disrupted={disrupted} onNavigate={setView} onDisrupt={() => setDisrupted(true)} onOptimise={() => setOptimised(true)} /> : <DetailView view={view} plan={plan} disrupted={disrupted} onNavigate={setView} />}<footer className="yc-footer"><span>Yallambee Ops prototype · synthetic data</span><span>Rules and machine states are supplied constraints</span></footer></div></main></div>;
}

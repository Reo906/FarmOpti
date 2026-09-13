import type { PersistedAlternativePlan, PersistedOptimizerSummary, PersistedScheduleRow } from '@/lib/ui/persisted-optimizer-output';

export interface DecisionIndexRecord {
  decision_id: string;
  type: string;
  text: string;
  plan_id?: string;
  field_id?: string;
  operation?: string;
  selected?: boolean;
  required?: boolean;
  resource_type?: string;
  importance: number;
}

export type ReasonTone = 'ok' | 'info' | 'warn';

export interface PlanReason {
  id: string;
  title: string;
  text: string;
  tone: ReasonTone;
  when: string;
}

interface ReasonCandidate extends PlanReason {
  key: string;
  priority: number;
}

export function parseDecisionIndex(raw: string): DecisionIndexRecord[] {
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionIndexRecord);
}

function money(value: number): string {
  return `A$${Math.abs(Math.round(value)).toLocaleString('en-AU')}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  if (!month || !day) return isoDate.slice(0, 10);
  return `${day} ${MONTHS[month - 1]}`;
}

function formatDayRange(dates: string[]): string {
  const unique = [...new Set(dates.map((value) => value.slice(0, 10)))].sort();
  if (unique.length === 0) return 'Current';
  const first = formatDay(unique[0]);
  const last = formatDay(unique[unique.length - 1]);
  if (first === last) return first;
  const sameMonth = unique[0].slice(0, 7) === unique[unique.length - 1].slice(0, 7);
  return sameMonth ? `${Number(unique[0].slice(8, 10))}–${last}` : `${first}–${last}`;
}

function timestampFrom(value: string | undefined): string {
  if (!value) return 'Current';
  const match = value.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2})?/);
  return match ? formatDay(match[0]) : 'Current';
}

function lastRowByPlan(schedule: PersistedScheduleRow[]): Map<string, PersistedScheduleRow> {
  const map = new Map<string, PersistedScheduleRow>();
  for (const row of schedule) map.set(row.plan_id, row);
  return map;
}

function cashByPlan(schedule: PersistedScheduleRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of schedule) {
    map.set(row.plan_id, (map.get(row.plan_id) ?? 0) + row.direct_cash_effect_aud);
  }
  return map;
}

function actionLabel(row: Pick<PersistedScheduleRow, 'operation' | 'field_id'>): string {
  return `${row.operation} on ${row.field_id}`;
}

function parseAud(value: string): number {
  return Number(value.replace(/,/g, ''));
}

function parseObjectiveChange(text: string): number | null {
  const match = text.match(/(?:Forbidding|Forcing)[^.]*?(-?[\d,]+(?:\.\d+)?)\s*AUD/i);
  return match ? parseAud(match[1]) : null;
}

function pickReasons(candidates: ReasonCandidate[], limit = 4): PlanReason[] {
  const chosen: PlanReason[] = [];
  const usedKeys = new Set<string>();
  const ranked = [...candidates].sort((left, right) => right.priority - left.priority);

  for (const candidate of ranked) {
    if (usedKeys.has(candidate.key)) continue;
    usedKeys.add(candidate.key);
    chosen.push({
      id: candidate.id,
      title: candidate.title,
      text: candidate.text,
      tone: candidate.tone,
      when: candidate.when,
    });
    if (chosen.length >= limit) return chosen;
  }

  return chosen;
}

function harvestReason(schedule: PersistedScheduleRow[]): ReasonCandidate | null {
  const cash = cashByPlan(schedule);
  const harvests = [...lastRowByPlan(schedule).values()].filter((row) => row.operation === 'harvest');
  if (harvests.length === 0) return null;

  const total = harvests.reduce((sum, row) => sum + (cash.get(row.plan_id) ?? 0), 0);
  const fields = joinList(harvests.map((row) => row.field_id));
  const start = schedule
    .filter((row) => row.operation === 'harvest')
    .map((row) => row.start_time)
    .filter(Boolean)
    .sort()[0];

  return {
    id: harvests.map((row) => row.plan_id).join('-'),
    key: 'harvest',
    priority: 100,
    title: `Harvesting ${fields}`,
    text: `Harvesting ${fields} generates ${money(total)}, the largest immediate return in this plan.`,
    tone: 'ok',
    when: timestampFrom(start),
  };
}

function labourConstraintReason(index: DecisionIndexRecord[]): ReasonCandidate | null {
  const records = index.filter((record) => record.type === 'RESOURCE_CONSTRAINT' && record.resource_type === 'labour');
  if (records.length === 0) return null;
  const dates = records.map((record) => record.decision_id.replace(/^labour:/, '')).filter(Boolean);
  const top = [...records].sort((left, right) => right.importance - left.importance)[0];
  return {
    id: top.decision_id,
    key: 'constraint',
    priority: 72,
    title: 'Labour fully booked',
    text: `Labour is fully booked from ${formatDayRange(dates)}, so jobs are sequenced around that bottleneck.`,
    tone: 'warn',
    when: formatDayRange(dates),
  };
}

function optionalKeepReasons(index: DecisionIndexRecord[]): ReasonCandidate[] {
  return index
    .filter((record) => record.type === 'ACTION_SELECTED' && record.required === false && record.selected)
    .flatMap((record) => {
      const change = parseObjectiveChange(record.text);
      if (change == null || Math.abs(change) < 500) return [];
      return [{
        id: record.decision_id,
        key: 'optional_keep',
        priority: 88 + record.importance,
        title: `Keeping ${record.operation ?? 'action'} on ${record.field_id ?? 'field'}`,
        text: `Keeping the ${record.operation ?? 'action'} on ${record.field_id ?? 'field'} preserves ${money(change)} of whole-farm value.`,
        tone: 'info' as const,
        when: timestampFrom(record.text),
      }];
    });
}

function optionalSkipReasons(index: DecisionIndexRecord[]): ReasonCandidate[] {
  return index
    .filter((record) => record.type === 'ACTION_SKIPPED' && record.required === false)
    .flatMap((record) => {
      const change = parseObjectiveChange(record.text);
      if (change == null || change >= -500) return [];
      return [{
        id: record.decision_id,
        key: 'optional_skip',
        priority: 80 + record.importance,
        title: `Leaving out ${record.operation ?? 'action'} on ${record.field_id ?? 'field'}`,
        text: `Leaving out the ${record.operation ?? 'action'} on ${record.field_id ?? 'field'} avoids a ${money(change)} reduction in farm value.`,
        tone: 'warn' as const,
        when: 'Current',
      }];
    });
}

function fieldTradeoffReason(index: DecisionIndexRecord[]): ReasonCandidate | null {
  const records = index.filter((item) => item.type === 'FIELD_OPTION_SELECTED');
  let best: DecisionIndexRecord | null = null;
  let bestGap = 0;
  for (const record of records) {
    const match = record.text.match(/objective value ([\d,.]+).*value ([\d,.]+)/);
    if (!match) continue;
    const gap = parseAud(match[2]) - parseAud(match[1]);
    if (gap > bestGap) {
      bestGap = gap;
      best = record;
    }
  }
  if (!best || bestGap < 400) return null;
  return {
    id: best.decision_id,
    key: 'field_tradeoff',
    priority: 62,
    title: `${best.field_id ?? 'Field'} field option`,
    text: `${best.field_id ?? 'A field'} takes a field option ${money(bestGap)} below its best local alternative so the whole-farm plan still fits.`,
    tone: 'info',
    when: 'Current',
  };
}

function terminalValueReason(summary: PersistedOptimizerSummary): ReasonCandidate | null {
  if (summary.total_terminal_value_aud <= 0 || summary.total_objective_value_aud <= 0) return null;
  const share = Math.round((summary.total_terminal_value_aud / summary.total_objective_value_aud) * 100);
  if (share < 40) return null;
  return {
    id: 'terminal-value',
    key: 'terminal',
    priority: 48,
    title: 'Crop value carried forward',
    text: `Terminal value ${money(summary.total_terminal_value_aud)} is ${share}% of the ${money(summary.total_objective_value_aud)} objective.`,
    tone: 'info',
    when: 'Current',
  };
}

function alternativeReasons(
  plan: PersistedAlternativePlan,
  baseline: PersistedAlternativePlan,
  index: DecisionIndexRecord[],
): ReasonCandidate[] {
  const previous = lastRowByPlan(baseline.schedule);
  const next = lastRowByPlan(plan.schedule);
  const dropped = [...previous.values()].filter((row) => !next.has(row.plan_id));
  const added = [...next.values()].filter((row) => !previous.has(row.plan_id));
  const rescheduled = [...next.values()].filter((row) => {
    const left = previous.get(row.plan_id);
    return Boolean(left && left.candidate_id !== row.candidate_id);
  });
  const harvests = [...next.values()].filter((row) => row.operation === 'harvest');
  const reasons: ReasonCandidate[] = [];

  if (plan.reason) {
    reasons.push({
      id: `${plan.plan_id}-reason`,
      key: 'intent',
      priority: 100,
      title: plan.label,
      text: plan.reason,
      tone: 'info',
      when: `${Math.round(plan.optimality_ratio * 100)}%`,
    });
  }

  if (dropped.length > 0) {
    const notable = dropped
      .map((row) => index.find((record) => record.plan_id === row.plan_id && record.type === 'ACTION_SELECTED'))
      .find((record) => record && parseObjectiveChange(record.text) != null);
    reasons.push({
      id: `${plan.plan_id}-dropped`,
      key: 'dropped',
      priority: 90,
      title: `Dropping ${joinList(dropped.map(actionLabel))}`,
      text: notable
        ? `Dropping ${joinList(dropped.map(actionLabel))}, including the ${actionLabel({ operation: notable.operation ?? 'action', field_id: notable.field_id ?? 'field' })} that preserves ${money(parseObjectiveChange(notable.text) ?? 0)} on Max Value.`
        : `Dropping ${joinList(dropped.map(actionLabel))}.`,
      tone: 'warn',
      when: 'Current',
    });
  }

  if (added.length > 0) {
    reasons.push({
      id: `${plan.plan_id}-added`,
      key: 'added',
      priority: 84,
      title: `Adding ${joinList(added.map(actionLabel))}`,
      text: `Adding ${joinList(added.map(actionLabel))} that Max Value left out.`,
      tone: 'info',
      when: 'Current',
    });
  }

  if (harvests.length > 0) {
    const start = harvests.map((row) => row.start_time).filter(Boolean).sort()[0];
    reasons.push({
      id: `${plan.plan_id}-harvest`,
      key: 'harvest',
      priority: 78,
      title: `Harvesting ${joinList(harvests.map((row) => row.field_id))}`,
      text: `Harvesting ${joinList(harvests.map((row) => row.field_id))} is still kept, so the main cash return remains in the plan.`,
      tone: 'ok',
      when: timestampFrom(start),
    });
  }

  if (rescheduled.length > 0) {
    reasons.push({
      id: `${plan.plan_id}-rescheduled`,
      key: 'rescheduled',
      priority: 70,
      title: `${rescheduled.length} job${rescheduled.length === 1 ? '' : 's'} moved`,
      text: `${rescheduled.map(actionLabel).join(', ')} use a different candidate time than Max Value.`,
      tone: 'info',
      when: 'Current',
    });
  }

  return reasons;
}

export function whyReasonsForPlan(options: {
  summary: PersistedOptimizerSummary;
  schedule: PersistedScheduleRow[];
  index?: DecisionIndexRecord[];
  plan?: PersistedAlternativePlan;
  baseline?: PersistedAlternativePlan;
  kind?: 'value' | 'cost' | 'risk' | 'smooth';
}): PlanReason[] {
  const index = options.index ?? [];
  const candidates: ReasonCandidate[] = [];

  if (options.plan && options.baseline && options.kind && options.kind !== 'value') {
    candidates.push(...alternativeReasons(options.plan, options.baseline, index));
  } else {
    const harvest = harvestReason(options.schedule);
    if (harvest) candidates.push(harvest);
    candidates.push(...optionalKeepReasons(index));
    candidates.push(...optionalSkipReasons(index));
    const labour = labourConstraintReason(index);
    if (labour) candidates.push(labour);
    const tradeoff = fieldTradeoffReason(index);
    if (tradeoff) candidates.push(tradeoff);
    const terminal = terminalValueReason(options.summary);
    if (terminal) candidates.push(terminal);
  }

  const reasons = pickReasons(candidates);
  if (reasons.length > 0) return reasons;
  return [{
    id: 'objective',
    title: `${options.summary.num_scheduled_actions} actions selected`,
    text: `Status ${options.summary.status}. Whole-farm objective ${money(options.summary.total_objective_value_aud)}.`,
    tone: 'info',
    when: 'Current',
  }];
}

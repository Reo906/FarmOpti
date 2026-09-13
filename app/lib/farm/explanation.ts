import { fields } from './data.ts';
import type { Plan, Rule, Scenario } from './types.ts';
export const money=(v:number)=>new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}).format(v);
export const number=(v:number)=>new Intl.NumberFormat('en-AU',{maximumFractionDigits:0}).format(v);
export function explain(plan:Plan,scenario:Scenario,rules:Rule[]):string[] {
  const first=plan.assignments.find(a=>a.resource==='H1');
  const result=[
    `Start H1 on ${fields.find(f=>f.id===first?.field)?.name??'the next available field'}. Field order balances rainfall exposure, readiness and the wheat commitment.`,
    plan.strategy.contractor?'Book C1 for 9 hours from hour 4 at A$550/hour. Its operator is included; rain and labour limits still apply.':'Use the owned fleet. Contractor benefits do not offset the booking cost in the best evaluated strategy.',
    plan.route==='split'?'Send T1 and T2 to regional receival; T3 serves on-farm storage. This gives canola and barley an eligible destination.':'Send all three trucks to regional receival. Only wheat can be delivered on this route.',
    plan.strategy.h2?`H2 stays within its externally supplied ${scenario.h2Capacity*100}% capacity limit.`:'Keep H2 stopped throughout this plan.',
  ];
  for(const r of rules)result.push(`${r.resource} is excluded from ${fields.find(f=>f.id===r.field)?.name} between hours ${scenario.rainAt+scenario.rainDuration} and ${scenario.rainAt+scenario.rainDuration+r.windowHours}: forecast rain exceeds ${r.rainfallMm} mm.`);
  return result;
}

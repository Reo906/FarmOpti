import { fields } from './data.ts';
import type { Rule, Scenario, Resource } from './types.ts';
export function parseRule(text:string):Rule {
  if (!text.trim() || text.length>1000) throw new Error('Enter a rule of 1–1,000 characters.');
  const lower=text.toLowerCase();
  const matching=fields.filter(f=>lower.includes(f.name.toLowerCase()));
  const machines=[...new Set(lower.match(/\b(?:h1|h2|c1)\b/g)??[])];
  const amount=lower.match(/(?:more than|over|above|>)\s*(\d+(?:\.\d+)?)\s*mm\b/);
  const window=lower.match(/(?:within|for)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if(matching.length!==1 || machines.length!==1 || !amount || !window || !/\b(?:never|prohibit|do not|don't)\b/.test(lower) || !/rain/.test(lower) || /\b(?:unless|except|allow|ignore|override)\b/.test(lower)) {
    throw new Error('Use one field and machine, a prohibition, and explicit limits: “Never send H2 to North 4 within 24 hours of more than 15 mm rainfall.” Conditional exceptions are not supported.');
  }
  const rainfallMm=Number(amount[1]), windowHours=Number(window[1]);
  if(rainfallMm<0 || rainfallMm>300 || windowHours<=0 || windowHours>168) throw new Error('Use a rainfall threshold up to 300 mm and a window between 1 and 168 hours.');
  return {resource:machines[0].toUpperCase() as Resource,field:matching[0].id,rainfallMm,windowHours,kind:'prohibit-after-rain',source:text.trim()};
}
export function isProhibited(rule:Rule,resource:Resource,field:string,hour:number,scenario:Scenario) {
  const rainEnd=scenario.rainAt+scenario.rainDuration;
  return rule.resource===resource && rule.field===field && scenario.rainMm>rule.rainfallMm && hour>=rainEnd && hour<rainEnd+rule.windowHours;
}

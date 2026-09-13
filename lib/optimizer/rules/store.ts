import fs from "node:fs";
import { FARM_RULES_PATH } from "../paths";
import type { FarmRule, NewFarmRule } from "./types";

export class RuleNotFoundError extends Error {}

export function loadRules(path: string = FARM_RULES_PATH): FarmRule[] {
  if (!fs.existsSync(path)) return [];
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function saveRules(rules: FarmRule[], path: string = FARM_RULES_PATH): void {
  fs.writeFileSync(path, JSON.stringify(rules, null, 2));
}

function nextId(rules: FarmRule[]): string {
  const numbers = rules
    .map((r) => Number(r.id.replace(/^RULE-/, "")))
    .filter((n) => Number.isFinite(n));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `RULE-${String(next).padStart(2, "0")}`;
}

export function addRule(rule: NewFarmRule, path: string = FARM_RULES_PATH): FarmRule {
  const rules = loadRules(path);
  const created: FarmRule = { ...rule, id: nextId(rules), created_at: new Date().toISOString() };
  rules.push(created);
  saveRules(rules, path);
  return created;
}

export function removeRule(id: string, path: string = FARM_RULES_PATH): FarmRule {
  const rules = loadRules(path);
  const index = rules.findIndex((r) => r.id === id);
  if (index === -1) throw new RuleNotFoundError(`No rule with id ${id}`);
  const [removed] = rules.splice(index, 1);
  saveRules(rules, path);
  return removed;
}

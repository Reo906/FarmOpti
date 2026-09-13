import { dataFileExists, readDataFile } from "../bundledData";
import { CONFIG } from "../config";
import { DECISION_INDEX_PATH, DECISION_TRACE_PATH } from "../paths";
import type { DecisionIndexRecord } from "../decisionAnalysis/buildDecisionIndex";
import type { DecisionTrace } from "../decisionAnalysis/extractDecisions";

const RETRIEVAL_CONFIG = CONFIG.explanation.retrieval;
const SCORING_CONFIG = RETRIEVAL_CONFIG.scoring;
const OPERATION_ALIASES: Record<string, string[]> = RETRIEVAL_CONFIG.operation_aliases;
const TYPE_KEYWORDS: Record<string, string[]> = RETRIEVAL_CONFIG.type_keywords;
const CHATBOT_CONFIG = CONFIG.explanation.chatbot;
const PROCESS_CONFIG = CONFIG.explanation.process_display ?? {};

const TARGET_TYPE_PRIORITY: Record<string, number> = {
  ACTION_SELECTED: 0,
  ACTION_SKIPPED: 0,
  COUNTERFACTUAL: 1,
  STATE_TRANSITION: 2,
  TIMING_SELECTION: 3,
  FIELD_OPTION_SELECTED: 4,
  RESOURCE_CONSTRAINT: 5,
};

function processPrint(message: string): void {
  if (PROCESS_CONFIG.enabled ?? true) console.log(message);
}

function tokenize(text: unknown): string[] {
  return (String(text).toLowerCase().match(/[a-z0-9_]+/g) ?? []) as string[];
}

function loadJsonl(filePath: string): DecisionIndexRecord[] {
  const text = readDataFile(filePath);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function counter(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

interface Document {
  record: DecisionIndexRecord;
  tokens: Map<string, number>;
}

interface QueryMetadata {
  plan_ids: Set<string>;
  field_ids: Set<string>;
  operations: Set<string>;
  types: Set<string>;
}

export interface RetrievedRecord extends DecisionIndexRecord {
  retrieval_score: number;
  target_match: boolean;
  raw_action_evidence?: unknown;
  raw_field_evidence?: unknown;
}

export class DecisionRetriever {
  private indexPath: string;
  private tracePath: string;
  records: DecisionIndexRecord[] = [];
  trace: Partial<DecisionTrace> = {};
  private documents: Document[] = [];
  private idf = new Map<string, number>();

  constructor(indexPath: string = DECISION_INDEX_PATH, tracePath: string = DECISION_TRACE_PATH) {
    this.indexPath = indexPath;
    this.tracePath = tracePath;

    processPrint("[INIT] Loading decision evidence...");

    if (!dataFileExists(this.indexPath)) {
      throw new Error(`Decision index not found: ${this.indexPath}\nRun the optimizer pipeline first.`);
    }

    this.records = loadJsonl(this.indexPath);
    processPrint(`[INIT] Loaded ${this.records.length} retrieval records`);

    if (dataFileExists(this.tracePath)) {
      this.trace = JSON.parse(readDataFile(this.tracePath));
      processPrint(`[INIT] Loaded ${this.trace.actions?.length ?? 0} action decision records`);
    }

    this.buildSearchIndex();
  }

  private buildSearchIndex(): void {
    this.documents = [];
    const documentFrequency = new Map<string, number>();

    for (const record of this.records) {
      const searchable = ["text", "plan_id", "field_id", "operation", "type", "resource_type"]
        .map((key) => String((record as any)[key] ?? ""))
        .join(" ");
      const tokens = tokenize(searchable);
      const counts = counter(tokens);

      this.documents.push({ record, tokens: counts });

      for (const token of counts.keys()) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    const n = Math.max(1, this.documents.length);
    this.idf = new Map(
      [...documentFrequency.entries()].map(([token, freq]) => [token, Math.log((n + 1) / (freq + 1)) + 1.0]),
    );

    processPrint(`[INIT] Retrieval index ready | ${this.documents.length} documents | ${this.idf.size} terms`);
  }

  private extractQueryMetadata(query: string): QueryMetadata {
    const lower = query.toLowerCase();

    const planIds = new Set([...query.matchAll(/\bP\d+\b/gi)].map((m) => m[0].toUpperCase()));
    const fieldIds = new Set([...query.matchAll(/\bF\d+\b/gi)].map((m) => m[0].toUpperCase()));

    const operations = new Set<string>();
    for (const [operation, aliases] of Object.entries(OPERATION_ALIASES)) {
      if (aliases.some((alias) => lower.includes(String(alias).toLowerCase()))) operations.add(operation);
    }

    const desiredTypes = new Set<string>();
    for (const [decisionType, keywords] of Object.entries(TYPE_KEYWORDS)) {
      if (keywords.some((keyword) => lower.includes(String(keyword).toLowerCase()))) desiredTypes.add(decisionType);
    }

    return { plan_ids: planIds, field_ids: fieldIds, operations, types: desiredTypes };
  }

  private printQueryMetadata(metadata: QueryMetadata): void {
    if (!(PROCESS_CONFIG.show_query_metadata ?? true)) return;

    const parts: string[] = [];
    if (metadata.plan_ids.size) parts.push(`plan=${[...metadata.plan_ids].sort().join(",")}`);
    if (metadata.field_ids.size) parts.push(`field=${[...metadata.field_ids].sort().join(",")}`);
    if (metadata.operations.size) parts.push(`operation=${[...metadata.operations].sort().join(",")}`);
    if (metadata.types.size) parts.push(`type=${[...metadata.types].sort().join(",")}`);

    processPrint(parts.length > 0 ? `[RETRIEVAL] Detected ${parts.join(" | ")}` : "[RETRIEVAL] No explicit metadata detected");
  }

  private resolveTargetPlanIds(metadata: QueryMetadata): Set<string> {
    if (metadata.plan_ids.size > 0) return new Set(metadata.plan_ids);
    if (metadata.field_ids.size === 0 && metadata.operations.size === 0) return new Set();

    let candidates = this.records.filter((r) => r.plan_id);

    if (metadata.field_ids.size > 0) {
      candidates = candidates.filter((r) => metadata.field_ids.has(String(r.field_id ?? "").toUpperCase()));
    }
    if (metadata.operations.size > 0) {
      candidates = candidates.filter((r) => metadata.operations.has(String(r.operation ?? "").toLowerCase()));
    }

    return new Set(candidates.map((r) => String(r.plan_id).toUpperCase()));
  }

  private textScore(queryTokens: string[], documentTokens: Map<string, number>): number {
    if (queryTokens.length === 0 || documentTokens.size === 0) return 0.0;

    const queryCounts = counter(queryTokens);
    let numerator = 0.0;
    let queryNorm = 0.0;
    let docNorm = 0.0;

    const allTokens = new Set([...queryCounts.keys(), ...documentTokens.keys()]);
    for (const token of allTokens) {
      const idf = this.idf.get(token) ?? 1.0;
      const q = (queryCounts.get(token) ?? 0) * idf;
      const d = (documentTokens.get(token) ?? 0) * idf;

      numerator += q * d;
      queryNorm += q * q;
      docNorm += d * d;
    }

    if (queryNorm === 0 || docNorm === 0) return 0.0;
    return numerator / Math.sqrt(queryNorm * docNorm);
  }

  private metadataScore(record: DecisionIndexRecord, metadata: QueryMetadata): number {
    let score = 0.0;

    const planId = String(record.plan_id ?? "").toUpperCase();
    const fieldId = String(record.field_id ?? "").toUpperCase();
    const operation = String(record.operation ?? "").toLowerCase();
    const decisionType = String(record.type ?? "");

    if (metadata.plan_ids.size > 0) {
      score += Number(metadata.plan_ids.has(planId) ? SCORING_CONFIG.plan_match : SCORING_CONFIG.plan_mismatch);
    }
    if (metadata.field_ids.size > 0) {
      score += Number(metadata.field_ids.has(fieldId) ? SCORING_CONFIG.field_match : SCORING_CONFIG.field_mismatch);
    }
    if (metadata.operations.size > 0) {
      score += Number(metadata.operations.has(operation) ? SCORING_CONFIG.operation_match : SCORING_CONFIG.operation_mismatch);
    }
    if (metadata.types.size > 0 && metadata.types.has(decisionType)) {
      score += Number(SCORING_CONFIG.type_match);
    }

    return score;
  }

  private importanceScore(record: DecisionIndexRecord): number {
    return Number(record.importance ?? 0.0) * Number(SCORING_CONFIG.importance_weight);
  }

  private attachRawEvidence(record: DecisionIndexRecord): RetrievedRecord {
    const result: RetrievedRecord = { ...record, retrieval_score: 0, target_match: false };
    const planId = String(record.plan_id ?? "");
    const fieldId = String(record.field_id ?? "");

    if (planId) {
      const action = (this.trace.actions ?? []).find((a) => String(a.plan_id) === planId);
      if (action) result.raw_action_evidence = action;
    }

    if (fieldId) {
      const field = (this.trace.field_decisions ?? []).find((f) => String(f.field_id) === fieldId);
      if (field) result.raw_field_evidence = field;
    }

    return result;
  }

  private retrieveTargetRecords(targetPlanIds: Set<string>, queryTokens: string[]): RetrievedRecord[] {
    const maxRecords = Number(RETRIEVAL_CONFIG.specific_target_max_records ?? 5);
    const candidates: { priority: number; negTextScore: number; negImportance: number; document: Document }[] = [];

    for (const document of this.documents) {
      const record = document.record;
      const planId = String(record.plan_id ?? "").toUpperCase();
      if (!targetPlanIds.has(planId)) continue;

      const priority = TARGET_TYPE_PRIORITY[String(record.type ?? "")] ?? 99;
      const textScore = this.textScore(queryTokens, document.tokens);
      const importance = Number(record.importance ?? 0.0);

      candidates.push({ priority, negTextScore: -textScore, negImportance: -importance, document });
    }

    candidates.sort((a, b) => a.priority - b.priority || a.negTextScore - b.negTextScore || a.negImportance - b.negImportance);

    const results: RetrievedRecord[] = [];
    for (const { negTextScore, document } of candidates.slice(0, maxRecords)) {
      const result = this.attachRawEvidence(document.record);
      result.retrieval_score = Math.round(-negTextScore * 1e4) / 1e4;
      result.target_match = true;
      results.push(result);
    }

    return results;
  }

  private retrieveGeneralRecords(queryTokens: string[], metadata: QueryMetadata, topK: number): RetrievedRecord[] {
    const scored: { score: number; document: Document }[] = [];

    for (const document of this.documents) {
      const record = document.record;
      const textScore = this.textScore(queryTokens, document.tokens);
      const metadataScore = this.metadataScore(record, metadata);
      const importanceScore = this.importanceScore(record);

      const totalScore = textScore * Number(SCORING_CONFIG.text_weight) + metadataScore + importanceScore;
      scored.push({ score: totalScore, document });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map(({ score, document }) => {
      const result = this.attachRawEvidence(document.record);
      result.retrieval_score = Math.round(score * 1e4) / 1e4;
      result.target_match = false;
      return result;
    });
  }

  private printResults(results: RetrievedRecord[]): void {
    processPrint(`[RETRIEVAL] Retrieved ${results.length} evidence records`);
    if (!(PROCESS_CONFIG.show_retrieved_evidence ?? true)) return;

    results.forEach((result, i) => {
      const scoreText = PROCESS_CONFIG.show_retrieval_scores ?? true ? ` | score=${result.retrieval_score.toFixed(2)}` : "";
      processPrint(`  ${i + 1}. ${result.decision_id} | ${result.type}${scoreText}`);
    });
  }

  retrieve(query: string, topK?: number): RetrievedRecord[] {
    const k = topK ?? Number(RETRIEVAL_CONFIG.top_k);

    processPrint("[RETRIEVAL] Searching decision index...");

    const queryTokens = tokenize(query);
    const metadata = this.extractQueryMetadata(query);
    this.printQueryMetadata(metadata);

    const targetPlanIds = this.resolveTargetPlanIds(metadata);

    let results: RetrievedRecord[];
    if (targetPlanIds.size > 0) {
      processPrint(`[RETRIEVAL] Resolved target plan(s): ${[...targetPlanIds].sort().join(", ")}`);
      results = this.retrieveTargetRecords(targetPlanIds, queryTokens);
    } else {
      processPrint("[RETRIEVAL] No unique decision target resolved -> using general retrieval");
      results = this.retrieveGeneralRecords(queryTokens, metadata, k);
    }

    this.printResults(results);
    return results;
  }

  getDefaultDecisions(limit?: number): RetrievedRecord[] {
    const lim = limit ?? Number(RETRIEVAL_CONFIG.default_summary_decisions);
    processPrint(`[RETRIEVAL] Selecting top ${lim} important decisions...`);

    const records = [...this.records].sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0));
    const selected: RetrievedRecord[] = [];
    const perPlan = new Map<string, number>();

    const preferredTypes = new Set(["ACTION_SELECTED", "ACTION_SKIPPED", "COUNTERFACTUAL", "RESOURCE_CONSTRAINT", "FIELD_OPTION_SELECTED"]);

    for (const record of records) {
      if (!preferredTypes.has(record.type)) continue;

      const planId = String(record.plan_id ?? "");
      if (planId && (perPlan.get(planId) ?? 0) >= 1) continue;

      const result = this.attachRawEvidence(record);
      result.target_match = false;
      selected.push(result);

      if (planId) perPlan.set(planId, (perPlan.get(planId) ?? 0) + 1);
      if (selected.length >= lim) break;
    }

    processPrint(`[RETRIEVAL] Selected ${selected.length} important decisions`);
    return selected;
  }

  isCounterfactualQuestion(query: string): boolean {
    if (!CHATBOT_CONFIG.detect_counterfactual_questions) return false;

    const lower = query.toLowerCase();
    const matched = (CHATBOT_CONFIG.counterfactual_phrases as string[]).filter((phrase) => lower.includes(String(phrase).toLowerCase()));

    if (matched.length > 0) {
      processPrint(`[ROUTE] Counterfactual intent detected | matched=${JSON.stringify(matched)}`);
      return true;
    }

    return false;
  }
}

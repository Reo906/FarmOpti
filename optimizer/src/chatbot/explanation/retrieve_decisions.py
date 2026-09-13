from __future__ import annotations

import json
import math
import re
from collections import Counter
from pathlib import Path

from optimization.generate_candidates import CONFIG, OPTIMIZER_ROOT


INDEX_PATH = OPTIMIZER_ROOT / "outputs" / "decision_index.jsonl"
TRACE_PATH = OPTIMIZER_ROOT / "outputs" / "decision_trace.json"

RETRIEVAL_CONFIG = CONFIG["explanation"]["retrieval"]
SCORING_CONFIG = RETRIEVAL_CONFIG["scoring"]
OPERATION_ALIASES = RETRIEVAL_CONFIG["operation_aliases"]
TYPE_KEYWORDS = RETRIEVAL_CONFIG["type_keywords"]
CHATBOT_CONFIG = CONFIG["explanation"]["chatbot"]
PROCESS_CONFIG = CONFIG["explanation"].get("process_display", {})

TARGET_TYPE_PRIORITY = {
    "ACTION_SELECTED": 0,
    "ACTION_SKIPPED": 0,
    "COUNTERFACTUAL": 1,
    "STATE_TRANSITION": 2,
    "TIMING_SELECTION": 3,
    "FIELD_OPTION_SELECTED": 4,
    "RESOURCE_CONSTRAINT": 5,
}


def process_print(message):
    if PROCESS_CONFIG.get("enabled", True):
        print(message, flush=True)


def tokenize(text):
    return re.findall(r"[a-z0-9_]+", str(text).lower())


def load_jsonl(path):
    records = []

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    return records


class DecisionRetriever:
    def __init__(self, index_path=INDEX_PATH, trace_path=TRACE_PATH):
        self.index_path = Path(index_path)
        self.trace_path = Path(trace_path)

        process_print("[INIT] Loading decision evidence...")

        if not self.index_path.exists():
            raise FileNotFoundError(f"Decision index not found: {self.index_path}\nRun optimizer/src/pipeline/run_pipeline.py first.")

        self.records = load_jsonl(self.index_path)
        process_print(f"[INIT] Loaded {len(self.records)} retrieval records")

        self.trace = {}

        if self.trace_path.exists():
            with open(self.trace_path, "r", encoding="utf-8") as f:
                self.trace = json.load(f)

            process_print(f"[INIT] Loaded {len(self.trace.get('actions', []))} action decision records")

        self._build_search_index()

    def _build_search_index(self):
        self.documents = []
        document_frequency = Counter()

        for record in self.records:
            searchable = " ".join(str(record.get(key, "")) for key in ("text", "plan_id", "field_id", "operation", "type", "resource_type"))
            tokens = tokenize(searchable)
            counts = Counter(tokens)

            self.documents.append({"record": record, "tokens": counts})

            for token in counts:
                document_frequency[token] += 1

        n = max(1, len(self.documents))
        self.idf = {token: math.log((n + 1) / (freq + 1)) + 1.0 for token, freq in document_frequency.items()}

        process_print(f"[INIT] Retrieval index ready | {len(self.documents)} documents | {len(self.idf)} terms")

    def _extract_query_metadata(self, query):
        lower = query.lower()

        plan_ids = {x.upper() for x in re.findall(r"\bP\d+\b", query, flags=re.IGNORECASE)}
        field_ids = {x.upper() for x in re.findall(r"\bF\d+\b", query, flags=re.IGNORECASE)}

        operations = set()

        for operation, aliases in OPERATION_ALIASES.items():
            if any(str(alias).lower() in lower for alias in aliases):
                operations.add(operation)

        desired_types = set()

        for decision_type, keywords in TYPE_KEYWORDS.items():
            if any(str(keyword).lower() in lower for keyword in keywords):
                desired_types.add(decision_type)

        return {
            "plan_ids": plan_ids,
            "field_ids": field_ids,
            "operations": operations,
            "types": desired_types,
        }

    def _print_query_metadata(self, metadata):
        if not PROCESS_CONFIG.get("show_query_metadata", True):
            return

        parts = []

        if metadata["plan_ids"]:
            parts.append(f"plan={','.join(sorted(metadata['plan_ids']))}")

        if metadata["field_ids"]:
            parts.append(f"field={','.join(sorted(metadata['field_ids']))}")

        if metadata["operations"]:
            parts.append(f"operation={','.join(sorted(metadata['operations']))}")

        if metadata["types"]:
            parts.append(f"type={','.join(sorted(metadata['types']))}")

        if parts:
            process_print("[RETRIEVAL] Detected " + " | ".join(parts))
        else:
            process_print("[RETRIEVAL] No explicit metadata detected")

    def _resolve_target_plan_ids(self, metadata):
        if metadata["plan_ids"]:
            return set(metadata["plan_ids"])

        if not metadata["field_ids"] and not metadata["operations"]:
            return set()

        candidates = [record for record in self.records if record.get("plan_id")]

        if metadata["field_ids"]:
            candidates = [record for record in candidates if str(record.get("field_id", "")).upper() in metadata["field_ids"]]

        if metadata["operations"]:
            candidates = [record for record in candidates if str(record.get("operation", "")).lower() in metadata["operations"]]

        return {str(record["plan_id"]).upper() for record in candidates}

    def _text_score(self, query_tokens, document_tokens):
        if not query_tokens or not document_tokens:
            return 0.0

        query_counts = Counter(query_tokens)
        numerator = 0.0
        query_norm = 0.0
        doc_norm = 0.0

        for token in set(query_counts) | set(document_tokens):
            idf = self.idf.get(token, 1.0)
            q = query_counts.get(token, 0) * idf
            d = document_tokens.get(token, 0) * idf

            numerator += q * d
            query_norm += q * q
            doc_norm += d * d

        if query_norm == 0 or doc_norm == 0:
            return 0.0

        return numerator / math.sqrt(query_norm * doc_norm)

    def _metadata_score(self, record, metadata):
        score = 0.0

        plan_id = str(record.get("plan_id", "")).upper()
        field_id = str(record.get("field_id", "")).upper()
        operation = str(record.get("operation", "")).lower()
        decision_type = str(record.get("type", ""))

        if metadata["plan_ids"]:
            score += float(SCORING_CONFIG["plan_match"] if plan_id in metadata["plan_ids"] else SCORING_CONFIG["plan_mismatch"])

        if metadata["field_ids"]:
            score += float(SCORING_CONFIG["field_match"] if field_id in metadata["field_ids"] else SCORING_CONFIG["field_mismatch"])

        if metadata["operations"]:
            score += float(SCORING_CONFIG["operation_match"] if operation in metadata["operations"] else SCORING_CONFIG["operation_mismatch"])

        if metadata["types"] and decision_type in metadata["types"]:
            score += float(SCORING_CONFIG["type_match"])

        return score

    def _importance_score(self, record):
        return float(record.get("importance", 0.0)) * float(SCORING_CONFIG["importance_weight"])

    def _attach_raw_evidence(self, record):
        result = dict(record)
        plan_id = str(record.get("plan_id", ""))
        field_id = str(record.get("field_id", ""))

        if plan_id:
            for action in self.trace.get("actions", []):
                if str(action.get("plan_id")) == plan_id:
                    result["raw_action_evidence"] = action
                    break

        if field_id:
            for field in self.trace.get("field_decisions", []):
                if str(field.get("field_id")) == field_id:
                    result["raw_field_evidence"] = field
                    break

        return result

    def _retrieve_target_records(self, target_plan_ids, query_tokens):
        max_records = int(RETRIEVAL_CONFIG.get("specific_target_max_records", 5))
        candidates = []

        for document in self.documents:
            record = document["record"]
            plan_id = str(record.get("plan_id", "")).upper()

            if plan_id not in target_plan_ids:
                continue

            type_priority = TARGET_TYPE_PRIORITY.get(str(record.get("type", "")), 99)
            text_score = self._text_score(query_tokens, document["tokens"])
            importance = float(record.get("importance", 0.0))

            candidates.append((type_priority, -text_score, -importance, record))

        candidates.sort(key=lambda x: (x[0], x[1], x[2]))

        results = []

        for _, negative_text_score, _, record in candidates[:max_records]:
            result = self._attach_raw_evidence(record)
            result["retrieval_score"] = round(-negative_text_score, 4)
            result["target_match"] = True
            results.append(result)

        return results

    def _retrieve_general_records(self, query_tokens, metadata, top_k):
        scored = []

        for document in self.documents:
            record = document["record"]
            text_score = self._text_score(query_tokens, document["tokens"])
            metadata_score = self._metadata_score(record, metadata)
            importance_score = self._importance_score(record)

            total_score = text_score * float(SCORING_CONFIG["text_weight"]) + metadata_score + importance_score
            scored.append((total_score, record))

        scored.sort(key=lambda x: x[0], reverse=True)

        results = []

        for score, record in scored[:top_k]:
            result = self._attach_raw_evidence(record)
            result["retrieval_score"] = round(score, 4)
            result["target_match"] = False
            results.append(result)

        return results

    def _print_results(self, results):
        process_print(f"[RETRIEVAL] Retrieved {len(results)} evidence records")

        if not PROCESS_CONFIG.get("show_retrieved_evidence", True):
            return

        for i, result in enumerate(results, start=1):
            score_text = f" | score={result['retrieval_score']:.2f}" if PROCESS_CONFIG.get("show_retrieval_scores", True) else ""
            process_print(f"  {i}. {result.get('decision_id')} | {result.get('type')}{score_text}")

    def retrieve(self, query, top_k=None):
        if top_k is None:
            top_k = int(RETRIEVAL_CONFIG["top_k"])

        process_print("[RETRIEVAL] Searching decision index...")

        query_tokens = tokenize(query)
        metadata = self._extract_query_metadata(query)
        self._print_query_metadata(metadata)

        target_plan_ids = self._resolve_target_plan_ids(metadata)

        if target_plan_ids:
            process_print(f"[RETRIEVAL] Resolved target plan(s): {', '.join(sorted(target_plan_ids))}")
            results = self._retrieve_target_records(target_plan_ids, query_tokens)
        else:
            process_print("[RETRIEVAL] No unique decision target resolved → using general retrieval")
            results = self._retrieve_general_records(query_tokens, metadata, top_k)

        self._print_results(results)
        return results

    def get_default_decisions(self, limit=None):
        if limit is None:
            limit = int(RETRIEVAL_CONFIG["default_summary_decisions"])

        process_print(f"[RETRIEVAL] Selecting top {limit} important decisions...")

        records = sorted(self.records, key=lambda x: float(x.get("importance", 0.0)), reverse=True)
        selected = []
        per_plan = Counter()

        preferred_types = {
            "ACTION_SELECTED",
            "ACTION_SKIPPED",
            "COUNTERFACTUAL",
            "RESOURCE_CONSTRAINT",
            "FIELD_OPTION_SELECTED",
        }

        for record in records:
            if record.get("type") not in preferred_types:
                continue

            plan_id = str(record.get("plan_id", ""))

            if plan_id and per_plan[plan_id] >= 1:
                continue

            result = self._attach_raw_evidence(record)
            result["target_match"] = False
            selected.append(result)

            if plan_id:
                per_plan[plan_id] += 1

            if len(selected) >= limit:
                break

        process_print(f"[RETRIEVAL] Selected {len(selected)} important decisions")
        return selected

    def is_counterfactual_question(self, query):
        if not CHATBOT_CONFIG["detect_counterfactual_questions"]:
            return False

        lower = query.lower()
        matched = [str(phrase) for phrase in CHATBOT_CONFIG["counterfactual_phrases"] if str(phrase).lower() in lower]

        if matched:
            process_print(f"[ROUTE] Counterfactual intent detected | matched={matched}")
            return True

        return False
import path from "node:path";
import { listDataDir } from "../../bundledData";
import { readCsv, type RawRow } from "../../csv";
import { EXTERNAL_DIR } from "../../paths";

export const FILTER_OPERATORS = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "contains"] as const;
export const UPDATE_OPERATORS = ["set", "add", "subtract", "multiply"] as const;

export const ACTION_CONSTRAINTS: Record<string, { type: string; operators: string[] }> = {
  selected: { type: "boolean", operators: ["eq"] },
  date: { type: "date", operators: ["eq", "gt", "gte", "lt", "lte"] },
  start_time: { type: "datetime", operators: ["eq", "gt", "gte", "lt", "lte"] },
};

const IMMUTABLE_COLUMNS = new Set(["plan_id", "field_id", "machine_id", "candidate_id", "date", "time", "operation"]);

export class ScenarioValidationError extends Error {}

export interface Expression {
  op: string;
  value: unknown;
}

type Table = RawRow[];

function isNumericColumn(table: Table, column: string): boolean {
  return table.every((row) => {
    const v = row[column];
    return v === undefined || v === "" || (!Number.isNaN(Number(v)) && v.trim() !== "");
  });
}

function columnType(table: Table, column: string): "boolean" | "integer" | "number" | "string" {
  const values = table.map((r) => r[column]).filter((v) => v !== undefined && v !== "");
  if (values.length > 0 && values.every((v) => v === "True" || v === "False" || v === "true" || v === "false")) {
    return "boolean";
  }
  if (values.length > 0 && values.every((v) => /^-?\d+$/.test(v))) return "integer";
  if (isNumericColumn(table, column) && values.length > 0) return "number";
  return "string";
}

function coerceComparable(table: Table, column: string, value: unknown): { values: (number | string | boolean)[]; comparableValue: number | string | boolean } {
  const type = columnType(table, column);

  if (type === "number" || type === "integer") {
    return {
      values: table.map((r) => Number(r[column])),
      comparableValue: Number(value),
    };
  }

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "false") {
      const boolValue = lowered === "true";
      const mapped = table.map((r) => {
        const v = (r[column] ?? "").toLowerCase();
        if (v === "true" || v === "1") return true;
        if (v === "false" || v === "0") return false;
        return null;
      });
      if (mapped.some((v) => v !== null)) {
        return { values: mapped as boolean[], comparableValue: boolValue };
      }
    }

    if (/date|time|from|to/.test(column.toLowerCase())) {
      const parsedValue = Date.parse(value);
      const parsed = table.map((r) => (r[column] ? Date.parse(r[column]) : NaN));
      if (!Number.isNaN(parsedValue) && parsed.some((v) => !Number.isNaN(v))) {
        return { values: parsed, comparableValue: parsedValue };
      }
    }
  }

  return {
    values: table.map((r) => (r[column] ?? "").toLowerCase()),
    comparableValue: String(value).toLowerCase(),
  };
}

export function evaluateExpression(table: Table, column: string, expression: Expression): boolean[] {
  const { op, value } = expression;

  if (op === "in") {
    if (!Array.isArray(value)) throw new ScenarioValidationError("Operator 'in' requires a list value");
    const values = new Set((value as unknown[]).map((v) => String(v).toLowerCase()));
    return table.map((r) => values.has((r[column] ?? "").toLowerCase()));
  }

  if (op === "contains") {
    const needle = String(value).toLowerCase();
    return table.map((r) => (r[column] ?? "").toLowerCase().includes(needle));
  }

  const { values, comparableValue } = coerceComparable(table, column, value);

  switch (op) {
    case "eq":
      return values.map((v) => v === comparableValue);
    case "neq":
      return values.map((v) => v !== comparableValue);
    case "gt":
      return values.map((v) => v > comparableValue);
    case "gte":
      return values.map((v) => v >= comparableValue);
    case "lt":
      return values.map((v) => v < comparableValue);
    case "lte":
      return values.map((v) => v <= comparableValue);
    default:
      throw new ScenarioValidationError(`Unsupported filter operator: ${op}`);
  }
}

export function buildMask(table: Table, where: Record<string, Expression>): boolean[] {
  let mask = table.map(() => true);
  for (const [field, expression] of Object.entries(where)) {
    if (table.length > 0 && !(field in table[0])) {
      throw new ScenarioValidationError(`Unknown selector field ${JSON.stringify(field)}`);
    }
    const fieldMask = evaluateExpression(table, field, expression);
    mask = mask.map((m, i) => m && fieldMask[i]);
  }
  return mask;
}

interface TableSpec {
  filename: string;
  columns: string[];
  types: Record<string, string>;
  modifiable: string[];
}

export interface ScenarioChange {
  target: string;
  where: Record<string, Expression>;
  update?: Record<string, Expression>;
  constraints?: Record<string, Expression>;
}

export interface ScenarioInterpretation {
  mode: "explain" | "scenario";
  description: string;
  changes: ScenarioChange[];
}

export class ScenarioValidator {
  externalVariablesDir: string;
  tables: Record<string, TableSpec> = {};
  actionTable = "management_plan";
  private cache = new Map<string, Table>();

  constructor(externalVariablesDir: string = EXTERNAL_DIR) {
    this.externalVariablesDir = externalVariablesDir;
    this.tables = this.discoverTables();

    if (!(this.actionTable in this.tables)) {
      throw new Error(`Required table ${this.actionTable}.csv not found in ${this.externalVariablesDir}`);
    }
  }

  private discoverTables(): Record<string, TableSpec> {
    const tables: Record<string, TableSpec> = {};
    const files = listDataDir(this.externalVariablesDir)
      .filter((f) => f.endsWith(".csv"))
      .sort();

    for (const filename of files) {
      const rows = readCsv(path.join(this.externalVariablesDir, filename));
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      const stem = filename.replace(/\.csv$/, "");
      tables[stem] = {
        filename,
        columns,
        types: Object.fromEntries(columns.map((c) => [c, columnType(rows, c)])),
        modifiable: columns.filter((c) => !IMMUTABLE_COLUMNS.has(c) && !c.endsWith("_id")),
      };
    }

    return tables;
  }

  targets(): string[] {
    return ["action", ...Object.keys(this.tables)];
  }

  fileForTarget(target: string): string {
    const table = target === "action" ? this.actionTable : target;
    if (!(table in this.tables)) throw new ScenarioValidationError(`Unknown target ${JSON.stringify(target)}`);
    return path.join(this.externalVariablesDir, this.tables[table].filename);
  }

  tableTargetForAction(): string {
    return this.actionTable;
  }

  whereFields(target: string): string[] {
    const table = target === "action" ? this.actionTable : target;
    if (target === "action") {
      const preferred = ["plan_id", "field_id", "operation", "target", "required"];
      return preferred.filter((f) => this.tables[table].columns.includes(f));
    }
    return [...this.tables[table].columns];
  }

  updateFields(target: string): string[] {
    const table = target === "action" ? this.actionTable : target;
    return [...this.tables[table].modifiable];
  }

  private table(target: string): Table {
    const tableName = target === "action" ? this.actionTable : target;
    if (!this.cache.has(tableName)) {
      this.cache.set(tableName, readCsv(this.fileForTarget(tableName)));
    }
    return this.cache.get(tableName)!;
  }

  matchingRows(target: string, where: Record<string, Expression>): RawRow[] {
    const table = this.table(target);
    const mask = buildMask(table, where);
    return table.filter((_, i) => mask[i]);
  }

  private sampleValues(table: Table, column: string, limit = 10): unknown[] {
    const seen = new Set<string>();
    const values: unknown[] = [];
    for (const row of table) {
      const v = row[column];
      if (v === undefined || v === "" || seen.has(v)) continue;
      seen.add(v);
      values.push(v);
      if (values.length >= limit) break;
    }
    return values;
  }

  describeForLlm(): Record<string, unknown> {
    const targets: Record<string, unknown> = {};
    const management = this.table("action");
    const planColumns = ["plan_id", "field_id", "operation", "target", "required"].filter((c) =>
      management.length > 0 ? c in management[0] : this.tables[this.actionTable].columns.includes(c),
    );

    targets.action = {
      purpose:
        "A farm management/scheduling action. Use this when the user refers to harvesting, irrigation, spraying, fertilising, planting, a plan, or when an operation is performed.",
      where_fields: Object.fromEntries(
        this.whereFields("action").map((f) => [f, this.tables[this.actionTable].types[f] ?? "string"]),
      ),
      update_fields: Object.fromEntries(
        this.updateFields("action").map((f) => [f, this.tables[this.actionTable].types[f] ?? "string"]),
      ),
      constraints: ACTION_CONSTRAINTS,
      plans: management.map((row) => Object.fromEntries(planColumns.map((c) => [c, row[c]]))),
    };

    for (const [target, spec] of Object.entries(this.tables)) {
      const table = this.table(target);
      const sampleValues: Record<string, unknown[]> = {};
      for (const column of spec.columns) {
        if (column.endsWith("_id") || ["operation", "item", "variable_type", "date"].includes(column)) {
          sampleValues[column] = this.sampleValues(table, column);
        }
      }
      targets[target] = {
        purpose: `Rows from ${spec.filename}.`,
        where_fields: Object.fromEntries(spec.columns.map((c) => [c, spec.types[c]])),
        update_fields: Object.fromEntries(spec.modifiable.map((c) => [c, spec.types[c]])),
        sample_values: sampleValues,
      };
    }

    return {
      dsl: {
        where_operators: FILTER_OPERATORS,
        update_operators: UPDATE_OPERATORS,
        expression_format: { field_name: { op: "operator", value: "value" } },
      },
      targets,
    };
  }

  describeForLlmJson(): string {
    return JSON.stringify(this.describeForLlm(), null, 2);
  }

  responseSchema(): Record<string, unknown> {
    const scalar = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] };
    const expressionValue = { anyOf: [scalar, { type: "array", items: scalar }] };
    const filterExpression = {
      type: "object",
      properties: { op: { type: "string", enum: FILTER_OPERATORS }, value: expressionValue },
      required: ["op", "value"],
      additionalProperties: false,
    };
    const updateExpression = {
      type: "object",
      properties: { op: { type: "string", enum: UPDATE_OPERATORS }, value: scalar },
      required: ["op", "value"],
      additionalProperties: false,
    };
    const constraintExpression = {
      type: "object",
      properties: { op: { type: "string", enum: ["eq", "gt", "gte", "lt", "lte"] }, value: scalar },
      required: ["op", "value"],
      additionalProperties: false,
    };
    const change = {
      type: "object",
      properties: {
        target: { type: "string", enum: this.targets() },
        where: { type: "object", additionalProperties: filterExpression },
        update: { type: "object", additionalProperties: updateExpression },
        constraints: { type: "object", additionalProperties: constraintExpression },
      },
      required: ["target", "where"],
      additionalProperties: false,
    };
    return {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["explain", "scenario"] },
        description: { type: "string" },
        changes: { type: "array", items: change },
      },
      required: ["mode", "description", "changes"],
      additionalProperties: false,
    } as Record<string, unknown>;
  }

  private normalizeExpression(expression: unknown, allowedOperators: readonly string[], label: string): Expression {
    if (typeof expression !== "object" || expression === null) {
      throw new ScenarioValidationError(`${label} must be an object with 'op' and 'value'`);
    }
    const keys = Object.keys(expression as object);
    if (keys.length !== 2 || !keys.includes("op") || !keys.includes("value")) {
      throw new ScenarioValidationError(`${label} must contain exactly 'op' and 'value'`);
    }

    const op = String((expression as any).op).toLowerCase();
    if (!allowedOperators.includes(op)) {
      throw new ScenarioValidationError(`Unsupported operator ${JSON.stringify(op)} for ${label}`);
    }

    let value = (expression as any).value;
    const field = label.split(".").pop()!;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1) {
      const key = Object.keys(value)[0];
      if (key === field || key === "value") value = value[key];
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      throw new ScenarioValidationError(`${label}.value must be a scalar value or a list for operator 'in'`);
    }
    if (Array.isArray(value) && op !== "in") {
      throw new ScenarioValidationError(`${label} only accepts a list value with operator 'in'`);
    }
    if (op === "in" && !Array.isArray(value)) {
      throw new ScenarioValidationError(`${label} with operator 'in' requires a list value`);
    }

    return { op, value };
  }

  private validateWhere(target: string, where: unknown): Record<string, Expression> {
    if (typeof where !== "object" || where === null || Object.keys(where).length === 0) {
      throw new ScenarioValidationError("where must be a non-empty object");
    }

    const allowedFields = new Set(this.whereFields(target));
    const normalized: Record<string, Expression> = {};
    for (const [field, expression] of Object.entries(where as Record<string, unknown>)) {
      if (!allowedFields.has(field)) {
        throw new ScenarioValidationError(
          `Field ${JSON.stringify(field)} cannot select target ${JSON.stringify(target)}. Allowed: ${[...allowedFields].sort()}`,
        );
      }
      normalized[field] = this.normalizeExpression(expression, FILTER_OPERATORS, `where.${field}`);
    }

    if (this.matchingRows(target, normalized).length === 0) {
      throw new ScenarioValidationError(`No ${JSON.stringify(target)} rows matched where=${JSON.stringify(normalized)}`);
    }
    return normalized;
  }

  private validateUpdate(target: string, update: unknown): Record<string, Expression> | null {
    if (update === undefined || update === null) return null;
    if (typeof update !== "object" || Object.keys(update).length === 0) {
      throw new ScenarioValidationError("update must be a non-empty object");
    }

    const allowedFields = new Set(this.updateFields(target));
    const normalized: Record<string, Expression> = {};
    for (const [field, rawExpression] of Object.entries(update as Record<string, unknown>)) {
      if (!allowedFields.has(field)) {
        throw new ScenarioValidationError(
          `Field ${JSON.stringify(field)} cannot be updated on target ${JSON.stringify(target)}. Allowed: ${[...allowedFields].sort()}`,
        );
      }
      const expression = this.normalizeExpression(rawExpression, UPDATE_OPERATORS, `update.${field}`);
      if (expression.op !== "set" && typeof expression.value !== "number") {
        throw new ScenarioValidationError(`update.${field} with operator ${JSON.stringify(expression.op)} requires a numeric value`);
      }
      normalized[field] = expression;
    }
    return normalized;
  }

  private validateConstraints(target: string, constraints: unknown): Record<string, Expression> | null {
    if (constraints === undefined || constraints === null) return null;
    if (target !== "action") {
      throw new ScenarioValidationError("constraints are supported only for target 'action'; use update for external-variable tables");
    }
    if (typeof constraints !== "object" || Object.keys(constraints).length === 0) {
      throw new ScenarioValidationError("constraints must be a non-empty object");
    }

    const normalized: Record<string, Expression> = {};
    for (const [field, rawExpression] of Object.entries(constraints as Record<string, unknown>)) {
      if (!(field in ACTION_CONSTRAINTS)) {
        throw new ScenarioValidationError(`Unknown action constraint ${JSON.stringify(field)}. Allowed: ${Object.keys(ACTION_CONSTRAINTS).sort()}`);
      }
      const expression = this.normalizeExpression(rawExpression, ACTION_CONSTRAINTS[field].operators, `constraints.${field}`);

      if (field === "selected" && typeof expression.value !== "boolean") {
        throw new ScenarioValidationError("constraints.selected requires a boolean value");
      }
      if (field === "date" && Number.isNaN(Date.parse(String(expression.value)))) {
        throw new ScenarioValidationError("constraints.date requires a valid date");
      }
      if (field === "start_time" && Number.isNaN(Date.parse(String(expression.value).replace(" ", "T")))) {
        throw new ScenarioValidationError("constraints.start_time requires a valid datetime");
      }

      normalized[field] = expression;
    }
    return normalized;
  }

  validateInterpretation(interpretation: any): ScenarioInterpretation {
    if (typeof interpretation !== "object" || interpretation === null) {
      throw new ScenarioValidationError("LLM interpretation must be a JSON object");
    }

    const mode = String(interpretation.mode ?? "").toLowerCase();
    if (mode !== "explain" && mode !== "scenario") {
      throw new ScenarioValidationError("mode must be 'explain' or 'scenario'");
    }

    const description = String(interpretation.description ?? "");
    const changes = interpretation.changes ?? [];

    if (mode === "explain") {
      return { mode: "explain", description, changes: [] };
    }

    if (!Array.isArray(changes) || changes.length === 0) {
      throw new ScenarioValidationError("Scenario mode requires at least one change");
    }

    const normalized: ScenarioInterpretation = { mode: "scenario", description: description || "Scenario", changes: [] };

    changes.forEach((change: any, index: number) => {
      if (typeof change !== "object" || change === null) {
        throw new ScenarioValidationError(`changes[${index}] must be an object`);
      }

      const target = String(change.target ?? "");
      if (!this.targets().includes(target)) {
        throw new ScenarioValidationError(`Unknown target ${JSON.stringify(target)}. Allowed targets: ${this.targets()}`);
      }

      const where = this.validateWhere(target, change.where ?? {});
      const update = this.validateUpdate(target, change.update);
      const constraints = this.validateConstraints(target, change.constraints);
      if (!update && !constraints) {
        throw new ScenarioValidationError(`changes[${index}] must contain update and/or constraints`);
      }

      const item: ScenarioChange = { target, where };
      if (update) item.update = update;
      if (constraints) item.constraints = constraints;
      normalized.changes.push(item);
    });

    return normalized;
  }
}

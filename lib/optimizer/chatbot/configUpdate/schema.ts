import { CONFIG } from "../../config";

/** Top-level config.yaml sections that are chatbot/LLM plumbing, not optimizer thresholds. */
const EXCLUDED_ROOTS = new Set(["explanation"]);

/** Leaf names whose value is a 0..1 fraction/probability -- out-of-range values would silently break the model. */
const UNIT_INTERVAL_HINTS = ["fraction", "efficacy", "readiness", "index"];

export interface ConfigLeaf {
  path: string[];
  type: "number" | "boolean" | "string";
  value: unknown;
}

export class ConfigValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function listConfigLeaves(node: unknown = CONFIG, prefix: string[] = []): ConfigLeaf[] {
  if (prefix.length === 0 && isPlainObject(node)) {
    const leaves: ConfigLeaf[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (EXCLUDED_ROOTS.has(key)) continue;
      leaves.push(...listConfigLeaves(value, [key]));
    }
    return leaves;
  }

  if (isPlainObject(node)) {
    const leaves: ConfigLeaf[] = [];
    for (const [key, value] of Object.entries(node)) {
      leaves.push(...listConfigLeaves(value, [...prefix, key]));
    }
    return leaves;
  }

  if (typeof node === "number" || typeof node === "boolean" || typeof node === "string") {
    return [{ path: prefix, type: typeof node as "number" | "boolean" | "string", value: node }];
  }

  return [];
}

export function getConfigLeaf(path: string[]): ConfigLeaf | null {
  return listConfigLeaves().find((leaf) => leaf.path.join(".") === path.join(".")) ?? null;
}

export function describeConfigForLlm(): Record<string, unknown> {
  const leaves = listConfigLeaves();
  return {
    purpose: "Numeric/boolean/string thresholds and behavioural parameters the optimizer reads from config.yaml. Editing one of these changes how the model behaves for every future pipeline run.",
    editable_paths: Object.fromEntries(leaves.map((l) => [l.path.join("."), { type: l.type, current_value: l.value }])),
  };
}

/** Validates a proposed {path, value} against the real config, coercing numeric strings. */
export function validateConfigUpdate(pathString: string, rawValue: unknown): { path: string[]; value: number | boolean | string } {
  const path = pathString.split(".");
  const leaf = getConfigLeaf(path);

  if (!leaf) {
    throw new ConfigValidationError(
      `Unknown config path ${JSON.stringify(pathString)}. Available paths: ${listConfigLeaves()
        .map((l) => l.path.join("."))
        .sort()
        .join(", ")}`,
    );
  }

  let value: number | boolean | string;

  if (leaf.type === "number") {
    const n = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (Number.isNaN(n)) throw new ConfigValidationError(`${pathString} requires a numeric value, got ${JSON.stringify(rawValue)}`);
    if (n < 0) throw new ConfigValidationError(`${pathString} cannot be negative`);

    const leafName = path[path.length - 1].toLowerCase();
    if (UNIT_INTERVAL_HINTS.some((hint) => leafName.includes(hint)) && (n < 0 || n > 1)) {
      throw new ConfigValidationError(`${pathString} looks like a 0-1 fraction based on its name; ${n} is out of range`);
    }
    value = n;
  } else if (leaf.type === "boolean") {
    if (typeof rawValue === "boolean") value = rawValue;
    else if (String(rawValue).toLowerCase() === "true") value = true;
    else if (String(rawValue).toLowerCase() === "false") value = false;
    else throw new ConfigValidationError(`${pathString} requires a boolean value, got ${JSON.stringify(rawValue)}`);
  } else {
    value = String(rawValue);
  }

  return { path, value };
}

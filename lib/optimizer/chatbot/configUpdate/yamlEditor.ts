/**
 * Targeted, comment-preserving edits to config.yaml.
 *
 * We deliberately do NOT round-trip through js-yaml.load()+dump() to apply a
 * change -- that would silently drop every comment and could reorder keys.
 * config.yaml is hand-maintained and consistently 2-space indented with only
 * mapping nesting (no lists) down to the leaves we allow editing, so a small
 * indentation-aware line scanner is enough to find and replace exactly one
 * value in place.
 */

export class YamlPathNotFoundError extends Error {}

interface KeyLine {
  lineIndex: number;
  indent: number;
  key: string;
  hasInlineValue: boolean;
}

function parseKeyLine(line: string): KeyLine | null {
  const match = line.match(/^(\s*)([A-Za-z0-9_.-]+):(.*)$/);
  if (!match) return null;

  const [, indentStr, key, rest] = match;
  const afterColon = rest.split("#")[0].trim();
  return { lineIndex: -1, indent: indentStr.length, key, hasInlineValue: afterColon.length > 0 };
}

/**
 * Replaces the scalar value at `pathSegments` (e.g. ["operations","spray",
 * "feasibility","max_wind_kmh"]) with `newValueLiteral` (already formatted as
 * it should appear in YAML, e.g. "15" or "15.0" or "true" or '"herbicide"').
 * Preserves indentation, the key, and any trailing inline comment.
 */
export function setYamlScalarByPath(text: string, pathSegments: string[], newValueLiteral: string): string {
  const lines = text.split("\n");
  const stack: { indent: number; key: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseKeyLine(lines[i]);
    if (!parsed) continue;

    while (stack.length > 0 && stack[stack.length - 1].indent >= parsed.indent) {
      stack.pop();
    }

    const currentPath = [...stack.map((s) => s.key), parsed.key];

    if (parsed.hasInlineValue) {
      if (pathSegments.length === currentPath.length && pathSegments.every((seg, idx) => seg === currentPath[idx])) {
        const line = lines[i];
        const colonIndex = line.indexOf(":");
        const afterColon = line.slice(colonIndex + 1);
        const commentMatch = afterColon.match(/(\s*#.*)$/);
        const comment = commentMatch ? commentMatch[1] : "";
        lines[i] = `${line.slice(0, colonIndex + 1)} ${newValueLiteral}${comment}`;
        return lines.join("\n");
      }
    } else {
      stack.push({ indent: parsed.indent, key: parsed.key });
    }
  }

  throw new YamlPathNotFoundError(`Path not found in config.yaml: ${pathSegments.join(".")}`);
}

/** Formats a JS value as it should be written back into config.yaml. */
export function formatYamlScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Quote only if needed (contains YAML-significant characters or is a reserved word).
    if (/^[A-Za-z0-9_./-]+$/.test(value) && !["true", "false", "null", "~"].includes(value.toLowerCase())) {
      return value;
    }
    return JSON.stringify(value);
  }
  throw new Error(`Unsupported scalar type for YAML edit: ${typeof value}`);
}

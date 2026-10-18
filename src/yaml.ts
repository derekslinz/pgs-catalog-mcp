/**
 * The slice of YAML needed to read and edit one section of a config file.
 *
 * This exists for one harness: Hermes keeps its MCP servers under `mcp_servers`
 * in `~/.hermes/config.yaml`, which is YAML, and it is the only supported
 * client whose config is not JSON.
 *
 * The design is deliberately surgical. Nothing here parses a whole file, and
 * nothing here rewrites a whole file: a section is located by indentation, its
 * value is parsed only when it has to be compared, and a change is made by
 * inserting or replacing that one block. A config file with constructs this
 * module does not understand *elsewhere* is still edited correctly, because
 * those lines are never looked at and never touched.
 *
 * Supported subset: block mappings, block sequences, flow sequences (`[]`),
 * quoted and bare scalars, booleans, numbers, null, and `#` comments.
 */

export interface LineBlock {
  /** Index of the `key:` line. */
  start: number;
  /** Index just past the last line belonging to this block. */
  end: number;
  /** Indentation of the `key:` line. */
  indent: number;
}

/** Index into a line array that never yields `undefined`. */
const lineAt = (lines: string[], index: number): string => lines[index] ?? "";

export const indentOf = (line: string): number => line.length - line.trimStart().length;

const isBlank = (line: string): boolean => line.trim() === "" || line.trimStart().startsWith("#");

/** `key:` at exactly `indent`, tolerating a trailing comment. */
function keyAt(line: string, indent: number): string | undefined {
  if (indentOf(line) !== indent) return undefined;
  const match = /^([^:#]+):(.*)$/.exec(line);
  if (!match) return undefined;
  const key = match[1]!.trim();
  return key === "" ? undefined : key;
}

/**
 * Locate `key` among the direct children of `parent`.
 *
 * Child indentation is read from the file rather than assumed, so a config
 * written with a different indent step is still found. Pass a synthetic parent
 * (`{ start: -1, end: lines.length, indent: -1 }`) to search top-level keys.
 */
export function findChildBlock(
  lines: string[],
  parent: { start: number; end: number; indent: number },
  key: string,
): LineBlock | undefined {
  let childIndent = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    const line = lineAt(lines, i);
    if (isBlank(line)) continue;
    const lineIndent = indentOf(line);
    if (lineIndent <= parent.indent) break;
    if (childIndent === -1) childIndent = lineIndent;
    if (lineIndent > childIndent) continue;
    /* A shallower line ends this group of children; keep looking at that level. */
    if (lineIndent < childIndent) childIndent = lineIndent;
    if (keyAt(line, lineIndent) !== key) continue;
    return { start: i, end: blockEnd(lines, i, parent.end, lineIndent), indent: lineIndent };
  }
  return undefined;
}

/** Where a block starting at `start` (whose key is at `indent`) stops. */
function blockEnd(lines: string[], start: number, to: number, indent: number): number {
  for (let i = start + 1; i < to; i++) {
    const line = lineAt(lines, i);
    if (isBlank(line)) continue;
    if (indentOf(line) <= indent) return i;
  }
  return to;
}

/* ------------------------------------------------------------- scalar parse */

/** Remove a trailing `# comment` that is not inside quotes. */
function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) return text.slice(0, i).trimEnd();
  }
  return text;
}

export class YamlParseError extends Error {}

function parseScalar(text: string): unknown {
  const value = stripComment(text);
  if (value === "" || value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner).map((item) => parseScalar(item));
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    const result: Record<string, unknown> = {};
    if (inner === "") return result;
    for (const pair of splitFlow(inner)) {
      const split = pair.indexOf(":");
      if (split < 0) throw new YamlParseError(`cannot read flow mapping entry "${pair}"`);
      result[String(parseScalar(pair.slice(0, split)))] = parseScalar(pair.slice(split + 1));
    }
    return result;
  }

  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

/** Split `a, b, "c, d"` on top-level commas. */
function splitFlow(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/* -------------------------------------------------------------- block parse */

/** Everything after the first `:` on a `key: value` line, trimmed as YAML does. */
function inlineValue(lines: string[], index: number): string {
  const line = lineAt(lines, index);
  return stripComment(line.slice(line.indexOf(":") + 1)).trim();
}

/** Parse the children of a mapping whose key line is at `indent`. */
function parseMapping(lines: string[], from: number, to: number, indent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let childIndent = -1;
  let i = from;
  while (i < to) {
    const line = lineAt(lines, i);
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent <= indent) break;
    if (childIndent === -1) childIndent = lineIndent;
    if (lineIndent !== childIndent) {
      throw new YamlParseError(`unexpected indentation at line ${i + 1}: "${line}"`);
    }
    const key = keyAt(line, lineIndent);
    if (key === undefined) throw new YamlParseError(`cannot read line ${i + 1}: "${line}"`);

    const inline = inlineValue(lines, i);
    if (inline !== "") {
      result[key] = parseScalar(inline);
      i++;
      continue;
    }

    const child = nextChild(lines, i + 1, to, lineIndent);
    if (child === undefined) {
      result[key] = null;
      i++;
      continue;
    }
    if (child.kind === "sequence") {
      result[key] = parseSequence(lines, child.start, child.end, child.indent);
      i = child.end;
      continue;
    }
    result[key] = parseMapping(lines, child.start, child.end, lineIndent);
    i = child.end;
  }
  return result;
}

type Child = { kind: "sequence" | "mapping"; start: number; end: number; indent: number };

/**
 * Find the first real line under a key and classify it as a sequence or a
 * mapping. `to` is already the end of the enclosing block, so a mapping runs to
 * it: its children are every line until the block itself ends, not just the
 * first one.
 */
function nextChild(lines: string[], from: number, to: number, parentIndent: number): Child | undefined {
  for (let i = from; i < to; i++) {
    const line = lineAt(lines, i);
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    if (indent <= parentIndent) return undefined;
    const trimmed = line.trimStart();
    if (trimmed === "-" || trimmed.startsWith("- ")) {
      return { kind: "sequence", start: i, end: sequenceEnd(lines, i, to, indent), indent };
    }
    return { kind: "mapping", start: i, end: to, indent };
  }
  return undefined;
}

function sequenceEnd(lines: string[], start: number, to: number, indent: number): number {
  for (let i = start + 1; i < to; i++) {
    const line = lineAt(lines, i);
    if (isBlank(line)) continue;
    const lineIndent = indentOf(line);
    if (lineIndent < indent) return i;
    /* Another item at the same indent continues the sequence; anything else ends it. */
    if (lineIndent === indent && !line.trimStart().startsWith("-")) return i;
  }
  return to;
}

function parseSequence(lines: string[], from: number, to: number, indent: number): unknown[] {
  const items: unknown[] = [];
  for (let i = from; i < to; i++) {
    const line = lineAt(lines, i);
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (indentOf(line) !== indent) throw new YamlParseError(`unexpected indentation at line ${i + 1}: "${line}"`);
    if (!trimmed.startsWith("-")) throw new YamlParseError(`expected a list item at line ${i + 1}: "${line}"`);
    /* Space after the dash is part of the syntax, not the value; a quoted value
     * keeps whatever spaces are inside its quotes. */
    items.push(parseScalar(trimmed === "-" ? "" : trimmed.slice(1).trim()));
  }
  return items;
}

/**
 * Read the value of a nested key as data, so it can be compared with the entry
 * we would write. Only that subtree is parsed.
 */
export function readBlockValue(lines: string[], block: LineBlock): unknown {
  const inline = inlineValue(lines, block.start);
  if (inline !== "") return parseScalar(inline);
  const child = nextChild(lines, block.start + 1, block.end, block.indent);
  if (child === undefined) return null;
  if (child.kind === "sequence") return parseSequence(lines, child.start, child.end, child.indent);
  return parseMapping(lines, child.start, child.end, block.indent);
}

/** Whether a key carries its value on the same line (`key: []`, `key: null`). */
export function hasInlineValue(lines: string[], block: LineBlock): boolean {
  return inlineValue(lines, block.start) !== "";
}

/** Index just past the last line of a block. */
export function blockEndOf(lines: string[], block: LineBlock): number {
  return blockEnd(lines, block.start, lines.length, block.indent);
}

/* ------------------------------------------------------------- scalar write */

/** A scalar that YAML reads back as the same string with no quotes needed. */
function isSafeBare(value: string): boolean {
  if (value === "") return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return false;
  if (/[:#](\s|$)/.test(value)) return false;
  if (/\s$/.test(value)) return false;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(value)) return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return false;
  return !/[\n\r\t]/.test(value);
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  return isSafeBare(text) ? text : JSON.stringify(text);
}

/**
 * Render one `key: value` block in the block style Hermes itself writes.
 * String values are quoted when `quoteScalars` is set, which is what an `env`
 * map needs: a bare `90` would come back as a number.
 */
export function renderBlock(key: string, value: unknown, indent: number, quoteScalars = false): string {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return `${pad}${key}:\n`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${key}: []\n`;
    let out = `${pad}${key}:\n`;
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        /* A mapping item: its first key goes on the dash line, the rest follow. */
        const rendered = renderBlock("", item, indent + 2, quoteScalars)
          .split("\n")
          .filter((entry) => entry !== "");
        out += `${pad}  - ${rendered[0]!.trimStart()}\n`;
        for (const entry of rendered.slice(1)) out += `${entry}\n`;
        continue;
      }
      const scalar = quoteScalars && typeof item === "string" ? JSON.stringify(item) : renderScalar(item);
      out += `${pad}  - ${scalar}\n`;
    }
    return out;
  }

  if (typeof value === "object") {
    let out = `${pad}${key}:\n`;
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out += renderBlock(childKey, childValue, indent + 2, quoteScalars || childKey === "env");
    }
    return out;
  }

  const scalar = quoteScalars && typeof value === "string" ? JSON.stringify(value) : renderScalar(value);
  return `${pad}${key}: ${scalar}\n`;
}

/* ------------------------------------------------------------------ helpers */

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function joinLines(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

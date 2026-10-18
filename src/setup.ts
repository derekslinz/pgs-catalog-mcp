#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HARNESS_IDS,
  HARNESS_REGISTRY,
  SERVER_KEY,
  detectInstalledHarnesses,
  resolveHarnessId,
  type HarnessId,
  type HarnessTarget,
  type ResolveContext,
} from "./harnesses.js";
import {
  YamlParseError,
  blockEndOf,
  findChildBlock,
  hasInlineValue,
  indentOf,
  joinLines,
  readBlockValue,
  renderBlock,
  splitLines,
  type LineBlock,
} from "./yaml.js";

export interface SetupOptions {
  harnesses: HarnessId[];
  scope?: "project" | "user";
  write: boolean;
  json: boolean;
  dryRun: boolean;
  force: boolean;
  backup: boolean;
  commandMode: "auto" | "npx" | "custom";
  command?: string;
  pathOverride?: string;
  env: Record<string, string>;
}

export interface StdioEntry {
  type?: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Hermes writes this explicitly; `hermes mcp add` does too. */
  enabled?: true;
}

/** OpenCode merges command and arguments into one array and calls env `environment`. */
export interface LocalEntry {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
}

export type ServerEntry = StdioEntry | LocalEntry;

export interface SetupPlan {
  harness: HarnessId;
  name: string;
  target: HarnessTarget;
  /** Merged view of the config, as an object. This is what `--json` prints. */
  document: Record<string, unknown>;
  entry: ServerEntry;
  /** Present for a YAML target: the whole file as it will be written. */
  yamlText?: string;
  notes: string[];
  action: "create" | "add" | "replace" | "unchanged" | "conflict";
  existingEntry?: unknown;
  /** Why a conflict happened, when the reason is not the usual "already exists". */
  reason?: string;
}

/* ------------------------------------------------------------------ paths */

/** Absolute path of this package's built server entry point. */
export function serverEntryPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
}

export function buildContext(overrides: Partial<ResolveContext> = {}): ResolveContext {
  const home = overrides.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  return {
    cwd: overrides.cwd ?? process.cwd(),
    home,
    env: overrides.env ?? process.env,
    vscodeUserDataDir: overrides.vscodeUserDataDir,
    fileExists: overrides.fileExists ?? ((p: string) => existsSync(p)),
  };
}

/* -------------------------------------------------------------- entry JSON */

/**
 * Decide how a harness should launch this server.
 *
 * A checked-out clone gets an absolute `node /abs/dist/index.js` entry, which
 * works immediately with no install step. Anything else gets `npx -y
 * pgs-catalog-mcp`, which is the right shape once the package is published.
 */
export function resolveCommand(
  options: Pick<SetupOptions, "commandMode" | "command">,
  ctx: ResolveContext,
): { command: string; args: string[] } {
  if (options.commandMode === "custom" && options.command) {
    const [command, ...args] = options.command.split(/\s+/);
    if (!command) throw new Error("--command needs a value");
    return { command, args };
  }

  if (options.commandMode === "npx") {
    return { command: "npx", args: ["-y", "pgs-catalog-mcp"] };
  }

  const entry = serverEntryPath();
  if (ctx.fileExists(entry)) {
    /* process.execPath is the absolute path of the interpreter running this
     * command, so the entry does not depend on the harness's PATH. */
    return { command: process.execPath, args: [entry] };
  }
  return { command: "npx", args: ["-y", "pgs-catalog-mcp"] };
}

export function buildEntry(target: HarnessTarget, options: SetupOptions, ctx: ResolveContext): ServerEntry {
  const { command, args } = resolveCommand(options, ctx);
  const env = Object.keys(options.env).length > 0 ? { ...options.env } : undefined;

  /* Key order is deliberate: what a reader of the config file expects to see. */
  if (target.shape === "opencode-local") {
    const entry: LocalEntry = { type: "local", command: [command, ...args] };
    if (env) entry.environment = env;
    return entry;
  }

  const entry: StdioEntry = target.shape === "typed" ? { type: "stdio", command, args } : { command, args };
  /* Hermes treats a missing `enabled` as enabled, but writes it explicitly, and
   * so do we: an entry that says it is on is easier to reason about. */
  if (target.format === "yaml") entry.enabled = true;
  if (env) entry.env = env;
  return entry;
}

/* ------------------------------------------------------------------ merge */

export function readConfigFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} is not valid JSON. Fix or remove it before running setup; this tool will not overwrite a file it cannot parse.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Compare two entries for equality regardless of the order their keys happen to
 * be written in. A real difference — an extra `tools` filter Hermes added, a
 * different path — is still a difference.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

const sameEntry = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Insert the entry without touching anything else in the file: other top-level
 * settings, other servers, and key order are all preserved.
 */
export function mergeInto(
  existing: Record<string, unknown> | undefined,
  target: HarnessTarget,
  entry: ServerEntry,
  force: boolean,
): { document: Record<string, unknown>; action: SetupPlan["action"] } {
  const document: Record<string, unknown> = existing ? { ...existing } : {};
  const currentSection = isRecord(document[target.key]) ? { ...(document[target.key] as Record<string, unknown>) } : {};
  const existingEntry = currentSection[SERVER_KEY];

  let action: SetupPlan["action"];
  if (!existing) {
    action = "create";
  } else if (existingEntry === undefined) {
    action = "add";
  } else if (sameEntry(existingEntry, entry)) {
    action = "unchanged";
  } else if (force) {
    action = "replace";
  } else {
    action = "conflict";
  }

  if (action !== "conflict" && action !== "unchanged") {
    currentSection[SERVER_KEY] = entry;
  }
  if (document[target.key] === undefined || action !== "unchanged") {
    document[target.key] = currentSection;
  }

  return { document, action };
}

/* ------------------------------------------------------------- yaml merging */

export interface MergeResult {
  action: SetupPlan["action"];
  existingEntry?: unknown;
  /** Why a merge was refused, when "the entry already exists" is not the reason. */
  reason?: string;
}

/**
 * Insert the entry into a YAML config by editing one block.
 *
 * The file is kept as lines: everything outside the section being edited is
 * copied through byte for byte, including comments and constructs this module
 * does not model. Only the target section and the entry inside it change.
 */
export function mergeIntoYaml(source: string, target: HarnessTarget, entry: ServerEntry, force: boolean): { text: string } & MergeResult {
  const lines = splitLines(source);
  const root = { start: -1, end: lines.length, indent: -1 };
  const section = findChildBlock(lines, root, target.key);

  if (!section) {
    const text = joinLines([...lines, ...splitLines(renderBlock(target.key, { [SERVER_KEY]: entry }, 0))]);
    return { text, action: lines.length === 0 ? "create" : "add" };
  }

  const sectionEnd = blockEndOf(lines, section);

  /* `mcp_servers: {}` or `mcp_servers: null` on one line: there is nowhere to
   * add a child, so the line itself has to become a block. */
  if (hasInlineValue(lines, section)) {
    const inline = readBlockValue(lines, section);
    const empty = inline === null || (isRecord(inline) && Object.keys(inline).length === 0) || (Array.isArray(inline) && inline.length === 0);
    if (!empty) {
      return {
        text: source,
        action: "conflict",
        reason: `${target.key} in ${target.path} holds a value this tool cannot merge into. Add "${SERVER_KEY}" under it by hand.`,
      };
    }
    const replacement = splitLines(renderBlock(target.key, { [SERVER_KEY]: entry }, section.indent));
    return { text: joinLines([...lines.slice(0, section.start), ...replacement, ...lines.slice(sectionEnd)]), action: "add" };
  }

  const child = findChildBlock(lines, section, SERVER_KEY);
  if (!child) {
    const indent = childIndentOf(lines, section, sectionEnd);
    const insertion = splitLines(renderBlock(SERVER_KEY, entry, indent));
    return { text: joinLines([...lines.slice(0, sectionEnd), ...insertion, ...lines.slice(sectionEnd)]), action: "add" };
  }

  const existingEntry = readBlockValue(lines, child);
  const childEnd = blockEndOf(lines, child);

  if (sameEntry(existingEntry, entry)) {
    return { text: source, action: "unchanged", existingEntry };
  }
  if (!force) {
    return { text: source, action: "conflict", existingEntry };
  }

  const replacement = splitLines(renderBlock(SERVER_KEY, entry, child.indent));
  return { text: joinLines([...lines.slice(0, child.start), ...replacement, ...lines.slice(childEnd)]), action: "replace", existingEntry };
}

/** Indentation used by the children of a section, or a sensible default. */
function childIndentOf(lines: string[], section: LineBlock, sectionEnd: number): number {
  for (let i = section.start + 1; i < sectionEnd; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    return indentOf(line);
  }
  return section.indent + 2;
}

/* ------------------------------------------------------------------- plan */

export function planFor(harness: HarnessId, options: SetupOptions, ctx: ResolveContext): SetupPlan {
  const def = HARNESS_REGISTRY[harness];
  if (!def) throw new Error(`Unknown harness: ${harness}`);
  const scope = options.scope && def.scopes.includes(options.scope) ? options.scope : def.defaultScope;
  const target = def.resolve(scope, ctx);
  if (options.pathOverride) target.path = resolve(ctx.cwd, options.pathOverride);

  const entry = buildEntry(target, options, ctx);
  /* Always read the target file, even in print-only mode: reporting the real
   * action (create / add / replace / unchanged) is the point of the preview. */
  if (target.format === "yaml") return planForYaml(def, target, entry, options);

  const existing = readConfigFile(target.path);
  const { document, action } = mergeInto(existing, target, entry, options.force);

  return {
    harness,
    name: def.name,
    target,
    document,
    entry,
    notes: [...def.notes, ...configWarnings(harness, existing, target)],
    action,
    existingEntry: isRecord(existing?.[target.key]) ? (existing![target.key] as Record<string, unknown>)[SERVER_KEY] : undefined,
  };
}

/**
 * Things in a config file that are not this entry's business but will stop the
 * client from starting. Worth saying before someone writes the file and wonders
 * why the client refuses to read it.
 */
function configWarnings(harness: HarnessId, existing: Record<string, unknown> | undefined, target: HarnessTarget): string[] {
  const section = isRecord(existing?.[target.key]) ? (existing![target.key] as Record<string, unknown>) : undefined;
  if (!section) return [];

  if (harness === "opencode" && isRecord(section.servers)) {
    return [
      `This file already has "${target.key}.servers", which OpenCode 1.x rejects: every entry must sit directly under "${target.key}". Move the servers out of that block before OpenCode will read this file.`,
    ];
  }
  return [];
}

function planForYaml(
  def: (typeof HARNESS_REGISTRY)[HarnessId],
  target: HarnessTarget,
  entry: ServerEntry,
  options: SetupOptions,
): SetupPlan {
  const source = existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined;

  if (source === undefined) {
    return {
      harness: def.id,
      name: def.name,
      target,
      document: { [target.key]: { [SERVER_KEY]: entry } },
      entry,
      yamlText: renderBlock(target.key, { [SERVER_KEY]: entry }, 0),
      notes: def.notes,
      action: "create",
    };
  }

  /* A YAML file this tool cannot read is left completely alone. */
  let merged: { text: string } & MergeResult;
  try {
    merged = mergeIntoYaml(source, target, entry, options.force);
  } catch (error) {
    if (!(error instanceof YamlParseError)) throw error;
    throw new Error(
      `${target.path} could not be read as YAML (${error.message}). Fix it before running setup; this tool will not overwrite a file it cannot parse.`,
    );
  }

  return {
    harness: def.id,
    name: def.name,
    target,
    /* For a YAML target, `--json` prints the section being written rather than
     * the whole file: the rest of the file is YAML and stays YAML. */
    document: { [target.key]: { [SERVER_KEY]: merged.action === "conflict" ? merged.existingEntry : entry } },
    entry,
    yamlText: merged.text,
    notes: def.notes,
    action: merged.action,
    existingEntry: merged.existingEntry,
    reason: merged.reason,
  };
}

export function writePlan(plan: SetupPlan, options: SetupOptions): void {
  const serialized = plan.yamlText ?? `${JSON.stringify(plan.document, null, 2)}\n`;
  if (existsSync(plan.target.path) && options.backup) {
    writeFileSync(`${plan.target.path}.bak`, readFileSync(plan.target.path));
  }
  mkdirSync(dirname(plan.target.path), { recursive: true });
  writeFileSync(plan.target.path, serialized, "utf8");
}

/* -------------------------------------------------------------------- CLI */

const USAGE = `Usage: pgscatalog-mcp setup [harness...] [options]

Install the PGS Catalog MCP server into one or more MCP harnesses, or print the
JSON that would be written.

Harnesses:
  claude-code      Claude Code          .mcp.json / ~/.claude.json
  claude-desktop   Claude Desktop       claude_desktop_config.json
  cursor           Cursor               .cursor/mcp.json
  vscode           VS Code / Copilot    .mcp.json, .vscode/mcp.json, or the user mcp.json
  copilot          GitHub Copilot CLI   .copilot/mcp-config.json
  gemini           Gemini CLI           .gemini/settings.json / ~/.gemini/settings.json
  opencode         OpenCode             opencode.json / ~/.config/opencode/opencode.json
  hermes           Hermes               ~/.hermes/config.yaml (YAML, user scope only)

Options:
  --harness <id>        Target a harness. Repeatable.
  --auto                Detect installed harnesses and set up each one (default).
  --all                 Set up every supported harness.
  --scope <s>           project | user (default: each harness's own default).
  --print               Print the config JSON to stdout (default when not writing).
  --json                Print only the JSON, for piping into a file.
  --write             Merge the entry into the harness config file.
  --dry-run             Preview only; cancels --write.
  --force             Replace an existing entry named "${SERVER_KEY}".
  --no-backup         Do not write a .bak copy before modifying a file.
  --command <mode>      auto (default) | npx | "<literal command>"
  --path <path>         Override the target config file.
  --env KEY=VALUE       Environment for the server process. Repeatable.
  --base-url <url>      Shortcut for --env PGS_CATALOG_BASE_URL=<url>
  --rate-limit <n>      Shortcut for --env PGS_CATALOG_RATE_LIMIT=<n>
  --timeout <ms>        Shortcut for --env PGS_CATALOG_TIMEOUT_MS=<ms>
  -h, --help            Show this help.

Nothing is written unless --write is given. Existing files are merged, never
rewritten from scratch, and a .bak copy is kept unless --no-backup is set.
Hermes' config.yaml is edited in place: only its mcp_servers section changes.
`;

export interface ParsedArgs {
  options: SetupOptions;
  help: boolean;
  error?: string;
}

export function parseArgs(argv: string[], ctxOverride?: ResolveContext): ParsedArgs {
  const options: SetupOptions = {
    harnesses: [],
    write: false,
    json: false,
    dryRun: false,
    force: false,
    backup: true,
    commandMode: "auto",
    env: {},
  };
  let help = false;
  let auto = false;
  let all = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--harness": {
        const id = resolveHarnessId(next());
        if (!id) return { options, help, error: `Unknown harness "${argv[i - 1]}". Supported: ${HARNESS_IDS.join(", ")}` };
        options.harnesses.push(id);
        break;
      }
      case "--auto":
        auto = true;
        break;
      case "--all":
        all = true;
        break;
      case "--scope": {
        const scope = next();
        if (scope !== "project" && scope !== "user") {
          return { options, help, error: `--scope must be "project" or "user"` };
        }
        options.scope = scope;
        break;
      }
      case "--print":
        options.json = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--write":
        options.write = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--no-backup":
        options.backup = false;
        break;
      case "--command": {
        const value = next();
        options.commandMode = value === "auto" || value === "npx" ? value : "custom";
        if (options.commandMode === "custom") options.command = value;
        break;
      }
      case "--path":
        options.pathOverride = next();
        break;
      case "--env": {
        const pair = next();
        const eq = pair.indexOf("=");
        if (eq <= 0) return { options, help, error: `--env expects KEY=VALUE, got "${pair}"` };
        options.env[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case "--base-url":
        options.env.PGS_CATALOG_BASE_URL = next();
        break;
      case "--rate-limit":
        options.env.PGS_CATALOG_RATE_LIMIT = next();
        break;
      case "--timeout":
        options.env.PGS_CATALOG_TIMEOUT_MS = next();
        break;
      default: {
        const id = resolveHarnessId(String(arg));
        if (id) {
          options.harnesses.push(id);
          break;
        }
        return { options, help, error: `Unknown argument "${arg}"` };
      }
    }
  }

  if (help) return { options, help: true };

  if (options.harnesses.length === 0) {
    if (all) options.harnesses = [...HARNESS_IDS];
    else if (auto || options.harnesses.length === 0) {
      const ctx = ctxOverride ?? buildContext();
      options.harnesses = detectInstalledHarnesses(ctx);
      if (options.harnesses.length === 0) {
        return {
          options,
          help: false,
          error:
            "No supported harness config directory was found on this machine. Name one with --harness <id>, or use --all to write every supported config file.",
        };
      }
    }
  }

  if (options.harnesses.length > 1 && options.pathOverride) {
    return { options, help: false, error: "--path can only be used with a single harness" };
  }

  return { options, help: false };
}

const ACTION_TEXT: Record<SetupPlan["action"], string> = {
  create: "would create",
  add: "would add to",
  replace: "would replace the existing entry in",
  unchanged: "already configured in",
  conflict: "left untouched in",
};

const WRITTEN_TEXT: Record<SetupPlan["action"], string> = {
  create: "created",
  add: "added to",
  replace: "replaced the existing entry in",
  unchanged: "already configured in",
  conflict: "left untouched in",
};

export function renderPlan(plan: SetupPlan, options: SetupOptions): string {
  const actionText = options.write ? WRITTEN_TEXT[plan.action] : ACTION_TEXT[plan.action];
  const lines: string[] = [];
  lines.push(`${plan.name} — ${plan.target.label}`);
  lines.push(`  file: ${plan.target.path}`);
  lines.push(`  key:  ${plan.target.key}.${SERVER_KEY}`);
  lines.push(`  ${actionText} (${plan.action})`);
  lines.push("");
  /* Show the target in the syntax the target actually uses. */
  if (plan.target.format === "yaml") {
    const block =
      plan.action === "create" || plan.action === "add"
        ? renderBlock(plan.target.key, { [SERVER_KEY]: plan.entry }, 0)
        : renderBlock(SERVER_KEY, plan.entry, 2);
    lines.push(block.trimEnd());
  } else {
    lines.push(JSON.stringify({ [plan.target.key]: { [SERVER_KEY]: plan.entry } }, null, 2));
  }
  if (plan.notes.length > 0) {
    lines.push("");
    for (const note of plan.notes) lines.push(`  note: ${note}`);
  }
  return lines.join("\n");
}

export async function runSetup(argv: string[], ctxOverride?: ResolveContext): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, ctxOverride);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const { options } = parsed;
  /* Preview is already the default, so --dry-run is only meaningful as an
   * explicit override: it cancels --write. */
  if (options.dryRun) options.write = false;
  const ctx = ctxOverride ?? buildContext();
  const plans: SetupPlan[] = [];
  let failed = false;

  for (const harness of options.harnesses) {
    try {
      const plan = planFor(harness, options, ctx);
      plans.push(plan);

      if (options.json) {
        // Machine-readable mode: one merged document per invocation, or a map
        // keyed by harness when several were requested.
        continue;
      }

      process.stdout.write(`${renderPlan(plan, options)}\n\n`);

      if (options.write && plan.action !== "unchanged" && plan.action !== "conflict") {
        writePlan(plan, options);
        process.stdout.write(`  wrote ${plan.target.path}${options.backup ? ` (previous copy: ${plan.target.path}.bak)` : ""}\n\n`);
      } else if (options.write && plan.action === "conflict") {
        process.stderr.write(
          `  skipped: ${plan.reason ?? `${plan.target.path} already has a "${SERVER_KEY}" entry. Re-run with --force to replace it.`}\n\n`,
        );
        failed = true;
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      failed = true;
    }
  }

  if (options.json && plans.length > 0) {
    const documents =
      plans.length === 1
        ? plans[0]!.document
        : Object.fromEntries(plans.map((plan) => [plan.harness, plan.document]));
    process.stdout.write(`${JSON.stringify(documents, null, 2)}\n`);

    if (options.write) {
      for (const plan of plans) {
        if (plan.action === "unchanged" || plan.action === "conflict") continue;
        try {
          writePlan(plan, options);
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          failed = true;
        }
      }
    }
  }

  if (!options.json && options.write) {
    process.stdout.write("Restart or reload the client to pick up the new server.\n");
  }

  return failed ? 1 : 0;
}

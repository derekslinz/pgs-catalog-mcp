import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HARNESS_IDS, HARNESS_REGISTRY, SERVER_KEY, detectInstalledHarnesses, resolveHarnessId } from "../dist/harnesses.js";
import { buildContext, buildEntry, mergeInto, mergeIntoYaml, parseArgs, planFor, readConfigFile, resolveCommand, runSetup } from "../dist/setup.js";
import { findChildBlock, readBlockValue, renderBlock, splitLines } from "../dist/yaml.js";

/* ---------------------------------------------------------------- helpers */

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "pgscat-setup-"));
  const home = join(root, "home");
  const cwd = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd, ctx: buildContext({ home, cwd, env: {} }) };
}

const baseOptions = (overrides = {}) => ({
  harnesses: [],
  write: false,
  json: false,
  dryRun: false,
  force: false,
  backup: true,
  commandMode: "npx",
  env: {},
  ...overrides,
});

/* ------------------------------------------------------- harness identity */

test("every harness id resolves, including common aliases", () => {
  for (const id of HARNESS_IDS) {
    assert.equal(resolveHarnessId(id), id);
    assert.equal(resolveHarnessId(id.toUpperCase()), id);
  }
  assert.equal(resolveHarnessId("claude"), "claude-code");
  assert.equal(resolveHarnessId("Claude Code"), "claude-code");
  assert.equal(resolveHarnessId("gemini_cli"), "gemini");
  assert.equal(resolveHarnessId("desktop"), "claude-desktop");
  assert.equal(resolveHarnessId("open-code"), "opencode");
  assert.equal(resolveHarnessId("OpenCode"), "opencode");
  assert.equal(resolveHarnessId("hermes"), "hermes");
  assert.equal(resolveHarnessId("nope"), undefined);
});

/* ------------------------------------------------- per-harness file shape */

test("claude-code project scope writes .mcp.json with mcpServers and type", () => {
  const { cwd, ctx } = sandbox();
  const target = HARNESS_REGISTRY["claude-code"].resolve("project", ctx);
  assert.equal(target.path, join(cwd, ".mcp.json"));
  assert.equal(target.key, "mcpServers");
  assert.equal(target.shape, "typed");
});

test("claude-code user scope honours CLAUDE_CONFIG_DIR", () => {
  const { home, ctx } = sandbox();
  const withDir = buildContext({ ...ctx, env: { CLAUDE_CONFIG_DIR: join(home, "cfg") } });
  assert.equal(HARNESS_REGISTRY["claude-code"].resolve("user", withDir).path, join(home, "cfg/.claude.json"));
  assert.equal(HARNESS_REGISTRY["claude-code"].resolve("user", ctx).path, join(home, ".claude.json"));
});

test("claude-desktop targets claude_desktop_config.json under the platform dir", () => {
  const { home, ctx } = sandbox();
  const target = HARNESS_REGISTRY["claude-desktop"].resolve("user", ctx);
  assert.ok(target.path.endsWith("claude_desktop_config.json"));
  assert.ok(target.path.startsWith(home));
  assert.equal(target.key, "mcpServers");
  assert.deepEqual(HARNESS_REGISTRY["claude-desktop"].scopes, ["user"]);
});

test("cursor project and user scopes both use .cursor/mcp.json", () => {
  const { cwd, home, ctx } = sandbox();
  assert.equal(HARNESS_REGISTRY.cursor.resolve("project", ctx).path, join(cwd, ".cursor/mcp.json"));
  assert.equal(HARNESS_REGISTRY.cursor.resolve("user", ctx).path, join(home, ".cursor/mcp.json"));
});

test("vscode prefers .vscode/mcp.json with the servers key when that dir exists", () => {
  const { cwd, ctx } = sandbox();
  mkdirSync(join(cwd, ".vscode"), { recursive: true });
  const target = HARNESS_REGISTRY.vscode.resolve("project", ctx);
  assert.equal(target.path, join(cwd, ".vscode/mcp.json"));
  assert.equal(target.key, "servers");
});

test("vscode falls back to the portable .mcp.json with mcpServers", () => {
  const { cwd, ctx } = sandbox();
  const target = HARNESS_REGISTRY.vscode.resolve("project", ctx);
  assert.equal(target.path, join(cwd, ".mcp.json"));
  assert.equal(target.key, "mcpServers");
});

test("vscode user scope resolves the editor userData directory", () => {
  const { ctx } = sandbox();
  const override = buildContext({ ...ctx, vscodeUserDataDir: "/tmp/vscode-user-data" });
  const target = HARNESS_REGISTRY.vscode.resolve("user", override);
  assert.equal(target.path, "/tmp/vscode-user-data/mcp.json");
  assert.equal(target.key, "servers");
});

test("gemini writes settings.json under .gemini for both scopes", () => {
  const { cwd, home, ctx } = sandbox();
  assert.equal(HARNESS_REGISTRY.gemini.resolve("project", ctx).path, join(cwd, ".gemini/settings.json"));
  assert.equal(HARNESS_REGISTRY.gemini.resolve("user", ctx).path, join(home, ".gemini/settings.json"));
});

test("opencode uses the mcp key and the local entry shape in both scopes", () => {
  const { cwd, home, ctx } = sandbox();
  const project = HARNESS_REGISTRY.opencode.resolve("project", ctx);
  assert.equal(project.path, join(cwd, "opencode.json"));
  assert.equal(project.key, "mcp");
  assert.equal(project.shape, "opencode-local");

  const global = HARNESS_REGISTRY.opencode.resolve("user", ctx);
  assert.equal(global.path, join(home, ".config/opencode/opencode.json"));
  assert.equal(global.key, "mcp");
});

test("opencode honours OPENCODE_CONFIG and XDG_CONFIG_HOME", () => {
  const { home, ctx } = sandbox();
  const withCustom = buildContext({ ...ctx, env: { OPENCODE_CONFIG: join(home, "my-oc.json") } });
  assert.equal(HARNESS_REGISTRY.opencode.resolve("user", withCustom).path, join(home, "my-oc.json"));

  const withXdg = buildContext({ ...ctx, env: { XDG_CONFIG_HOME: join(home, "xdg") } });
  assert.equal(HARNESS_REGISTRY.opencode.resolve("user", withXdg).path, join(home, "xdg/opencode/opencode.json"));
});

test("hermes targets config.yaml under the Hermes home, user scope only", () => {
  const { home, ctx } = sandbox();
  const target = HARNESS_REGISTRY.hermes.resolve("user", ctx);
  assert.equal(target.path, join(home, ".hermes/config.yaml"));
  assert.equal(target.key, "mcp_servers");
  assert.equal(target.format, "yaml");
  assert.deepEqual(HARNESS_REGISTRY.hermes.scopes, ["user"]);

  const withHome = buildContext({ ...ctx, env: { HERMES_HOME: join(home, "custom-hermes") } });
  assert.equal(HARNESS_REGISTRY.hermes.resolve("user", withHome).path, join(home, "custom-hermes/config.yaml"));
});

/* --------------------------------------------------------- entry building */

test("typed harnesses get an explicit stdio type, plain harnesses do not", () => {
  const { ctx } = sandbox();
  const typed = HARNESS_REGISTRY["claude-code"].resolve("project", ctx);
  const plain = HARNESS_REGISTRY.copilot.resolve("user", ctx);
  const typedEntry = buildEntry(typed, baseOptions(), ctx);
  const plainEntry = buildEntry(plain, baseOptions(), ctx);
  assert.equal(typedEntry.type, "stdio");
  assert.deepEqual(Object.keys(typedEntry), ["type", "command", "args"]);
  assert.equal(plainEntry.type, undefined);
  assert.deepEqual(Object.keys(plainEntry), ["command", "args"]);
});

test("opencode merges command and args into one array and names env `environment`", () => {
  const { ctx } = sandbox();
  const target = HARNESS_REGISTRY.opencode.resolve("project", ctx);
  const entry = buildEntry(target, baseOptions({ commandMode: "auto", env: { PGS_CATALOG_RATE_LIMIT: "30" } }), ctx);
  assert.equal(entry.type, "local");
  assert.ok(Array.isArray(entry.command));
  assert.equal(entry.command.length, 2);
  assert.ok(entry.command[0].length > 0);
  assert.ok(entry.command[1].endsWith("/dist/index.js"));
  assert.equal(entry.args, undefined);
  assert.deepEqual(entry.environment, { PGS_CATALOG_RATE_LIMIT: "30" });
  assert.deepEqual(Object.keys(entry), ["type", "command", "environment"]);
});

test("hermes entries carry an explicit enabled flag", () => {
  const { ctx } = sandbox();
  const target = HARNESS_REGISTRY.hermes.resolve("user", ctx);
  const entry = buildEntry(target, baseOptions(), ctx);
  assert.equal(entry.enabled, true);
  assert.equal(entry.type, undefined);
  assert.deepEqual(Object.keys(entry), ["command", "args", "enabled"]);
});

test("npx mode is used when the built entry point is absent", () => {
  const { ctx } = sandbox();
  const { command, args } = resolveCommand({ commandMode: "npx" }, ctx);
  assert.equal(command, "npx");
  assert.deepEqual(args, ["-y", "pgs-catalog-mcp"]);
});

test("auto mode uses an absolute interpreter and entry path when built", () => {
  const { ctx } = sandbox();
  const { command, args } = resolveCommand({ commandMode: "auto" }, ctx);
  assert.ok(command.length > 0);
  assert.ok(args[0].endsWith("/dist/index.js"));
  assert.ok(args[0].startsWith("/"));
});

test("a literal --command is split into command and args", () => {
  const { ctx } = sandbox();
  const { command, args } = resolveCommand({ commandMode: "custom", command: "docker run -i --rm pgs" }, ctx);
  assert.equal(command, "docker");
  assert.deepEqual(args, ["run", "-i", "--rm", "pgs"]);
});

test("env options are attached to the entry", () => {
  const { ctx } = sandbox();
  const target = HARNESS_REGISTRY.copilot.resolve("user", ctx);
  const entry = buildEntry(target, baseOptions({ env: { PGS_CATALOG_RATE_LIMIT: "30" } }), ctx);
  assert.deepEqual(entry.env, { PGS_CATALOG_RATE_LIMIT: "30" });
});

/* ------------------------------------------------------------- merging */

test("merge creates a new document when no file exists", () => {
  const target = { path: "/nope/mcp.json", key: "mcpServers", shape: "plain", label: "x" };
  const { document, action } = mergeInto(undefined, target, { command: "node", args: ["a"] }, false);
  assert.equal(action, "create");
  assert.deepEqual(document, { mcpServers: { [SERVER_KEY]: { command: "node", args: ["a"] } } });
});

test("merge preserves other servers and unrelated top-level keys", () => {
  const target = { path: "x", key: "mcpServers", shape: "plain", label: "x" };
  const existing = {
    mcpServers: { other: { command: "echo" } },
    otherSetting: true,
    version: 2,
  };
  const { document, action } = mergeInto(existing, target, { command: "node", args: ["a"] }, false);
  assert.equal(action, "add");
  assert.deepEqual(document.other, undefined);
  assert.deepEqual(document.mcpServers, { other: { command: "echo" }, [SERVER_KEY]: { command: "node", args: ["a"] } });
  assert.equal(document.otherSetting, true);
  assert.equal(document.version, 2);
});

test("merge reports unchanged and leaves the entry alone", () => {
  const target = { path: "x", key: "mcpServers", shape: "plain", label: "x" };
  const entry = { command: "node", args: ["a"] };
  const { document, action } = mergeInto({ mcpServers: { [SERVER_KEY]: entry } }, target, entry, false);
  assert.equal(action, "unchanged");
  assert.deepEqual(document, { mcpServers: { [SERVER_KEY]: entry } });
});

test("merge reports conflict without --force and replaces with it", () => {
  const target = { path: "x", key: "mcpServers", shape: "plain", label: "x" };
  const existing = { mcpServers: { [SERVER_KEY]: { command: "old" } } };
  const entry = { command: "node", args: ["a"] };

  const soft = mergeInto(existing, target, entry, false);
  assert.equal(soft.action, "conflict");
  assert.deepEqual(soft.document, existing);

  const hard = mergeInto(existing, target, entry, true);
  assert.equal(hard.action, "replace");
  assert.deepEqual(hard.document.mcpServers[SERVER_KEY], entry);
});

test("merge creates the servers key when the file has other keys only", () => {
  const target = { path: "x", key: "servers", shape: "typed", label: "x" };
  const { document, action } = mergeInto({ inputs: [] }, target, { type: "stdio", command: "n", args: [] }, false);
  assert.equal(action, "add");
  assert.deepEqual(document, { inputs: [], servers: { [SERVER_KEY]: { type: "stdio", command: "n", args: [] } } });
});

test("readConfigFile rejects malformed JSON instead of overwriting it", () => {
  const { root } = sandbox();
  const file = join(root, "broken.json");
  writeFileSync(file, "not json");
  assert.throws(() => readConfigFile(file), /not valid JSON/);
});

test("readConfigFile treats an empty file as an empty document", () => {
  const { root } = sandbox();
  const file = join(root, "empty.json");
  writeFileSync(file, "   \n");
  assert.deepEqual(readConfigFile(file), {});
});

test("readConfigFile returns undefined for a missing file", () => {
  assert.equal(readConfigFile("/definitely/not/here.json"), undefined);
});

/* ------------------------------------------------------------ yaml merging */

const yamlTarget = { path: "cfg.yaml", key: "mcp_servers", shape: "plain", label: "x", format: "yaml" };
const yamlEntry = { command: "/usr/bin/node", args: ["/srv/index.js"], enabled: true };

test("yaml merge appends the section when the file has none", () => {
  const source = "model:\n  default: gpt\nplugins:\n  enabled:\n    - homeassistant\n";
  const { text, action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(action, "add");
  assert.ok(text.startsWith("model:\n  default: gpt\n"), "existing content must be untouched");
  assert.ok(text.includes("plugins:\n  enabled:\n    - homeassistant\n"), "later sections must survive");
  assert.ok(text.includes("  pgs-catalog:\n    command: /usr/bin/node"));
});

test("yaml merge preserves comments and constructs it does not model", () => {
  const source = [
    "# a comment explaining a setting",
    "model: gpt # trailing comment",
    "weird:",
    "  nested:",
    "    deep: {a: 1, b: [2, 3]}",
    "",
  ].join("\n");
  const { text, action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(action, "add");
  assert.ok(text.includes("# a comment explaining a setting"));
  assert.ok(text.includes("model: gpt # trailing comment"));
  assert.ok(text.includes("    deep: {a: 1, b: [2, 3]}"));
});

test("yaml merge appends into an existing mcp_servers section", () => {
  const source = [
    "model: gpt",
    "mcp_servers:",
    "  other:",
    "    command: npx",
    "    args:",
    "      - -y",
    "      - other-server",
    "    enabled: true",
    "plugins:",
    "  enabled: []",
    "",
  ].join("\n");
  const { text, action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(action, "add");
  assert.ok(text.includes("  other:\n    command: npx"));
  assert.ok(text.includes("      - other-server"));
  assert.ok(text.includes("plugins:\n  enabled: []"));
  const lines = splitLines(text);
  const ours = lines.findIndex((l) => l.trim() === `${SERVER_KEY}:`);
  assert.ok(ours > 0);
  assert.equal(lines[ours], "  pgs-catalog:");
});

test("yaml merge reports unchanged when the entry already matches", () => {
  const source = `mcp_servers:\n  ${SERVER_KEY}:\n    command: /usr/bin/node\n    args:\n      - /srv/index.js\n    enabled: true\n`;
  const { text, action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(action, "unchanged");
  assert.equal(text, source, "the file must come back byte for byte");
});

test("yaml merge ignores key order when comparing an existing entry", () => {
  const source = `mcp_servers:\n  ${SERVER_KEY}:\n    enabled: true\n    args:\n      - /srv/index.js\n    command: /usr/bin/node\n`;
  const { action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(action, "unchanged");
});

test("yaml merge reports a real difference as a conflict, then replaces with force", () => {
  const source = `mcp_servers:\n  ${SERVER_KEY}:\n    command: npx\n    args:\n      - -y\n      - other\n    enabled: true\n  keep:\n    command: untouched\n`;
  const soft = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(soft.action, "conflict");
  assert.equal(soft.text, source, "a conflict must not rewrite the file");
  assert.deepEqual(soft.existingEntry.command, "npx");

  const hard = mergeIntoYaml(source, yamlTarget, yamlEntry, true);
  assert.equal(hard.action, "replace");
  assert.ok(hard.text.includes("    command: /usr/bin/node"));
  assert.ok(hard.text.includes("  keep:\n    command: untouched"), "sibling servers must survive a replace");
  assert.ok(!hard.text.includes("- other"), "the replaced entry's args must be gone");
});

test("yaml merge keeps a tools filter the client added when it is unchanged", () => {
  const source = `mcp_servers:\n  ${SERVER_KEY}:\n    command: /usr/bin/node\n    args:\n      - /srv/index.js\n    enabled: true\n    tools:\n      include:\n        - get_score\n`;
  const { action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  /* A server the user narrowed down is a real difference, not a match. */
  assert.equal(action, "conflict");
});

test("yaml merge turns an empty inline section into a block", () => {
  for (const inline of ["mcp_servers: {}", "mcp_servers: []", "mcp_servers: null"]) {
    const source = `model: gpt\n${inline}\nplugins: {}\n`;
    const { text, action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
    assert.equal(action, "add", inline);
    assert.ok(text.includes("mcp_servers:\n  pgs-catalog:\n    command: /usr/bin/node"), inline);
    assert.ok(text.includes("plugins: {}"), inline);
  }
});

test("yaml merge refuses a non-empty inline section instead of guessing", () => {
  const source = "mcp_servers: something-weird\nmodel: gpt\n";
  const { text, action, reason } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(action, "conflict");
  assert.equal(text, source);
  assert.match(reason, /cannot merge into/);
});

test("yaml merge creates the file when it is empty", () => {
  const { text, action } = mergeIntoYaml("", yamlTarget, yamlEntry, false);
  assert.equal(action, "create");
  assert.equal(text, "mcp_servers:\n  pgs-catalog:\n    command: /usr/bin/node\n    args:\n      - /srv/index.js\n    enabled: true\n");
});

test("yaml merge quotes env values so they stay strings", () => {
  const entry = { ...yamlEntry, env: { PGS_CATALOG_RATE_LIMIT: "30", EMPTY: "" } };
  const { text } = mergeIntoYaml("", yamlTarget, entry, false);
  assert.ok(text.includes('      PGS_CATALOG_RATE_LIMIT: "30"'), text);
  assert.ok(text.includes('      EMPTY: ""'), text);
});

test("yaml merge quotes values that YAML would otherwise reinterpret", () => {
  const entry = { command: "true", args: ["5", "yes", "a b", "-dash"], enabled: true };
  const { text } = mergeIntoYaml("", yamlTarget, entry, false);
  assert.ok(text.includes('command: "true"'), text);
  assert.ok(text.includes('  - "5"'), text);
  assert.ok(text.includes('  - "yes"'), text);
  assert.ok(text.includes('  - a b'), text);
  assert.ok(text.includes('  - "-dash"'), text);
});

test("renderBlock output round-trips back through the parser", () => {
  const entry = {
    command: "/usr/bin/node",
    args: ["/srv/index.js", "--flag", "value"],
    enabled: true,
    env: { A: "1", B: "with space" },
  };
  const text = renderBlock("mcp_servers", { [SERVER_KEY]: entry }, 0);
  const lines = splitLines(text);
  const section = findChildBlock(lines, { start: -1, end: lines.length, indent: -1 }, "mcp_servers");
  const child = findChildBlock(lines, section, SERVER_KEY);
  assert.deepEqual(readBlockValue(lines, child), entry);
});

test("yaml merge finds a section written with a different indent step", () => {
  const source = "model: gpt\nmcp_servers:\n    other:\n        command: npx\n";
  const { action } = mergeIntoYaml(source, yamlTarget, yamlEntry, false);
  assert.equal(action, "add");
});

/* ------------------------------------------------------------- planning */

test("planFor reports add for an existing config without our entry", () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".copilot"), { recursive: true });
  writeFileSync(join(home, ".copilot/mcp-config.json"), JSON.stringify({ mcpServers: { keep: { command: "x" } } }));
  const plan = planFor("copilot", baseOptions({ scope: "user" }), ctx);
  assert.equal(plan.action, "add");
  assert.equal(plan.target.key, "mcpServers");
  assert.equal(plan.document.mcpServers.keep.command, "x");
});

test("planFor honours --path overrides relative to cwd", () => {
  const { cwd, ctx } = sandbox();
  const plan = planFor("cursor", baseOptions({ scope: "project", pathOverride: "custom/mcp.json" }), ctx);
  assert.equal(plan.target.path, join(cwd, "custom/mcp.json"));
});

test("planFor falls back to the harness default scope when unsupported", () => {
  const { ctx } = sandbox();
  const plan = planFor("claude-desktop", baseOptions({ scope: "project" }), ctx);
  assert.ok(plan.target.path.endsWith("claude_desktop_config.json"));
});

/* ---------------------------------------------------------- detection */

test("detectInstalledHarnesses finds only harnesses whose config dir exists", () => {
  const { home, ctx } = sandbox();
  assert.deepEqual(detectInstalledHarnesses(ctx), []);

  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(home, ".gemini"), { recursive: true });
  const found = detectInstalledHarnesses(ctx);
  assert.ok(found.includes("cursor"));
  assert.ok(found.includes("gemini"));
  assert.ok(!found.includes("copilot"));
});

test("detectInstalledHarnesses finds opencode and hermes from their config dirs", () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const found = detectInstalledHarnesses(ctx);
  assert.ok(found.includes("opencode"));
  assert.ok(found.includes("hermes"));

  /* The launcher directory alone is enough to know OpenCode is installed. */
  const other = sandbox();
  mkdirSync(join(other.home, ".opencode/bin"), { recursive: true });
  assert.ok(detectInstalledHarnesses(other.ctx).includes("opencode"));
});

/* ------------------------------------------------------------ arg parsing */

test("parseArgs accepts positional harness names and flags", () => {
  const parsed = parseArgs(["cursor", "--harness", "gemini", "--write", "--force", "--no-backup"]);
  assert.equal(parsed.help, false);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.options.harnesses, ["cursor", "gemini"]);
  assert.equal(parsed.options.write, true);
  assert.equal(parsed.options.force, true);
  assert.equal(parsed.options.backup, false);
});

test("parseArgs maps shortcut flags into env", () => {
  const parsed = parseArgs(["--base-url", "https://example.org/rest", "--rate-limit", "20", "--env", "X=1"]);
  assert.deepEqual(parsed.options.env, {
    PGS_CATALOG_BASE_URL: "https://example.org/rest",
    PGS_CATALOG_RATE_LIMIT: "20",
    X: "1",
  });
});

test("parseArgs rejects bad harness, scope, and env values", () => {
  assert.match(parseArgs(["--harness", "nope"]).error, /Unknown harness/);
  assert.match(parseArgs(["--scope", "nope"]).error, /--scope must be/);
  assert.match(parseArgs(["--env", "NOEQUALS"]).error, /KEY=VALUE/);
  assert.match(parseArgs(["--unknown-flag"]).error, /Unknown argument/);
});

test("parseArgs rejects --path with more than one harness", () => {
  const parsed = parseArgs(["--harness", "cursor", "--harness", "gemini", "--path", "x.json"]);
  assert.match(parsed.error, /--path can only be used with a single harness/);
});

test("parseArgs --json and --print control output mode", () => {
  assert.equal(parseArgs(["--json"]).options.json, true);
  assert.equal(parseArgs(["--json", "--print"]).options.json, false);
});

/* --------------------------------------------------------------- runSetup */

/** Run the CLI against a sandbox context, discarding its console output. */
async function runQuiet(argv, ctx) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await runSetup(argv, ctx);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

test("runSetup writes the entry when --write is given", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".copilot"), { recursive: true });
  const target = join(home, ".copilot/mcp-config.json");
  writeFileSync(target, JSON.stringify({ mcpServers: { keep: { command: "x" } } }, null, 2));

  assert.equal(await runQuiet(["copilot", "--write", "--scope", "user"], ctx), 0);
  const after = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(after.mcpServers.keep.command, "x");
  assert.ok(after.mcpServers[SERVER_KEY].args[0].endsWith("/dist/index.js"));
  assert.equal(existsSync(`${target}.bak`), true);
});

test("runSetup --dry-run cancels --write and leaves the file untouched", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".copilot"), { recursive: true });
  const target = join(home, ".copilot/mcp-config.json");
  const before = JSON.stringify({ mcpServers: { keep: { command: "x" } } });
  writeFileSync(target, before);

  assert.equal(await runQuiet(["copilot", "--write", "--dry-run", "--scope", "user"], ctx), 0);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(existsSync(`${target}.bak`), false);
});

test("runSetup without --write never touches a config file", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".copilot"), { recursive: true });
  const target = join(home, ".copilot/mcp-config.json");
  const before = JSON.stringify({ mcpServers: { keep: { command: "x" } } });
  writeFileSync(target, before);

  assert.equal(await runQuiet(["copilot", "--scope", "user"], ctx), 0);
  assert.equal(readFileSync(target, "utf8"), before);
});

test("runSetup --json prints the merged document and exits 0", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".copilot"), { recursive: true });
  writeFileSync(join(home, ".copilot/mcp-config.json"), JSON.stringify({ mcpServers: { keep: { command: "x" } } }));

  const out = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  process.stderr.write = () => true;
  try {
    assert.equal(await runSetup(["copilot", "--json", "--scope", "user"], ctx), 0);
  } finally {
    process.stdout.write = out;
  }

  const printed = JSON.parse(captured);
  assert.equal(printed.mcpServers.keep.command, "x");
  assert.ok(printed.mcpServers[SERVER_KEY]);
});

test("runSetup reports a conflict and exits 1 without --force", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".copilot"), { recursive: true });
  const target = join(home, ".copilot/mcp-config.json");
  const before = JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: "someone-elses-choice" } } });
  writeFileSync(target, before);

  assert.equal(await runQuiet(["copilot", "--write", "--scope", "user"], ctx), 1);
  assert.equal(readFileSync(target, "utf8"), before, "existing entry must survive");

  assert.equal(await runQuiet(["copilot", "--write", "--force", "--scope", "user"], ctx), 0);
  assert.ok(JSON.parse(readFileSync(target, "utf8")).mcpServers[SERVER_KEY].args.length > 0);
});

test("runSetup --help exits 0 and prints usage", async () => {
  const out = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    assert.equal(await runSetup(["--help"], sandbox().ctx), 0);
  } finally {
    process.stdout.write = out;
  }
  assert.match(captured, /Usage: pgscatalog-mcp setup/);
  assert.match(captured, /claude-desktop/);
});

test("runSetup auto-detects harnesses from the sandbox home", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".gemini"), { recursive: true });

  const out = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  process.stderr.write = () => true;
  try {
    assert.equal(await runSetup([], ctx), 0);
  } finally {
    process.stdout.write = out;
  }
  assert.match(captured, /Gemini CLI/);
  assert.match(captured, /\.gemini\/settings\.json/);
});

test("parseArgs --all expands to every harness", () => {
  const parsed = parseArgs(["--all"]);
  assert.deepEqual(parsed.options.harnesses, [...HARNESS_IDS]);
});

test("parseArgs --help short-circuits", () => {
  const parsed = parseArgs(["--help"]);
  assert.equal(parsed.help, true);
});

/* -------------------------------------------------- opencode end to end */

test("runSetup writes an opencode.json entry in OpenCode's own shape", async () => {
  const { cwd, ctx } = sandbox();
  const target = join(cwd, "opencode.json");
  writeFileSync(target, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "x/y" }, null, 2));

  assert.equal(await runQuiet(["opencode", "--write"], ctx), 0);
  const after = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(after.model, "x/y", "unrelated keys must survive");
  assert.equal(after.mcp[SERVER_KEY].type, "local");
  assert.ok(Array.isArray(after.mcp[SERVER_KEY].command));
  assert.ok(after.mcp[SERVER_KEY].command[1].endsWith("/dist/index.js"));
  assert.equal(existsSync(`${target}.bak`), true);

  /* A second run is a true no-op. */
  const before = readFileSync(target, "utf8");
  assert.equal(await runQuiet(["opencode", "--write"], ctx), 0);
  assert.equal(readFileSync(target, "utf8"), before);
});

test("runSetup warns when an opencode config already uses mcp.servers", async () => {
  const { cwd, ctx } = sandbox();
  const target = join(cwd, "opencode.json");
  writeFileSync(target, JSON.stringify({ mcp: { servers: { other: { type: "local", command: ["x"] } } } }, null, 2));

  const out = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  process.stderr.write = () => true;
  try {
    assert.equal(await runSetup(["opencode"], ctx), 0);
  } finally {
    process.stdout.write = out;
  }
  assert.match(captured, /already has "mcp\.servers"/);
});

/* --------------------------------------------------- hermes end to end */

test("runSetup appends to a Hermes config.yaml and leaves the rest alone", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const target = join(home, ".hermes/config.yaml");
  const before = ["model:", "  default: gpt", "plugins:", "  enabled:", "    - homeassistant", ""].join("\n");
  writeFileSync(target, before);

  assert.equal(await runQuiet(["hermes", "--write"], ctx), 0);
  const after = readFileSync(target, "utf8");
  assert.ok(after.startsWith(before), "the original file must be preserved verbatim");
  assert.ok(after.includes("mcp_servers:\n  pgs-catalog:\n    command:"));
  assert.ok(after.includes("    enabled: true"));
  assert.equal(existsSync(`${target}.bak`), true);

  /* A second run must not append a second copy. */
  assert.equal(await runQuiet(["hermes", "--write"], ctx), 0);
  const twice = readFileSync(target, "utf8");
  assert.equal(twice, after);
  assert.equal(twice.split(`${SERVER_KEY}:`).length - 1, 1);
});

test("runSetup --no-backup writes Hermes without a .bak", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const target = join(home, ".hermes/config.yaml");
  writeFileSync(target, "model: gpt\n");

  assert.equal(await runQuiet(["hermes", "--write", "--no-backup"], ctx), 0);
  assert.equal(existsSync(`${target}.bak`), false);
});

test("runSetup reports a Hermes conflict and exits 1 without --force", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const target = join(home, ".hermes/config.yaml");
  const before = `model: gpt\nmcp_servers:\n  ${SERVER_KEY}:\n    command: npx\n    args:\n      - -y\n      - someone-elses-choice\n    enabled: true\n`;
  writeFileSync(target, before);

  assert.equal(await runQuiet(["hermes", "--write"], ctx), 1);
  assert.equal(readFileSync(target, "utf8"), before, "the existing entry must survive");

  assert.equal(await runQuiet(["hermes", "--write", "--force"], ctx), 0);
  const after = readFileSync(target, "utf8");
  assert.ok(after.includes("    command:"));
  assert.ok(!after.includes("someone-elses-choice"));
});

test("runSetup --json prints the Hermes section it would write", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(join(home, ".hermes/config.yaml"), "model: gpt\n");

  const out = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  process.stderr.write = () => true;
  try {
    assert.equal(await runSetup(["hermes", "--json"], ctx), 0);
  } finally {
    process.stdout.write = out;
  }

  const printed = JSON.parse(captured);
  assert.equal(printed.mcp_servers[SERVER_KEY].command.length > 0, true);
  assert.equal(printed.mcp_servers[SERVER_KEY].enabled, true);
});

test("runSetup previews Hermes in YAML rather than JSON", async () => {
  const { home, ctx } = sandbox();
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(join(home, ".hermes/config.yaml"), "model: gpt\n");

  const out = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  process.stderr.write = () => true;
  try {
    assert.equal(await runSetup(["hermes"], ctx), 0);
  } finally {
    process.stdout.write = out;
  }
  assert.match(captured, /^mcp_servers:\n {2}pgs-catalog:\n {4}command:/m);
  assert.match(captured, /hermes mcp add/);
});

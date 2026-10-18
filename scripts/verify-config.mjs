/* Launches the server exactly as a generated config describes it, then does a
 * real MCP handshake. This is the check that a config `setup` wrote actually
 * works in a client, not just that it looks right.
 *
 * Accepts a JSON config (mcpServers / servers / OpenCode's mcp) or a Hermes
 * YAML file, and handles both the `{command, args}` and OpenCode's
 * `{command: [cmd, ...args]}` shapes. */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const configPath = process.argv[2];
const expectedTools = Number(process.argv[3] ?? 19);
const SERVER = "pgs-catalog";

const raw = readFileSync(configPath, "utf8");

/**
 * Pull one server entry out of any supported config syntax. Deliberately
 * minimal: it reads the entry this tool wrote, not a whole config file.
 */
function findEntry(text) {
  if (configPath.endsWith(".yaml") || configPath.endsWith(".yml")) {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.trim() === `${SERVER}:`);
    if (start < 0) return undefined;
    const entry = { command: undefined, args: [] };
    let mode = null;
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("    ")) break;
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        if (mode === "args") entry.args.push(trimmed.slice(2).trim());
        continue;
      }
      const [key, ...rest] = trimmed.split(":");
      const value = rest.join(":").trim();
      mode = key;
      if (key === "command") entry.command = value;
      else if (key === "args") entry.args = [];
    }
    return entry;
  }

  const cfg = JSON.parse(text);
  return (
    cfg.mcpServers?.[SERVER] ??
    cfg.servers?.[SERVER] ??
    cfg.mcp?.[SERVER] ??
    cfg.mcp?.servers?.[SERVER]
  );
}

const entry = findEntry(raw);
if (!entry) {
  console.error("no pgs-catalog entry found in", configPath);
  process.exit(1);
}

/* OpenCode merges the command and its arguments into one array. */
const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
const args = Array.isArray(entry.command) ? entry.command.slice(1) : (entry.args ?? []);

console.log("launching:", command, args.join(" "));

const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
child.stdout.on("data", (d) => (buffer += d));
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
});

setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}, 500);

setTimeout(() => {
  const messages = buffer
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const init = messages.find((m) => m.id === 1);
  const tools = messages.find((m) => m.id === 2);
  const names = tools?.result?.tools?.map((t) => t.name) ?? [];

  console.log("server:", init?.result?.serverInfo?.name, init?.result?.serverInfo?.version);
  console.log("instructions present:", Boolean(init?.result?.instructions));
  console.log("tools discovered:", names.length);

  const ok = Boolean(init?.result?.serverInfo) && names.length === expectedTools;
  console.log(ok ? "PASS: generated config launches a working MCP server" : "FAIL");
  child.kill();
  process.exit(ok ? 0 : 1);
}, 2000);

/**
 * Known MCP harnesses and where each one reads its server configuration from.
 *
 * Every path, wrapper key and entry shape here was checked against the
 * harness's own documentation and against the config files already present on
 * the machine this package was developed on:
 *
 *   Claude Code    .mcp.json (project) / ~/.claude.json (user)   mcpServers
 *   Claude Desktop ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Cursor         .cursor/mcp.json (project) / ~/.cursor/mcp.json (user)
 *   VS Code        .mcp.json or .vscode/mcp.json (project) / <userData>/mcp.json (user)
 *   Copilot        .copilot/mcp-config.json (project) / ~/.copilot/mcp-config.json (user)
 *   Gemini CLI     .gemini/settings.json (project) / ~/.gemini/settings.json (user)
 *   OpenCode       opencode.json (project) / ~/.config/opencode/opencode.json
 *   Hermes         ~/.hermes/config.yaml (user only, YAML)
 *
 * Three harnesses need a wrapper key that differs from the others: VS Code's
 * `.vscode/mcp.json` and its user profile file use `servers`, OpenCode uses
 * `mcp`, Hermes uses `mcp_servers`. Hermes is also the only one whose config
 * file is YAML rather than JSON.
 */

export const SERVER_KEY = "pgs-catalog";

export type HarnessId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "copilot"
  | "gemini"
  | "opencode"
  | "hermes";

export type Scope = "project" | "user";

export type EntryShape =
  /** `{ command, args, env }` */
  | "plain"
  /** `{ command, args, type: "stdio", env }` */
  | "typed"
  /** `{ type: "local", command: [command, ...args], environment }` */
  | "opencode-local";

export interface ResolveContext {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** VS Code user config lives in the editor's userData dir, not in `~`. */
  vscodeUserDataDir?: string;
  fileExists: (path: string) => boolean;
}

export interface HarnessTarget {
  /** Absolute path of the config file to create or merge into. */
  path: string;
  /** Top-level key holding the server map. */
  key: "mcpServers" | "servers" | "mcp" | "mcp_servers";
  /** Shape the harness expects for one server entry. */
  shape: EntryShape;
  /** Human-readable description of the scope, for CLI output. */
  label: string;
  /** File syntax. JSON everywhere except Hermes, whose config is YAML. */
  format?: "json" | "yaml";
}

export interface HarnessDefinition {
  id: HarnessId;
  name: string;
  scopes: Scope[];
  defaultScope: Scope;
  resolve: (scope: Scope, ctx: ResolveContext) => HarnessTarget;
  /** Anything a user must know before this entry works. */
  notes: string[];
}

const join = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");

function desktopConfigDir(ctx: ResolveContext): string {
  if (process.platform === "darwin") return join(ctx.home, "Library/Application Support/Claude");
  if (process.platform === "win32") {
    const appData = ctx.env.APPDATA ?? join(ctx.home, "AppData/Roaming");
    return join(appData, "Claude");
  }
  return join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"), "Claude");
}

function vscodeUserDataDir(ctx: ResolveContext): string {
  if (ctx.vscodeUserDataDir) return ctx.vscodeUserDataDir;
  const override = ctx.env.VSCODE_USER_DATA_DIR ?? process.env.VSCODE_CODE_CACHE_PATH;
  if (override) return override;
  if (process.platform === "darwin") return join(ctx.home, "Library/Application Support/Code/User");
  if (process.platform === "win32") {
    const appData = ctx.env.APPDATA ?? join(ctx.home, "AppData/Roaming");
    return join(appData, "Code/User");
  }
  return join(ctx.home, ".config/Code/User");
}

/**
 * OpenCode's global config file. `OPENCODE_CONFIG` is the documented way to
 * point OpenCode at a config file of your own, so it wins when it is set.
 */
function opencodeGlobalConfig(ctx: ResolveContext): string {
  const custom = ctx.env.OPENCODE_CONFIG;
  if (custom) return custom;
  const configHome = ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config");
  return join(configHome, "opencode/opencode.json");
}

/** Hermes keeps one config file for the whole home, which `HERMES_HOME` relocates. */
function hermesConfigPath(ctx: ResolveContext): string {
  return join(ctx.env.HERMES_HOME ?? join(ctx.home, ".hermes"), "config.yaml");
}

export const HARNESS_REGISTRY: Record<HarnessId, HarnessDefinition> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    scopes: ["project", "user"],
    defaultScope: "project",
    resolve: (scope, ctx) =>
      scope === "project"
        ? {
            path: join(ctx.cwd, ".mcp.json"),
            key: "mcpServers",
            shape: "typed",
            label: "project scope (.mcp.json, shared with your team)",
          }
        : {
            path: ctx.env.CLAUDE_CONFIG_DIR ? join(ctx.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(ctx.home, ".claude.json"),
            key: "mcpServers",
            shape: "typed",
            label: "user scope (~/.claude.json, all your projects)",
          },
    notes: [
      "Claude Code reads a `url` entry without `type` as a stdio server, so the `type` field is written explicitly.",
      "A project `.mcp.json` needs approval once: run `claude` in the folder and accept it, then `claude mcp list` should show the server as connected.",
    ],
  },

  "claude-desktop": {
    id: "claude-desktop",
    name: "Claude Desktop",
    scopes: ["user"],
    defaultScope: "user",
    resolve: (_scope, ctx) => ({
      path: join(desktopConfigDir(ctx), "claude_desktop_config.json"),
      key: "mcpServers",
      shape: "plain",
      label: "Claude Desktop app settings",
    }),
    notes: ["Claude Desktop must be restarted after the config changes."],
  },

  cursor: {
    id: "cursor",
    name: "Cursor",
    scopes: ["project", "user"],
    defaultScope: "project",
    resolve: (scope, ctx) =>
      scope === "project"
        ? {
            path: join(ctx.cwd, ".cursor/mcp.json"),
            key: "mcpServers",
            shape: "plain",
            label: "project scope (.cursor/mcp.json)",
          }
        : {
            path: join(ctx.home, ".cursor/mcp.json"),
            key: "mcpServers",
            shape: "plain",
            label: "global scope (~/.cursor/mcp.json)",
          },
    notes: ["Cursor also accepts a `type` field; it is omitted because Cursor infers stdio from `command`."],
  },

  vscode: {
    id: "vscode",
    name: "VS Code / GitHub Copilot agent",
    scopes: ["project", "user"],
    defaultScope: "project",
    resolve: (scope, ctx) => {
      if (scope === "project") {
        // `.vscode/mcp.json` uses the `servers` key; the portable `.mcp.json`
        // uses `mcpServers`. Prefer whichever shape the folder already uses.
        const usesVscodeDir = ctx.fileExists(join(ctx.cwd, ".vscode/mcp.json")) || ctx.fileExists(join(ctx.cwd, ".vscode"));
        return usesVscodeDir
          ? {
              path: join(ctx.cwd, ".vscode/mcp.json"),
              key: "servers",
              shape: "typed",
              label: "project scope (.vscode/mcp.json)",
            }
          : {
              path: join(ctx.cwd, ".mcp.json"),
              key: "mcpServers",
              shape: "typed",
              label: "project scope (.mcp.json, portable across clients)",
            };
      }
      return {
        path: join(vscodeUserDataDir(ctx), "mcp.json"),
        key: "servers",
        shape: "typed",
        label: "user profile (VS Code user mcp.json)",
      };
    },
    notes: [
      "VS Code reloads the window before it picks up MCP changes; run the `MCP: List Servers` command to confirm the server registered.",
    ],
  },

  copilot: {
    id: "copilot",
    name: "GitHub Copilot CLI / VS Code agent",
    scopes: ["project", "user"],
    defaultScope: "user",
    resolve: (scope, ctx) =>
      scope === "project"
        ? {
            path: join(ctx.cwd, ".copilot/mcp-config.json"),
            key: "mcpServers",
            shape: "plain",
            label: "project scope (.copilot/mcp-config.json)",
          }
        : {
            path: join(ctx.home, ".copilot/mcp-config.json"),
            key: "mcpServers",
            shape: "plain",
            label: "user scope (~/.copilot/mcp-config.json)",
          },
    notes: [],
  },

  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    scopes: ["project", "user"],
    defaultScope: "project",
    resolve: (scope, ctx) =>
      scope === "project"
        ? {
            path: join(ctx.cwd, ".gemini/settings.json"),
            key: "mcpServers",
            shape: "plain",
            label: "project scope (.gemini/settings.json)",
          }
        : {
            path: join(ctx.home, ".gemini/settings.json"),
            key: "mcpServers",
            shape: "plain",
            label: "user scope (~/.gemini/settings.json)",
          },
    notes: [
      "Gemini CLI prefixes tool names as `mcp_<server>_<tool>`; avoid underscores in the server name, which is why it is registered as `pgs-catalog`.",
    ],
  },

  opencode: {
    id: "opencode",
    name: "OpenCode",
    scopes: ["project", "user"],
    defaultScope: "project",
    resolve: (scope, ctx) =>
      scope === "project"
        ? {
            path: join(ctx.cwd, "opencode.json"),
            key: "mcp",
            shape: "opencode-local",
            label: "project scope (opencode.json)",
          }
        : {
            path: opencodeGlobalConfig(ctx),
            key: "mcp",
            shape: "opencode-local",
            label: "global scope (~/.config/opencode/opencode.json)",
          },
    notes: [
      "OpenCode merges its config files: a project opencode.json overrides the global one, and other keys in either file are left alone.",
      "OpenCode wants the command and its arguments as one array under `command`, and environment variables under `environment`, not `env`.",
      "Servers are written as `mcp.<name>`. OpenCode 1.x accepts only that shape; OpenCode 2 also offers `mcp.servers.<name>`, so the shape written here works on both.",
      "OpenCode prefixes tool names with the server name, so a name containing underscores is awkward to reference; `pgs-catalog` avoids that.",
    ],
  },

  hermes: {
    id: "hermes",
    name: "Hermes",
    /* Hermes has a single config file per home; there is no project-scoped file. */
    scopes: ["user"],
    defaultScope: "user",
    resolve: (_scope, ctx) => ({
      path: hermesConfigPath(ctx),
      key: "mcp_servers",
      shape: "plain",
      label: "Hermes home (~/.hermes/config.yaml)",
      format: "yaml",
    }),
    notes: [
      "Hermes reads `mcp_servers` from config.yaml, which is YAML. This tool appends the entry and leaves the rest of the file untouched.",
      "Equivalent one-command form, which also probes the connection and lets you pick tools: hermes mcp add pgs-catalog --command <node> --args <path to dist/index.js>",
      "Hermes loads MCP servers at startup: start a new session, or run /reload-mcp inside one.",
    ],
  },
};

export const HARNESS_IDS = Object.keys(HARNESS_REGISTRY) as HarnessId[];

export function isHarnessId(value: string): value is HarnessId {
  return Object.prototype.hasOwnProperty.call(HARNESS_REGISTRY, value);
}

/** Aliases people reach for instead of the canonical id. */
const HARNESS_ALIASES: Record<string, HarnessId> = {
  claude: "claude-code",
  claudecode: "claude-code",
  "claude code": "claude-code",
  desktop: "claude-desktop",
  "claude desktop app": "claude-desktop",
  vscode_copilot: "vscode",
  "visual studio code": "vscode",
  code: "vscode",
  copilot_cli: "copilot",
  "github-copilot": "copilot",
  gemini_cli: "gemini",
  "open-code": "opencode",
  opencode_ai: "opencode",
  "hermes-agent": "hermes",
  "hermes-mcp": "hermes",
};

export function resolveHarnessId(value: string): HarnessId | undefined {
  const normalize = (input: string): string => input.trim().toLowerCase().replace(/[ _]+/g, "-");
  const normalized = normalize(value);
  if (isHarnessId(normalized)) return normalized;
  for (const [alias, id] of Object.entries(HARNESS_ALIASES)) {
    if (normalize(alias) === normalized) return id;
  }
  return undefined;
}

/**
 * Harnesses worth offering when the user asks for "auto" setup: only the ones
 * whose config location actually exists on this machine, in a stable order.
 */
export function detectInstalledHarnesses(ctx: ResolveContext): HarnessId[] {
  const found: HarnessId[] = [];
  for (const id of HARNESS_IDS) {
    const def = HARNESS_REGISTRY[id];
    if (!def) continue;
    const marker = detectMarker(id, ctx);
    if (marker && ctx.fileExists(marker)) found.push(id);
  }
  return found;
}

/** A file or directory whose presence means the harness is installed. */
function detectMarker(id: HarnessId, ctx: ResolveContext): string | undefined {
  switch (id) {
    case "claude-code":
      return ctx.fileExists(join(ctx.home, ".claude.json")) || ctx.fileExists(join(ctx.home, ".claude"))
        ? join(ctx.home, ".claude")
        : undefined;
    case "claude-desktop":
      return ctx.fileExists(join(desktopConfigDir(ctx), "claude_desktop_config.json"))
        ? join(desktopConfigDir(ctx), "claude_desktop_config.json")
        : undefined;
    case "cursor":
      return ctx.fileExists(join(ctx.home, ".cursor")) ? join(ctx.home, ".cursor") : undefined;
    case "vscode":
      return ctx.fileExists(vscodeUserDataDir(ctx)) ? vscodeUserDataDir(ctx) : undefined;
    case "copilot":
      return ctx.fileExists(join(ctx.home, ".copilot")) ? join(ctx.home, ".copilot") : undefined;
    case "gemini":
      return ctx.fileExists(join(ctx.home, ".gemini")) ? join(ctx.home, ".gemini") : undefined;
    case "opencode": {
      /* Either directory means OpenCode is installed: `~/.opencode` holds the
       * launcher, `~/.config/opencode` holds the global config. */
      const globalDir = join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"), "opencode");
      if (ctx.fileExists(globalDir)) return globalDir;
      return ctx.fileExists(join(ctx.home, ".opencode")) ? join(ctx.home, ".opencode") : undefined;
    }
    case "hermes":
      return ctx.fileExists(join(ctx.home, ".hermes")) ? join(ctx.home, ".hermes") : undefined;
  }
}

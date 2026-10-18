# PGS Catalog MCP

An [MCP](https://modelcontextprotocol.io) server for the [PGS Catalog REST API](https://www.pgscatalog.org/rest/) — the EMBL-EBI catalog of published [polygenic scores](https://www.pgscatalog.org/docs/), their traits, publications, evaluation samples, and reported performance metrics.

Built with the official TypeScript SDK (`@modelcontextprotocol/sdk`) over stdio. It covers the full REST surface (v1.8.6): score, publication, trait, performance metric, sample/cohort, release, and info endpoints.

## Quick start

```bash
npm install
npm run build
npm run setup          # detect the MCP clients on this machine and print the config
```

`setup` figures out which harnesses are installed, prints the exact config each
one expects (JSON, or YAML for Hermes), and tells you what it would change.
Nothing is written until you add `--write`. See [Setup](#setup-installing-into-a-client) below.

<details>
<summary>Or add the entry by hand</summary>

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pgs-catalog": {
      "command": "node",
      "args": ["<absolute-path-to>/dist/index.js"]
    }
  }
}
```

For VS Code Copilot, add to `.vscode/mcp.json` — note this file uses the
`servers` key, not `mcpServers`:

```json
{
  "servers": {
    "pgs-catalog": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"]
    }
  }
}
```

For OpenCode, add to `opencode.json` (project) or
`~/.config/opencode/opencode.json` (global). OpenCode wants the command and its
arguments as one array, and environment variables under `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pgs-catalog": {
      "type": "local",
      "command": ["node", "<absolute-path-to>/dist/index.js"]
    }
  }
}
```

For Hermes, add to `~/.hermes/config.yaml`, which is YAML. `hermes mcp add
`hermes mcp add pgs-catalog --command node --args <absolute-path-to>/dist/index.js`
does the same thing and also probes the connection:

```yaml
mcp_servers:
  pgs-catalog:
    command: node
    args:
      - <absolute-path-to>/dist/index.js
    enabled: true
```

</details>

## Setup: installing into a client

`pgscatalog-mcp setup` writes the server entry into a client's own config file,
or prints it as JSON. It supports Claude Code, Claude Desktop, Cursor, VS Code /
GitHub Copilot, GitHub Copilot CLI, Gemini CLI, OpenCode, and Hermes.

```bash
npm run setup                       # detect installed clients, preview every change
npm run setup -- --write           # apply them
npm run setup -- --harness cursor  # one client only
npm run setup:json                 # print just the JSON, for piping or pasting
```

Positional harness names work too (`pgscatalog-mcp setup cursor gemini`), as do
aliases like `claude` or `desktop`.

| Flag | Effect |
| --- | --- |
| `--write` | Merge the entry into the client's config file. Without it, nothing is written. |
| `--dry-run` | Show what would change, explicitly. |
| `--json` | Print only JSON — one merged document, or a map keyed by harness when several are targeted. With `--write`, a YAML client is still written as YAML. |
| `--print` | Human-readable preview (the default). |
| `--scope project\|user` | Which config file to touch. Each client has its own sensible default. |
| `--all` | Every supported client, installed or not. |
| `--force` | Replace an existing `pgs-catalog` entry that differs. |
| `--no-backup` | Skip the `.bak` copy written before modifying a file. |
| `--command auto\|npx\|"..."` | How to launch the server. `auto` uses an absolute `node /abs/dist/index.js` when the build exists, otherwise `npx -y pgs-catalog-mcp`. |
| `--path <file>` | Write somewhere other than the client's default config. |
| `--env KEY=VALUE` | Environment for the server process. `--base-url`, `--rate-limit`, `--timeout` are shortcuts for the matching `PGS_CATALOG_*` variables. |

Safety rules, all deliberate:

- **Nothing is written without `--write`.** The default action is a preview.
- **Files are merged, never rewritten.** Other servers, other top-level settings,
  and key order are preserved. Only `pgs-catalog` is added or replaced.
- **A differing existing entry is left alone** and reported as a conflict (exit
  code 1) unless you pass `--force`.
- **A file that is not valid JSON — or not valid YAML, for Hermes — is never
  overwritten** — the tool stops and says so.
- **Hermes' `config.yaml` is edited in place.** Only its `mcp_servers` section
  changes; every other setting, comment, and line is copied through byte for
  byte.
- **A modified file is copied to `<file>.bak` first**, unless `--no-backup`.
- **Re-running is a no-op.** An identical entry is reported as `unchanged` and
  the file is not touched.

Where each client's config lives:

| Harness | Project scope | User scope | Top-level key |
| --- | --- | --- | --- |
| Claude Code | `.mcp.json` | `~/.claude.json` | `mcpServers` |
| Claude Desktop | — | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` | `mcpServers` |
| VS Code / Copilot | `.vscode/mcp.json` or `.mcp.json` | VS Code user `mcp.json` | `servers` / `mcpServers` |
| Copilot CLI | `.copilot/mcp-config.json` | `~/.copilot/mcp-config.json` | `mcpServers` |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` | `mcpServers` |
| OpenCode | `opencode.json` | `~/.config/opencode/opencode.json` | `mcp` |
| Hermes | — | `~/.hermes/config.yaml` (YAML) | `mcp_servers` |

VS Code is the odd one out among the JSON clients: `.vscode/mcp.json` and the
user profile file use `servers`, while the portable `.mcp.json` uses
`mcpServers`. `setup` prefers whichever shape the folder already uses. Claude
Code needs a `type` field on a stdio entry, and reads a `url` entry without one
as stdio, so `type` is written explicitly there and for VS Code.

OpenCode and Hermes differ more sharply:

- **OpenCode** keeps servers under `mcp`, merges `command` and `args` into a
  single array, and calls environment variables `environment`. It also merges its
  own config files, so a project `opencode.json` overrides the global one.
  OpenCode 1.x accepts only `mcp.<name>`; OpenCode 2 also offers
  `mcp.servers.<name>`, and `setup` warns if a config already uses that shape.
- **Hermes** is the only client whose config is YAML. `setup` edits only its
  `mcp_servers` section and copies every other line through untouched, comments
  included. Hermes has one config per home, so it has no project scope.

After writing, reload the client: restart Claude Desktop, reload the VS Code
window, start a new OpenCode session, run `/reload-mcp` in a Hermes session, or
run `claude mcp list` / `gemini mcp list` to confirm the server registered.

## Tools

| Tool | REST endpoint | What it gives you |
| --- | --- | --- |
| `search_scores` | `/rest/score/search`, `/rest/score/all` | Scores by trait ID, PGP ID, PubMed ID, or a known list of PGS IDs |
| `get_score` | `/rest/score/{pgs_id}` | Scoring-file URLs (incl. harmonized GRCh37/GRCh38), method parameters, variant count, weight type, ancestry distribution, license |
| `search_publications` | `/rest/publication/search`, `/rest/publication/all` | Publications by author, PMID, or associated score |
| `get_publication` | `/rest/publication/{pgp_id}` | Citation plus the PGS IDs developed and evaluated by that paper |
| `search_traits` | `/rest/trait/search`, `/rest/trait/all` | Resolve a condition name, category, synonym, or mapped term (ICD10/OMIM) into an ontology ID |
| `get_trait` | `/rest/trait/{trait_id}` | Trait definition, synonyms, categories, associated PGS IDs, child terms |
| `list_trait_categories` | `/rest/trait_category/all` | The high-level groups (Cancer, Cardiovascular disorder, …) and their traits |
| `search_performance_metrics` | `/rest/performance/search`, `/rest/performance/all` | Odds ratios, hazard ratios, C-index/AUC, variance explained — with confidence intervals, covariates, and evaluation samples |
| `get_performance_metric` | `/rest/performance/{ppm_id}` | One metric record in full |
| `search_sample_sets` | `/rest/sample_set/search`, `/rest/sample_set/all` | Participant counts, ancestry breakdowns, age/follow-up data, cohorts |
| `get_sample_set` | `/rest/sample_set/{pss_id}` | One sample set in full |
| `list_cohorts` | `/rest/cohort/all` | Cohorts (UK Biobank, NHS, ABCFS, …) and the scores that used them |
| `get_cohort` | `/rest/cohort/{cohort_symbol}` | One cohort by short symbol |
| `get_release` | `/rest/release/current`, `/rest/release/{date}` | Release date and newly added content |
| `list_releases` | `/rest/release/all` | All releases, most recent first |
| `get_catalog_info` | `/rest/info` | API version, catalog counts, and the PGS Catalog citation (DOI/PMID) for attribution |
| `get_ancestry_categories` | `/rest/ancestry_categories` | Decode `EUR`, `AFR`, `MAE`, … before interpreting any ancestry field |
| `get_api_versions` | `/rest/api_versions` | REST API version history |
| `get_scores_from_gwas_study` | `/rest/gwas/get_score_ids/{gcst_id}` | Trace a GWAS Catalog study (GCST) into the scores derived from it |
| `list_ftp_scores` | FTP site root | List all PGS score directories on the FTP site (PGS000001, PGS000002, …) |
| `list_ftp_score_directory` | FTP site, `{pgs_id}/` | List a score's FTP directory (ScoringFiles/, Metadata/, …) |
| `list_ftp_scoring_files` | FTP site, `{pgs_id}/ScoringFiles/` | List downloadable scoring files for a score |
| `list_ftp_metadata_files` | FTP site, `{pgs_id}/Metadata/` | List downloadable metadata files for a score |
| `get_ftp_file` | FTP site, any path | Download a file's contents from the FTP site |

All tools are read-only and marked as such via MCP tool annotations.

## How to use it well

**Resolve trait IDs before searching scores.** Ontology IDs are remapped between catalog releases, and IDs quoted in the upstream API docs (for example `EFO_0000305`) can return zero results. Search by name first:

```json
search_traits { "term": "breast cancer" }        -> MONDO_0007254, MONDO_0004989, ...
search_scores { "trait_id": "MONDO_0004989" }    -> 145 scores
```

**Compact by default.** PGS records are large, so tools return a curated projection. Narrow it further with `fields` (dotted paths are supported and reproduce the original nesting):

```json
get_score { "pgs_id": "PGS000001", "fields": "id,name,variants_number,publication.title" }
```

Set `full: true` when you need the complete upstream record.

**Page with `next_offset`.** List results are capped at 250 per call (the API maximum). When a response includes `next_offset` and a `hint`, call again with that offset to continue.

## Configuration

Environment variables, all optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PGS_CATALOG_BASE_URL` | `https://www.pgscatalog.org/rest` | Point at a mirror or a staging instance |
| `PGS_CATALOG_RATE_LIMIT` | `90` | Client-side requests per minute (the API allows 100) |
| `PGS_CATALOG_TIMEOUT_MS` | `30000` | Per-request timeout |

The client enforces a sliding-window rate limit below the documented 100 req/min ceiling, retries transient 5xx and 429 responses with backoff, and handles the API's quirks: unknown IDs return HTTP 200 with `{}` (surfaced as a clear `not_found`), and malformed requests can return an HTML error page rather than JSON.

## Development

```bash
npm run build       # compile to dist/
npm run dev         # watch mode
npm test            # unit tests (88) against the compiled output
npm run test:e2e    # end-to-end: spawns the server over stdio and exercises every tool against the live API
```

`test/setup.test.mjs` covers the setup command: config paths and wrapper keys per
harness, entry shape, merge behaviour, conflict handling, argument parsing, and
`runSetup` end-to-end against a temporary directory — it never writes to a real
client config. The YAML path is covered too: appending a section, preserving
comments and unrelated keys, leaving an unchanged entry byte-identical, and
refusing to overwrite a file it cannot parse.

`scripts/verify-config.mjs` closes the loop the other way: it reads a config file
`setup` generated — JSON or Hermes' YAML, `mcpServers` / `servers` / `mcp` /
`mcp_servers`, string or array `command` — launches the server exactly as that
config describes, and checks the MCP handshake and tool count. Run it with:

```bash
node dist/index.js setup --harness cursor --json --path /tmp/c.json > /tmp/c.json
node scripts/verify-config.mjs /tmp/c.json
```

`spec/pgscatalog-rest-openapi.yaml` is the upstream OpenAPI 3.0.3 document this server was built against, kept for reference.

## Data and attribution

PGS Catalog data is © EMBL-EBI and distributed under the [EBI Terms of Use](https://www.ebi.ac.uk/about/terms-of-use). Call `get_catalog_info` to retrieve the current citation (DOI and PubMed ID) when publishing results derived from these tools. Individual scores may carry additional license restrictions, reported in each score's `license` field.

This server code is licensed under Apache-2.0.

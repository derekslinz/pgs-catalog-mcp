#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DEFAULT_BASE_URL, PgsClient } from "./client.js";
import { FtpClient } from "./ftp.js";
import { runSetup } from "./setup.js";
import { registerTools } from "./tools.js";

const SERVER_NAME = "pgs-catalog";
const SERVER_VERSION = "0.1.0";

/* `pgscatalog-mcp setup` configures this server in a harness instead of
 * starting it. MCP clients spawn the server with no arguments, so the stdio
 * path stays the default and only an explicit `setup` subcommand diverts. */
if (process.argv[2] === "setup") {
  process.exit(await runSetup(process.argv.slice(3)));
}

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions:
      "Tools for the PGS Catalog (https://www.pgscatalog.org), a curated catalog of polygenic scores.\n\n" +
      "Typical flows:\n" +
      "1. Resolve a condition to an ontology ID with search_traits (or browse groups with list_trait_categories), " +
      "then find scores with search_scores using that trait_id. Always use the ID exactly as returned by search_traits — " +
      "ontology IDs are remapped between catalog releases and IDs quoted in the upstream API docs may return no results.\n" +
      "2. Inspect one score with get_score to obtain the FTP scoring-file URL, method parameters, variant count, " +
      "weight type, and ancestry distribution.\n" +
      "3. Judge how well a score performs with search_performance_metrics using pgs_id; check who it was evaluated in " +
      "with search_sample_sets.\n" +
      "4. Decode ancestry codes such as EUR or AFR with get_ancestry_categories before reporting ancestry distributions.\n" +
      "5. Cite the catalog with get_catalog_info.\n\n" +
      "Notes: all tools are read-only. List results are paginated; when the response includes next_offset, call again " +
      "with that offset. Default output is a compact projection - set full=true only when extra fields are required. " +
      "PGS Catalog data is distributed under the EBI Terms of Use (https://www.ebi.ac.uk/about/terms-of-use).",
    capabilities: { tools: {} },
  },
);

const client = new PgsClient({
  baseUrl: process.env.PGS_CATALOG_BASE_URL ?? DEFAULT_BASE_URL,
  maxRequestsPerMinute: Number(process.env.PGS_CATALOG_RATE_LIMIT ?? 90),
  timeoutMs: Number(process.env.PGS_CATALOG_TIMEOUT_MS ?? 30_000),
});

const ftp = new FtpClient({
  timeoutMs: Number(process.env.PGS_CATALOG_TIMEOUT_MS ?? 30_000),
});

registerTools(server, client, ftp);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} MCP server v${SERVER_VERSION} connected over stdio (${client.base})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal error starting ${SERVER_NAME} MCP server: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

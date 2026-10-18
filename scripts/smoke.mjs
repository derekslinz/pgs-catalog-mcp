#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built MCP server over stdio and exercises
 * the tools against the live PGS Catalog API.
 *
 * Usage: npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = new URL("../dist/index.js", import.meta.url).pathname;

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

function fail(name, detail) {
  failed += 1;
  console.log(`  \u2717 ${name}\n    ${detail}`);
}

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
const client = new Client({ name: "smoke-test", version: "0.0.0" });

await client.connect(transport);

/* ------------------------------------------------------------------ list */
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log(`\nConnected. ${names.length} tools registered.`);

const expected = [
  "search_scores",
  "get_score",
  "search_publications",
  "get_publication",
  "search_traits",
  "get_trait",
  "list_trait_categories",
  "search_performance_metrics",
  "get_performance_metric",
  "search_sample_sets",
  "get_sample_set",
  "list_cohorts",
  "get_cohort",
  "get_release",
  "list_releases",
  "get_catalog_info",
  "get_ancestry_categories",
  "get_api_versions",
  "get_scores_from_gwas_study",
];

for (const name of expected) {
  if (names.includes(name)) ok(`registered: ${name}`);
  else fail(`registered: ${name}`, "tool missing from tools/list");
}

/* --------------------------------------------------------------- helpers */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const raw = result.content?.find((c) => c.type === "text")?.text ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* some tools return plain text */
  }
  return { isError: Boolean(result.isError), parsed, raw };
}

async function check(name, toolName, args, validate) {
  try {
    const res = await call(toolName, args);
    if (res.isError) {
      fail(name, res.raw.slice(0, 400));
      return;
    }
    const problem = validate(res.parsed, res.raw);
    if (problem) fail(name, problem);
    else ok(`${name} (${toolName})`);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

const requireResults = (min) => (parsed) => {
  if (!parsed) return "response was not JSON";
  if (!Array.isArray(parsed.results)) return `no results array: ${JSON.stringify(parsed).slice(0, 200)}`;
  if (parsed.results.length < min) return `expected >= ${min} results, got ${parsed.results.length}`;
  return null;
};

console.log("\nTool calls against the live API:");

await check("catalog info + citation", "get_catalog_info", {}, (parsed) =>
  parsed?.rest_api?.version && parsed?.citation?.title ? null : `missing rest_api.version or citation: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("ancestry categories", "get_ancestry_categories", {}, (parsed) =>
  parsed?.EUR?.display_category ? null : `missing EUR mapping: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("api versions", "get_api_versions", {}, (parsed) =>
  parsed?.current?.version ? null : `missing current.version: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("trait search by name", "search_traits", { term: "breast cancer", limit: 3 }, (parsed) => {
  const err = requireResults(1)(parsed);
  if (err) return err;
  const first = parsed.results[0];
  return first?.id && first?.label ? null : `trait result missing id/label: ${JSON.stringify(first).slice(0, 200)}`;
});

await check("trait categories", "list_trait_categories", { limit: 5 }, requireResults(5));

/* Resolve a live trait ID once; ontology IDs are remapped between catalog releases. */
const traitLookup = await call("search_traits", { term: "breast carcinoma", limit: 5 });
const traitId = traitLookup.parsed?.results?.find((t) => t.id)?.id;
if (!traitId) {
  fail("resolve trait id", `no trait id returned: ${traitLookup.raw.slice(0, 200)}`);
} else {
  ok(`resolve trait id (search_traits -> ${traitId})`);
}

await check(
  "score search by trait",
  "search_scores",
  { trait_id: traitId ?? "MONDO_0004989", limit: 3 },
  (parsed) => {
    const err = requireResults(1)(parsed);
    if (err) return err;
    const first = parsed.results[0];
    return first?.id?.startsWith("PGS") && first?.ftp_scoring_file
      ? null
      : `score result missing id/ftp_scoring_file: ${JSON.stringify(first).slice(0, 200)}`;
  },
);

await check("score search by PMID", "search_scores", { pmid: 25855707, limit: 2 }, requireResults(1));

await check("score by known IDs", "search_scores", { pgs_ids: ["PGS000001", "PGS000002"] }, requireResults(2));

await check("get score", "get_score", { pgs_id: "PGS000001" }, (parsed) =>
  parsed?.id === "PGS000001" && parsed?.publication?.PMID && parsed?.ancestry_distribution
    ? null
    : `unexpected score payload: ${JSON.stringify(parsed).slice(0, 300)}`,
);

await check("get score with field projection", "get_score", { pgs_id: "PGS000001", fields: "id,name,variants_number,publication.title" }, (parsed) => {
  const keys = Object.keys(parsed ?? {}).join(",");
  if (keys !== "id,name,variants_number,publication") return `projection returned keys: ${keys}`;
  return parsed?.publication?.title ? null : `nested projection lost publication.title: ${JSON.stringify(parsed).slice(0, 200)}`;
});

await check("get score full record", "get_score", { pgs_id: "PGS000001", full: true }, (parsed) =>
  parsed?.samples_variants ? null : "full=true did not return the raw record",
);

await check("unknown score id", "get_score", { pgs_id: "PGS999999" }, (parsed) =>
  parsed?.error === "not_found" ? null : `expected not_found, got: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("get publication", "get_publication", { pgp_id: "PGP000001" }, (parsed) =>
  parsed?.id === "PGP000001" && parsed?.associated_pgs_ids ? null : `unexpected publication: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("publication search by author", "search_publications", { author: "Mavaddat", limit: 2 }, requireResults(1));

await check("publication search by score", "search_publications", { pgs_id: "PGS000001" }, requireResults(1));

await check("get trait", "get_trait", { trait_id: "MONDO_0005350" }, (parsed) =>
  parsed?.id === "MONDO_0005350" && parsed?.label ? null : `unexpected trait: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("performance metrics by score", "search_performance_metrics", { pgs_id: "PGS000001", limit: 2 }, (parsed) => {
  const err = requireResults(1)(parsed);
  if (err) return err;
  return parsed.results[0]?.performance_metrics ? null : "missing performance_metrics block";
});

await check("get performance metric", "get_performance_metric", { ppm_id: "PPM000001" }, (parsed) =>
  parsed?.id === "PPM000001" && parsed?.performance_metrics?.effect_sizes
    ? null
    : `unexpected performance payload: ${JSON.stringify(parsed).slice(0, 250)}`,
);

await check("sample sets by score", "search_sample_sets", { pgs_id: "PGS000001", limit: 2 }, (parsed) => {
  const err = requireResults(1)(parsed);
  if (err) return err;
  return parsed.results[0]?.samples ? null : "missing samples array";
});

await check("get sample set", "get_sample_set", { pss_id: "PSS000070" }, (parsed) =>
  parsed?.id === "PSS000070" && Array.isArray(parsed.samples) ? null : `unexpected sample set: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("list cohorts", "list_cohorts", { limit: 3 }, (parsed) => {
  const err = requireResults(3)(parsed);
  if (err) return err;
  return parsed.results[0]?.name_short ? null : "cohort result missing name_short";
});

await check("get cohort", "get_cohort", { cohort_symbol: "ABCFS", limit: 2 }, requireResults(1));

await check("current release", "get_release", {}, (parsed) =>
  parsed?.date && typeof parsed.score_count === "number" ? null : `unexpected release: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("list releases", "list_releases", { limit: 2 }, requireResults(2));

await check("scores from GWAS study", "get_scores_from_gwas_study", { gcst_id: "GCST001937" }, (parsed) =>
  Array.isArray(parsed?.pgs_ids) && parsed.pgs_ids.length > 0 ? null : `expected pgs_ids: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check(
  "pagination hint",
  "search_scores",
  { trait_id: traitId ?? "MONDO_0004989", limit: 1, offset: 1 },
  (parsed) =>
    parsed?.next_offset === 2 && parsed?.hint ? null : `pagination metadata missing: ${JSON.stringify(parsed).slice(0, 200)}`,
);

await check("missing filter is rejected", "search_scores", {}, (parsed) =>
  parsed?.error === "invalid_arguments" ? null : `expected invalid_arguments, got: ${JSON.stringify(parsed).slice(0, 200)}`,
);

/* ------------------------------------------------- invalid argument path */
const bad = await client.callTool({ name: "get_score", arguments: {} });
if (bad.isError) ok("schema validation rejects missing pgs_id");
else fail("schema validation rejects missing pgs_id", "call unexpectedly succeeded");

await client.close();

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);

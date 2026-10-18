import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PgsApiError, type PgsClient, type QueryParams } from "./client.js";
import { FtpClient } from "./ftp.js";
import {
  buildPagedEnvelope,
  notFound,
  parseFieldList,
  shapeResult,
  toJson,
  type ShapeOptions,
} from "./format.js";

type CallToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const limitArg = z
  .number()
  .int()
  .min(1)
  .max(250)
  .default(50)
  .describe("Results per page. The PGS Catalog default is 50 and the maximum is 250.");

const offsetArg = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Zero-based offset into the full result set, used to page through matches.");

const fieldsArg = z
  .string()
  .optional()
  .describe(
    "Optional comma-separated list of fields to return (dotted paths allowed, e.g. 'id,trait_reported,publication.title'). Omit for the default compact projection.",
  );

const fullArg = z
  .boolean()
  .default(false)
  .describe("Return the complete upstream record including every field. Verbose; use only when the compact projection is not enough.");

const idsArg = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("IDs to fetch, as a comma-separated string or an array of IDs.");

const flagArg = (description: string) => z.boolean().optional().describe(description);

function toIdList(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const list = parseFieldList(value);
  return list?.length ? list.join(",") : undefined;
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PgsApiError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: toJson({
              error: "pgs_catalog_error",
              status: error.status ?? null,
              message: error.message,
              detail: error.detail ?? null,
            }),
          },
        ],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: toJson({ error: "internal_error", message }) }] };
  }
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : toJson(value) }] };
}

function shapeOptions(kind: ShapeOptions["kind"], fields: string | string[] | undefined, full: boolean): ShapeOptions {
  return { kind, fields: parseFieldList(fields), full };
}

async function pagedCall(
  client: PgsClient,
  path: string,
  params: QueryParams,
  limit: number,
  offset: number,
  options: ShapeOptions,
): Promise<CallToolResult> {
  const paged = await client.list(path, { ...params, limit, offset });
  const shaped = paged.results.map((item) => shapeResult(item, options));
  return text(buildPagedEnvelope(paged, shaped, limit, offset));
}

async function objectCall(
  client: PgsClient,
  path: string,
  params: QueryParams,
  kind: ShapeOptions["kind"],
  id: string,
  options: ShapeOptions,
): Promise<CallToolResult> {
  const data = await client.object(path, params);
  if (data === null) return text(notFound(kind, id));
  return text(shapeResult(data, options));
}

export function registerTools(server: McpServer, client: PgsClient, ftp: FtpClient): void {
  /* ------------------------------------------------------------------ Scores */

  server.registerTool(
    "search_scores",
    {
      title: "Search polygenic scores",
      description:
        "Search the PGS Catalog for polygenic scores by publication (PGP ID or PubMed ID) or by trait ontology ID (EFO/HP/MONDO). " +
        "Provide `pgs_ids` alone to fetch a known set of scores directly. Returns scores with traits, publication citation, " +
        "variant counts, weight type, ancestry distribution, license, and the FTP scoring-file URL.",
      inputSchema: {
        pgs_ids: idsArg,
        pgp_id: z.string().optional().describe("PGS Catalog Publication ID (PGP), e.g. PGP000001."),
        pmid: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe("PubMed ID of the publication that developed the score, without the 'PMID:' prefix."),
        trait_id: z
          .string()
          .optional()
          .describe(
            "Trait ontology ID exactly as returned by search_traits or get_trait (e.g. MONDO_0004989 for breast carcinoma). " +
              "IDs shown in upstream API docs may be outdated, so resolve them with search_traits first.",
          ),
        fields: fieldsArg,
        full: fullArg,
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ pgs_ids, pgp_id, pmid, trait_id, fields, full, limit, offset }) =>
      run(async () => {
        const ids = toIdList(pgs_ids);
        const usingFilterOnly = Boolean(ids) && !pgp_id && !pmid && !trait_id;

        if (usingFilterOnly) {
          return pagedCall(client, "score/all", { filter_ids: ids }, limit, offset, shapeOptions("score", fields, full));
        }

        const params: QueryParams = { pgp_id, pmid, trait_id, pgs_ids: ids };
        if (!pgp_id && !pmid && !trait_id && !ids) {
          return text(
            toJson({
              error: "invalid_arguments",
              message:
                "search_scores needs at least one filter. Provide pgs_ids, pgp_id, pmid, or trait_id. " +
                "To browse the whole catalog, use list_trait_categories or search_traits first to find a trait_id.",
            }),
          );
        }
        return pagedCall(client, "score/search", params, limit, offset, shapeOptions("score", fields, full));
      }),
  );

  server.registerTool(
    "get_score",
    {
      title: "Get a polygenic score by ID",
      description:
        "Retrieve one polygenic score by PGS ID (e.g. PGS000001): scoring-file URLs including harmonized GRCh37/GRCh38 files, " +
        "publication citation, reported and mapped traits, variant-development and training samples, ancestry distribution at each " +
        "stage, method parameters, and license terms.",
      inputSchema: {
        pgs_id: z.string().describe("Polygenic Score ID, format PGS followed by 6 digits, e.g. PGS000001."),
        fields: fieldsArg,
        full: fullArg,
      },
      annotations: READ_ONLY,
    },
    ({ pgs_id, fields, full }) =>
      run(() => objectCall(client, `score/${encodeURIComponent(pgs_id)}`, {}, "score", pgs_id, shapeOptions("score", fields, full))),
  );

  /* ----------------------------------------------------------- Publications */

  server.registerTool(
    "search_publications",
    {
      title: "Search PGS Catalog publications",
      description:
        "Search publications in the PGS Catalog by author name, PubMed ID, or an associated score ID. " +
        "Returns citation data plus the PGS IDs each publication developed and evaluated.",
      inputSchema: {
        pgp_ids: idsArg,
        author: z.string().optional().describe("Any author name in the publication's author list, e.g. 'Mavaddat'."),
        pmid: z.union([z.string(), z.number().int()]).optional().describe("PubMed ID without the 'PMID:' prefix."),
        pgs_id: z.string().optional().describe("PGS ID to find the publication that developed that score."),
        fields: fieldsArg,
        full: fullArg,
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ pgp_ids, author, pmid, pgs_id, fields, full, limit, offset }) =>
      run(async () => {
        const ids = toIdList(pgp_ids);
        if (ids && !author && !pmid && !pgs_id) {
          return pagedCall(
            client,
            "publication/all",
            { filter_ids: ids },
            limit,
            offset,
            shapeOptions("publication", fields, full),
          );
        }
        if (!ids && !author && !pmid && !pgs_id) {
          return text(
            toJson({
              error: "invalid_arguments",
              message: "search_publications needs at least one filter: pgp_ids, author, pmid, or pgs_id.",
            }),
          );
        }
        return pagedCall(
          client,
          "publication/search",
          { pgs_id, pmid, author },
          limit,
          offset,
          shapeOptions("publication", fields, full),
        );
      }),
  );

  server.registerTool(
    "get_publication",
    {
      title: "Get a publication by PGP ID",
      description:
        "Retrieve one PGS Catalog publication by PGP ID (e.g. PGP000001): title, journal, DOI, PubMed ID, authors, dates, " +
        "and the PGS IDs associated with it split into development and evaluation.",
      inputSchema: {
        pgp_id: z.string().describe("PGS Catalog Publication ID, format PGP followed by 6 digits, e.g. PGP000001."),
        fields: fieldsArg,
        full: fullArg,
      },
      annotations: READ_ONLY,
    },
    ({ pgp_id, fields, full }) =>
      run(() =>
        objectCall(client, `publication/${encodeURIComponent(pgp_id)}`, {}, "publication", pgp_id, shapeOptions("publication", fields, full)),
      ),
  );

  /* ----------------------------------------------------------------- Traits */

  server.registerTool(
    "search_traits",
    {
      title: "Search traits (ontology terms)",
      description:
        "Search PGS Catalog traits by name, trait category, synonym, ontology ID, or external mapped term " +
        "(e.g. 'breast cancer', 'Neurological disorder', 'ICD10:I25', 'OMIM:605526'). " +
        "Always use this first to resolve a human-readable condition into the exact EFO/MONDO/HP ID that search_scores expects — " +
        "ontology IDs change between catalog releases, so do not assume an ID from documentation or memory. " +
        "Child ontology terms are included by default.",
      inputSchema: {
        term: z
          .string()
          .optional()
          .describe("Trait name, category, synonym, ontology ID, or external mapped term. Required unless trait_ids is given."),
        exact: flagArg("Match only the exact term instead of partial matches. Defaults to false."),
        include_children: flagArg("Include child ontology terms of the matched trait. Defaults to true."),
        trait_ids: idsArg,
        include_child_associated_pgs_ids: flagArg(
          "Also list PGS IDs associated with child traits. Only applies when trait_ids is used.",
        ),
        include_parents: flagArg("Include parent ontology terms. Only applies when trait_ids is used."),
        fields: fieldsArg,
        full: fullArg,
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ term, exact, include_children, trait_ids, include_child_associated_pgs_ids, include_parents, fields, full, limit, offset }) =>
      run(async () => {
        const ids = toIdList(trait_ids);
        if (ids) {
          return pagedCall(
            client,
            "trait/all",
            {
              filter_ids: ids,
              include_child_associated_pgs_ids,
              include_parents,
            },
            limit,
            offset,
            shapeOptions("trait", fields, full),
          );
        }
        if (!term) {
          return text(
            toJson({
              error: "invalid_arguments",
              message: "search_traits needs either `term` (a name, category, synonym or mapped term) or `trait_ids` (known ontology IDs).",
            }),
          );
        }
        return pagedCall(
          client,
          "trait/search",
          { term, exact, include_children },
          limit,
          offset,
          shapeOptions("trait", fields, full),
        );
      }),
  );

  server.registerTool(
    "get_trait",
    {
      title: "Get a trait by ontology ID",
      description:
        "Retrieve one trait by ontology ID (e.g. MONDO_0004989): label, description, synonyms, external mapped terms, " +
        "trait categories, and the PGS IDs associated with it (and optionally its child terms).",
      inputSchema: {
        trait_id: z
          .string()
          .describe("Ontology trait ID exactly as returned by search_traits, e.g. MONDO_0004989, EFO_0004337, HP_0000001."),
        include_children: flagArg("Include the child terms of this trait. Defaults to true."),
        fields: fieldsArg,
        full: fullArg,
      },
      annotations: READ_ONLY,
    },
    ({ trait_id, include_children, fields, full }) =>
      run(() =>
        objectCall(
          client,
          `trait/${encodeURIComponent(trait_id)}`,
          { include_children },
          "trait",
          trait_id,
          shapeOptions("trait", fields, full),
        ),
      ),
  );

  server.registerTool(
    "list_trait_categories",
    {
      title: "List trait categories",
      description:
        "List the higher-level trait categories used to group traits in the PGS Catalog (for example Cancer, Cardiovascular " +
        "disorder, Neurological disorder) together with the ontology terms in each category. A good starting point for " +
        "exploratory questions such as 'what polygenic scores exist for cancer'.",
      inputSchema: {
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ limit, offset }) =>
      run(() => pagedCall(client, "trait_category/all", {}, limit, offset, shapeOptions("trait_category", undefined, false))),
  );

  /* ------------------------------------------------- Performance metrics */

  server.registerTool(
    "search_performance_metrics",
    {
      title: "Search reported performance metrics",
      description:
        "Search reported PGS performance metrics (odds ratio, beta, hazard ratio, C-index/AUC, variance explained, …) by score, " +
        "publication, or PubMed ID. Each result includes the metric estimates with confidence intervals, the samples used for " +
        "evaluation with their ancestry and cohorts, and the covariates that were adjusted for.",
      inputSchema: {
        ppm_ids: idsArg,
        pgs_id: z.string().optional().describe("PGS ID to list reported performance metrics for."),
        pgp_id: z.string().optional().describe("PGS Catalog Publication ID (PGP)."),
        pmid: z.union([z.string(), z.number().int()]).optional().describe("PubMed ID without the 'PMID:' prefix."),
        fields: fieldsArg,
        full: fullArg,
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ ppm_ids, pgs_id, pgp_id, pmid, fields, full, limit, offset }) =>
      run(async () => {
        const ids = toIdList(ppm_ids);
        if (ids && !pgs_id && !pgp_id && !pmid) {
          return pagedCall(
            client,
            "performance/all",
            { filter_ids: ids },
            limit,
            offset,
            shapeOptions("performance", fields, full),
          );
        }
        if (!ids && !pgs_id && !pgp_id && !pmid) {
          return text(
            toJson({
              error: "invalid_arguments",
              message: "search_performance_metrics needs at least one filter: ppm_ids, pgs_id, pgp_id, or pmid.",
            }),
          );
        }
        return pagedCall(
          client,
          "performance/search",
          { pgs_id, pgp_id, pmid },
          limit,
          offset,
          shapeOptions("performance", fields, full),
        );
      }),
  );

  server.registerTool(
    "get_performance_metric",
    {
      title: "Get a performance metric by PPM ID",
      description:
        "Retrieve one reported performance metric by PPM ID (e.g. PPM000001): metric estimates with confidence intervals and " +
        "standard errors, the trait and phenotyping method, covariates, the associated score, and the evaluation samples.",
      inputSchema: {
        ppm_id: z.string().describe("PGS Performance Metric ID, format PPM followed by 6 digits, e.g. PPM000001."),
        fields: fieldsArg,
        full: fullArg,
      },
      annotations: READ_ONLY,
    },
    ({ ppm_id, fields, full }) =>
      run(() =>
        objectCall(
          client,
          `performance/${encodeURIComponent(ppm_id)}`,
          {},
          "performance",
          ppm_id,
          shapeOptions("performance", fields, full),
        ),
      ),
  );

  /* --------------------------------------------------------------- Samples */

  server.registerTool(
    "search_sample_sets",
    {
      title: "Search sample sets",
      description:
        "Search PGS sample sets (the groups of participants used to evaluate a score) by score, publication, or PubMed ID. " +
        "Each sample set lists participant counts, ancestry breakdowns, age and follow-up data, and the cohorts involved.",
      inputSchema: {
        pss_ids: idsArg,
        pgs_id: z.string().optional().describe("PGS ID to list sample sets for."),
        pgp_id: z.string().optional().describe("PGS Catalog Publication ID (PGP)."),
        pmid: z.union([z.string(), z.number().int()]).optional().describe("PubMed ID without the 'PMID:' prefix."),
        fields: fieldsArg,
        full: fullArg,
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ pss_ids, pgs_id, pgp_id, pmid, fields, full, limit, offset }) =>
      run(async () => {
        const ids = toIdList(pss_ids);
        if (ids && !pgs_id && !pgp_id && !pmid) {
          return pagedCall(
            client,
            "sample_set/all",
            { filter_ids: ids },
            limit,
            offset,
            shapeOptions("sample_set", fields, full),
          );
        }
        if (!ids && !pgs_id && !pgp_id && !pmid) {
          return text(
            toJson({
              error: "invalid_arguments",
              message: "search_sample_sets needs at least one filter: pss_ids, pgs_id, pgp_id, or pmid.",
            }),
          );
        }
        return pagedCall(
          client,
          "sample_set/search",
          { pgs_id, pgp_id, pmid },
          limit,
          offset,
          shapeOptions("sample_set", fields, full),
        );
      }),
  );

  server.registerTool(
    "get_sample_set",
    {
      title: "Get a sample set by PSS ID",
      description:
        "Retrieve one sample set by PSS ID (e.g. PSS000070): every sample with participant counts, ancestry, cohorts, " +
        "phenotyping details, and follow-up information.",
      inputSchema: {
        pss_id: z.string().describe("PGS Sample Set ID, format PSS followed by 6 digits, e.g. PSS000070."),
        fields: fieldsArg,
        full: fullArg,
      },
      annotations: READ_ONLY,
    },
    ({ pss_id, fields, full }) =>
      run(() =>
        objectCall(
          client,
          `sample_set/${encodeURIComponent(pss_id)}`,
          {},
          "sample_set",
          pss_id,
          shapeOptions("sample_set", fields, full),
        ),
      ),
  );

  server.registerTool(
    "list_cohorts",
    {
      title: "List cohorts",
      description:
        "List study cohorts referenced by the PGS Catalog (for example UK Biobank, NHS, ABCFS, ESTHER, PROFILE) with their full " +
        "names and the PGS IDs that used them for development or evaluation. Provide `cohort_symbols` to look up specific cohorts.",
      inputSchema: {
        cohort_symbols: idsArg,
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ cohort_symbols, limit, offset }) =>
      run(() =>
        pagedCall(
          client,
          "cohort/all",
          { filter_ids: toIdList(cohort_symbols) },
          limit,
          offset,
          shapeOptions("cohort", undefined, false),
        ),
      ),
  );

  server.registerTool(
    "get_cohort",
    {
      title: "Get a cohort by symbol",
      description:
        "Look up a cohort by short symbol (e.g. ABCFS, NHS, UKB). Cohort symbols are not guaranteed to be unique, so this " +
        "may return several matches with their full names and associated PGS IDs.",
      inputSchema: {
        cohort_symbol: z.string().describe("Short cohort symbol, e.g. ABCFS, ESTHER, NHS, PROFILE."),
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ cohort_symbol, limit, offset }) =>
      run(() =>
        pagedCall(
          client,
          `cohort/${encodeURIComponent(cohort_symbol)}`,
          {},
          limit,
          offset,
          shapeOptions("cohort", undefined, false),
        ),
      ),
  );

  /* ------------------------------------------------------------- Releases */

  server.registerTool(
    "get_release",
    {
      title: "Get a PGS Catalog release",
      description:
        "Get release details: release date and the counts and IDs of newly added scores, publications, performance metrics, and " +
        "traits. Omit `release_date` to get the current release.",
      inputSchema: {
        release_date: z
          .string()
          .optional()
          .describe("Release date in YYYY-MM-DD format. Omit to return the current release."),
        fields: fieldsArg,
        full: fullArg,
      },
      annotations: READ_ONLY,
    },
    ({ release_date, fields, full }) =>
      run(() =>
        objectCall(
          client,
          release_date ? `release/${encodeURIComponent(release_date)}` : "release/current",
          {},
          "release",
          release_date ?? "current",
          shapeOptions("release", fields, full),
        ),
      ),
  );

  server.registerTool(
    "list_releases",
    {
      title: "List PGS Catalog releases",
      description: "List all PGS Catalog releases, most recent first, with counts and IDs of newly added content.",
      inputSchema: {
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    ({ limit, offset }) =>
      run(() => pagedCall(client, "release/all", {}, limit, offset, shapeOptions("release", undefined, false))),
  );

  /* --------------------------------------------------------------- Catalog */

  server.registerTool(
    "get_catalog_info",
    {
      title: "Get PGS Catalog info and citation",
      description:
        "Get PGS Catalog metadata: REST API version and changelog, latest release date, counts of scores/traits/publications, " +
        "the PGS Catalog citation (title, DOI, PubMed ID, authors, journal, year), the Ensembl version used for harmonized " +
        "scoring files, and the terms of use. Use this to cite the catalog correctly.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run(async () => text(await client.get("info"))),
  );

  server.registerTool(
    "get_ancestry_categories",
    {
      title: "Decode ancestry category codes",
      description:
        "Map the three-letter ancestry symbols used in PGS Catalog data (EUR, AFR, EAS, SAS, AMR, GME, MAE, MAO, …) to their " +
        "full display names and underlying categories. Use this before interpreting any ancestry_distribution field.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run(async () => text(await client.get("ancestry_categories"))),
  );

  server.registerTool(
    "get_api_versions",
    {
      title: "Get REST API version history",
      description: "List the current and previous PGS Catalog REST API versions with their dates and changelogs.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run(async () => text(await client.get("api_versions"))),
  );

  server.registerTool(
    "get_scores_from_gwas_study",
    {
      title: "Find scores built from a GWAS study",
      description:
        "Given an NHGRI-EBI GWAS Catalog study ID (GCST), return the PGS IDs that used that study as the source of variant " +
        "associations. Useful for tracing a GWAS finding into the polygenic scores derived from it.",
      inputSchema: {
        gcst_id: z.string().describe("NHGRI-EBI GWAS Catalog study ID, e.g. GCST001937."),
      },
      annotations: READ_ONLY,
    },
    ({ gcst_id }) =>
      run(async () => {
        const ids = await client.get(`gwas/get_score_ids/${encodeURIComponent(gcst_id)}`);
        const list = Array.isArray(ids) ? ids : [];
        return text(
          toJson({
            gcst_id,
            score_count: list.length,
            pgs_ids: list,
            hint: list.length
              ? "Pass these IDs to search_scores with pgs_ids to get full score details."
              : "No polygenic scores in the catalog reference this GWAS study.",
          }),
        );
      }),
  );

  /* --------------------------------------------------------------- FTP site */

  const pgsIdArg = z
    .string()
    .describe("PGS ID, format PGS followed by 6 digits, e.g. PGS000001.");

  server.registerTool(
    "list_ftp_scores",
    {
      title: "List PGS score directories on the FTP site",
      description:
        "List all PGS score directories available on the PGS Catalog FTP site " +
        "(https://ftp.ebi.ac.uk/pub/databases/spot/pgs/scores/). Each directory is named " +
        "after a PGS ID (PGS000001, PGS000002, …) and contains ScoringFiles/ and Metadata/ subdirectories. " +
        "Use this to discover which scores have scoring files available for download.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        try {
          const entries = await ftp.listScores();
          return text(
            toJson({
              base: ftpBase(),
              count: entries.length,
              scores: entries.map((e) => ({ id: e.name })),
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text", text: toJson({ error: "ftp_error", message }) }] };
        }
      }),
  );

  server.registerTool(
    "list_ftp_score_directory",
    {
      title: "List a score's FTP directory contents",
      description:
        "List the subdirectories and files inside a score's FTP directory " +
        "(e.g. PGS000001/). Returns the ScoringFiles/ and Metadata/ subdirectories " +
        "and any other entries. Use list_ftp_scoring_files or list_ftp_metadata_files " +
        "to enumerate the actual downloadable files.",
      inputSchema: {
        pgs_id: pgsIdArg,
      },
      annotations: READ_ONLY,
    },
    ({ pgs_id }) =>
      run(async () => {
        try {
          const entries = await ftp.listScoreDirectory(pgs_id);
          return text(
            toJson({
              pgs_id,
              base: ftpBase(),
              entries,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text", text: toJson({ error: "ftp_error", message }) }] };
        }
      }),
  );

  server.registerTool(
    "list_ftp_scoring_files",
    {
      title: "List a score's scoring files",
      description:
        "List the downloadable scoring files in a score's ScoringFiles/ directory " +
        "(e.g. PGS000001/ScoringFiles/). Returns file names, sizes, and modification dates. " +
        "Harmonized files live in the Harmonized/ subdirectory. Use get_ftp_file to download a file's contents.",
      inputSchema: {
        pgs_id: pgsIdArg,
      },
      annotations: READ_ONLY,
    },
    ({ pgs_id }) =>
      run(async () => {
        try {
          const entries = await ftp.listScoringFiles(pgs_id);
          return text(
            toJson({
              pgs_id,
              base: ftpBase(),
              directory: `${pgs_id}/ScoringFiles/`,
              count: entries.length,
              files: entries,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text", text: toJson({ error: "ftp_error", message }) }] };
        }
      }),
  );

  server.registerTool(
    "list_ftp_metadata_files",
    {
      title: "List a score's metadata files",
      description:
        "List the downloadable metadata files in a score's Metadata/ directory " +
        "(e.g. PGS000001/Metadata/). Returns file names, sizes, and modification dates. " +
        "Metadata includes CSVs for cohorts, EFO traits, evaluation sample sets, performance metrics, " +
        "publications, score development samples, and scores, plus a metadata archive and Excel workbook. " +
        "Use get_ftp_file to download a file's contents.",
      inputSchema: {
        pgs_id: pgsIdArg,
      },
      annotations: READ_ONLY,
    },
    ({ pgs_id }) =>
      run(async () => {
        try {
          const entries = await ftp.listMetadataFiles(pgs_id);
          return text(
            toJson({
              pgs_id,
              base: ftpBase(),
              directory: `${pgs_id}/Metadata/`,
              count: entries.length,
              files: entries,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text", text: toJson({ error: "ftp_error", message }) }] };
        }
      }),
  );

  server.registerTool(
    "get_ftp_file",
    {
      title: "Download a file from the FTP site",
      description:
        "Download the raw text content of a file from the PGS Catalog FTP site. " +
        "Provide a path relative to the FTP root, e.g. " +
        "`PGS000001/ScoringFiles/PGS000001.txt.gz` or " +
        "`PGS000001/Metadata/PGS000001_metadata_scores.csv`. " +
        "Binary files (e.g. .gz) are returned as base64-encoded text; text files (e.g. .csv) are returned as-is.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Path to the file on the FTP site, relative to the scores root. " +
              "Example: PGS000001/Metadata/PGS000001_metadata_scores.csv",
          ),
      },
      annotations: READ_ONLY,
    },
    ({ path }) =>
      run(async () => {
        try {
          const content = await ftp.getFileText(path);
          return text(
            toJson({
              path,
              base: ftpBase(),
              content,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text", text: toJson({ error: "ftp_error", message }) }] };
        }
      }),
  );
}

/** Base URL of the FTP site, for reporting in tool results. */
function ftpBase(): string {
  return "https://ftp.ebi.ac.uk/pub/databases/spot/pgs/scores";
}

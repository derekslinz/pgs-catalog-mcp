/**
 * Output shaping helpers.
 *
 * PGS Catalog records are large (ancestry distributions, sample lists, nested
 * publications). Returning every field burns a lot of model context, so each
 * tool applies a compact default projection and lets the caller widen it with
 * the `fields` argument.
 */

import type { PagedResult } from "./client.js";

export type Record_ = Record<string, unknown>;

export function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split a comma-separated field list, tolerating spaces and JSON-array syntax. */
export function parseFieldList(input?: string | string[]): string[] | undefined {
  if (!input) return undefined;
  const raw = Array.isArray(input) ? input.join(",") : input;
  const tokens = raw
    .replace(/^\s*\[|\]\s*$/g, "")
    .split(/[,\s]+/)
    .map((t) => t.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
  return tokens.length ? tokens : undefined;
}

/**
 * Resolve a dotted path against a value.
 *
 * Returns the value together with the path prefix that actually addresses it.
 * When the path crosses an array, the remaining segments are applied to each
 * element and the result is a row-wise array of objects addressed at the
 * array's own path - so `efotraits.id` yields `efotraits: [{ id }, ...]`
 * rather than a columnar `efotraits: { id: [...] }`.
 */
function walk(
  value: unknown,
  parts: string[],
  consumed: string[],
): { prefix: string[]; value: unknown } | undefined {
  const [head, ...rest] = parts;

  if (head === undefined) return { prefix: consumed, value };

  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, head)) return undefined;

  const child = value[head];
  const childPrefix = [...consumed, head];

  if (Array.isArray(child)) {
    if (rest.length === 0) return { prefix: childPrefix, value: child };
    const rows = child
      .map((item) => project(item, [rest.join(".")]))
      .filter((row) => isRecord(row) && Object.keys(row).length > 0);
    if (rows.length === 0) return undefined;
    return { prefix: childPrefix, value: rows };
  }

  return walk(child, rest, childPrefix);
}

/** Write a value at a dotted path, creating intermediate objects as needed. */
function setDeep(target: Record_, parts: string[], value: unknown): void {
  let cursor: Record_ = target;
  for (const key of parts.slice(0, -1)) {
    const existing = cursor[key];
    if (!isRecord(existing)) cursor[key] = {};
    cursor = cursor[key] as Record_;
  }

  const lastKey = parts[parts.length - 1] as string;
  const existing = cursor[lastKey];

  // Two paths into the same array (`efotraits.id` + `efotraits.label`) must
  // combine into one row per element rather than overwrite each other.
  if (Array.isArray(existing) && Array.isArray(value)) {
    const merged = existing.slice();
    for (let i = 0; i < value.length; i++) {
      const incoming = value[i];
      const current = merged[i];
      merged[i] = isRecord(current) && isRecord(incoming) ? { ...current, ...incoming } : incoming;
    }
    cursor[lastKey] = merged;
    return;
  }

  cursor[lastKey] = value;
}

/**
 * Project an object down to `fields`. Dotted paths such as `publication.title`
 * reproduce the upstream nesting. Missing keys are skipped rather than emitted as null.
 */
export function project(value: unknown, fields?: string[]): unknown {
  if (!fields || !fields.length) return value;
  if (!isRecord(value)) return value;

  const out: Record_ = {};
  for (const field of fields) {
    const parts = field.split(".").filter(Boolean);
    if (parts.length === 0) continue;
    const found = walk(value, parts, []);
    if (found) setDeep(out, found.prefix, found.value);
  }
  return out;
}

/** Drop null / empty-array values to keep payloads lean. */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((v) => v !== null && !(v === undefined));
    return items;
  }
  if (isRecord(value)) {
    const out: Record_ = {};
    for (const [key, raw] of Object.entries(value)) {
      const cleaned = prune(raw);
      if (cleaned === null || cleaned === undefined) continue;
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      if (isRecord(cleaned) && Object.keys(cleaned).length === 0) continue;
      out[key] = cleaned;
    }
    return out;
  }
  return value;
}

const SCORE_FIELDS = [
  "id",
  "name",
  "trait_reported",
  "trait_efo",
  "method_name",
  "method_params",
  "variants_number",
  "variants_genomebuild",
  "weight_type",
  "license",
  "date_release",
  "ftp_scoring_file",
  "publication.id",
  "publication.title",
  "publication.PMID",
  "publication.doi",
  "publication.journal",
  "publication.firstauthor",
  "ancestry_distribution",
];

const PUBLICATION_FIELDS = [
  "id",
  "title",
  "PMID",
  "doi",
  "journal",
  "firstauthor",
  "authors",
  "date_publication",
  "date_release",
  "associated_pgs_ids",
];

const TRAIT_FIELDS = [
  "id",
  "label",
  "description",
  "url",
  "trait_categories",
  "trait_synonyms",
  "trait_mapped_terms",
  "associated_pgs_ids",
  "child_traits",
  "child_associated_pgs_ids",
];

const TRAIT_CATEGORY_FIELDS = ["label", "efotraits.id", "efotraits.label"];

const PERFORMANCE_FIELDS = [
  "id",
  "associated_pgs_id",
  "performance_metrics",
  "phenotyping_reported",
  "covariates",
  "performance_comments",
  "publication.id",
  "publication.title",
  "publication.PMID",
  "sampleset.id",
  "sampleset.samples",
];

const SAMPLE_SET_FIELDS = ["id", "samples"];
const COHORT_FIELDS = ["name_short", "name_full", "name_others", "associated_pgs_ids"];
const RELEASE_FIELDS = [
  "date",
  "score_count",
  "publication_count",
  "performance_count",
  "efotrait_count",
  "notes",
  "released_score_ids",
  "released_publication_ids",
  "released_performance_ids",
  "released_new_trait_ids",
];

export const DEFAULT_FIELDS: Record<string, string[]> = {
  score: SCORE_FIELDS,
  publication: PUBLICATION_FIELDS,
  trait: TRAIT_FIELDS,
  trait_category: TRAIT_CATEGORY_FIELDS,
  performance: PERFORMANCE_FIELDS,
  sample_set: SAMPLE_SET_FIELDS,
  cohort: COHORT_FIELDS,
  release: RELEASE_FIELDS,
};

export interface ShapeOptions {
  kind: keyof typeof DEFAULT_FIELDS;
  /** Explicit field list from the caller; overrides the default projection. */
  fields?: string[];
  /** When true, return the raw upstream object untouched. */
  full?: boolean;
}

export function shapeResult(item: unknown, options: ShapeOptions): unknown {
  if (options.full) return item;
  const fields = options.fields?.length ? options.fields : DEFAULT_FIELDS[options.kind];
  const projected = project(item, fields);
  return prune(projected) ?? null;
}

export interface PagedEnvelope {
  count: number | null;
  returned: number;
  results: unknown[];
  next_offset: number | null;
  hint?: string;
}

export function buildPagedEnvelope(paged: PagedResult, shaped: unknown[], limit: number, offset: number): PagedEnvelope {
  const returned = shaped.length;
  const hasMore = paged.count !== null ? offset + returned < paged.count : Boolean(paged.next);
  const nextOffset = offset + limit;

  const envelope: PagedEnvelope = {
    count: paged.count,
    returned,
    results: shaped,
    next_offset: hasMore ? nextOffset : null,
  };

  if (hasMore) {
    envelope.hint =
      `Showing ${offset + 1}-${offset + returned} of ${paged.count ?? "an unknown number"} matches. ` +
      `Call again with offset=${nextOffset} to continue.`;
  }
  return envelope;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function notFound(kind: string, id: string): string {
  return JSON.stringify(
    {
      error: "not_found",
      message: `No ${kind} found for "${id}". Verify the ID format (PGS/PGP/PSS/PPM are 6-digit zero-padded; traits are ontology IDs such as EFO_0000305).`,
    },
    null,
    2,
  );
}

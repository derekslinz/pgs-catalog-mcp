import assert from "node:assert/strict";
import { test } from "node:test";

import { PgsClient, PgsApiError } from "../dist/client.js";
import { buildPagedEnvelope, notFound, parseFieldList, prune, project, shapeResult } from "../dist/format.js";

/* ------------------------------------------------------------ field lists */

test("parseFieldList handles comma strings, arrays, brackets and quotes", () => {
  assert.deepEqual(parseFieldList("id, name ,trait_reported"), ["id", "name", "trait_reported"]);
  assert.deepEqual(parseFieldList(["id", "name"]), ["id", "name"]);
  assert.deepEqual(parseFieldList('["id","publication.title"]'), ["id", "publication.title"]);
  assert.equal(parseFieldList(undefined), undefined);
  assert.equal(parseFieldList("   "), undefined);
});

/* -------------------------------------------------------------- projection */

test("project keeps only the requested top-level fields", () => {
  const record = { id: "PGS000001", name: "PRS77_BC", extra: "drop me" };
  assert.deepEqual(project(record, ["id", "name"]), { id: "PGS000001", name: "PRS77_BC" });
});

test("project reproduces nested objects for dotted paths", () => {
  const record = {
    id: "PGS000001",
    publication: { id: "PGP000001", title: "A paper", journal: "J" },
    ancestry_distribution: { gwas: { count: 100 } },
  };
  assert.deepEqual(project(record, ["id", "publication.id", "publication.title"]), {
    id: "PGS000001",
    publication: { id: "PGP000001", title: "A paper" },
  });
  assert.deepEqual(project(record, ["ancestry_distribution.gwas.count"]), {
    ancestry_distribution: { gwas: { count: 100 } },
  });
});

test("project maps a dotted path across arrays", () => {
  const record = { efotraits: [{ id: "EFO_1", label: "a", url: "u" }, { id: "EFO_2", label: "b", url: "u" }] };
  assert.deepEqual(project(record, ["efotraits.id", "efotraits.label"]), {
    efotraits: [{ id: "EFO_1", label: "a" }, { id: "EFO_2", label: "b" }],
  });
});

test("project skips missing fields instead of emitting nulls", () => {
  assert.deepEqual(project({ id: "x" }, ["id", "nope", "also.missing"]), { id: "x" });
});

test("project returns the value untouched when no fields are requested", () => {
  const record = { a: 1 };
  assert.equal(project(record, undefined), record);
  assert.equal(project(record, []), record);
});

/* ---------------------------------------------------------------- pruning */

test("prune removes nulls, empty arrays and empty objects", () => {
  const record = {
    id: "PGS1",
    license: null,
    cohorts: [],
    nested: { a: null, b: 2 },
    empty: {},
    list: [{ keep: 1, drop: null }],
  };
  assert.deepEqual(prune(record), { id: "PGS1", nested: { b: 2 }, list: [{ keep: 1 }] });
});

test("shapeResult applies the default projection for a known kind", () => {
  const score = {
    id: "PGS000001",
    name: "PRS77_BC",
    internal_junk: "x",
    publication: { id: "PGP000001", title: "t", junk: "y" },
    license: null,
  };
  const out = shapeResult(score, { kind: "score", full: false });
  assert.equal(out.id, "PGS000001");
  assert.equal(out.internal_junk, undefined);
  assert.equal(out.license, undefined);
  assert.deepEqual(out.publication, { id: "PGP000001", title: "t" });
});

test("shapeResult returns the raw record when full is set", () => {
  const record = { id: "x", internal_junk: "kept" };
  assert.deepEqual(shapeResult(record, { kind: "score", full: true }), record);
});

/* ------------------------------------------------------------ pagination */

const paged = (count, results, next = null) => ({ count, size: results.length, next, previous: null, results });

test("buildPagedEnvelope reports the next offset and a hint while more remain", () => {
  const envelope = buildPagedEnvelope(paged(145, ["a"]), ["a"], 1, 1);
  assert.equal(envelope.count, 145);
  assert.equal(envelope.returned, 1);
  assert.equal(envelope.next_offset, 2);
  assert.match(envelope.hint ?? "", /Showing 2-2 of 145 matches\. Call again with offset=2/);
});

test("buildPagedEnvelope stops advertising more results at the end of a page", () => {
  const envelope = buildPagedEnvelope(paged(2, ["a", "b"]), ["a", "b"], 50, 0);
  assert.equal(envelope.next_offset, null);
  assert.equal(envelope.hint, undefined);
});

test("buildPagedEnvelope falls back to the next link when count is absent", () => {
  const envelope = buildPagedEnvelope(paged(null, ["a"], "https://x?offset=50"), ["a"], 50, 0);
  assert.equal(envelope.next_offset, 50);
});

test("notFound explains the expected ID formats", () => {
  const parsed = JSON.parse(notFound("score", "PGS999999"));
  assert.equal(parsed.error, "not_found");
  assert.match(parsed.message, /PGS999999/);
});

/* ---------------------------------------------------------------- client */

test("client encodes arrays as comma-separated query values and booleans as 1/0", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } });
  })

  try {
    const client = new PgsClient({ baseUrl: "https://example.test/rest" });
    await client.list("score/all", { filter_ids: ["PGS000001", "PGS000002"], include_parents: true, skip: undefined });
    const url = new URL(seen[0] ?? "");
    assert.equal(url.origin + url.pathname, "https://example.test/rest/score/all");
    assert.equal(url.searchParams.get("filter_ids"), "PGS000001,PGS000002");
    assert.equal(url.searchParams.get("include_parents"), "1");
    assert.equal(url.searchParams.has("skip"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("client normalises a paginated envelope", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ size: 2, count: 10, next: "https://x?offset=2", previous: null, results: [1, 2] }), {
      headers: { "content-type": "application/json" },
    }));

  try {
    const result = await new PgsClient().list("score/all");
    assert.equal(result.count, 10);
    assert.deepEqual(result.results, [1, 2]);
  } finally {
    globalThis.fetch = original;
  }
});

test("client treats an empty object as 'not found'", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  try {
    assert.equal(await new PgsClient().object("score/PGS999999"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("client unwraps a single-element paginated response for object endpoints", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ size: 1, count: 1, next: null, previous: null, results: [{ id: "ABCFS" }] }), {
      headers: { "content-type": "application/json" },
    }));
  try {
    assert.deepEqual(await new PgsClient().object("cohort/ABCFS"), { id: "ABCFS" });
  } finally {
    globalThis.fetch = original;
  }
});

test("client surfaces a JSON error message from the API", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error_status: 400, message: "bad limit" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
  try {
    await assert.rejects(() => new PgsClient({ maxRetries: 0 }).get("score/all"), (error) => {
      assert.ok(error instanceof PgsApiError);
      assert.equal(error.status, 400);
      assert.match(error.message, /bad limit/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("client reports an HTML error page as a non-JSON response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>Internal Server Error</html>", { status: 500 }));
  try {
    await assert.rejects(() => new PgsClient({ maxRetries: 0 }).get("score/all"), (error) => {
      assert.ok(error instanceof PgsApiError);
      assert.equal(error.status, 500);
      assert.match(error.message, /non-JSON response/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("client retries a 5xx and succeeds on the second attempt", async () => {
  const original = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (async () => {
    attempt += 1;
    if (attempt === 1) return new Response("<html>boom</html>", { status: 502 });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  })
  try {
    assert.deepEqual(await new PgsClient({ maxRetries: 2 }).get("info"), { ok: true });
    assert.equal(attempt, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("client waits out a 429 rate limit and retries", async () => {
  const original = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (async () => {
    attempt += 1;
    if (attempt === 1) {
      return new Response(JSON.stringify({ message: "request limit exceeded", availableIn: "1 seconds" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  })
  try {
    assert.deepEqual(await new PgsClient({ maxRetries: 1 }).get("info"), { ok: true });
    assert.equal(attempt, 2);
  } finally {
    globalThis.fetch = original;
  }
});

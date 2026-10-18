/**
 * Minimal, defensive HTTP client for the PGS Catalog REST API.
 *
 * API contract (v1.8.6):
 *   - Base: https://www.pgscatalog.org/rest
 *   - Pagination: { size, count, next, previous, results } for list endpoints.
 *   - `limit` max is 250, default 50. `offset` is 0-based.
 *   - Rate limit: 100 queries/minute.
 *   - Unknown IDs return HTTP 200 with an empty JSON object `{}`.
 *   - Malformed params can return an HTML 500 page rather than JSON.
 */

export const DEFAULT_BASE_URL = "https://www.pgscatalog.org/rest";

export class PgsApiError extends Error {
  status?: number;
  detail?: string;

  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = "PgsApiError";
    this.status = status;
    this.detail = detail;
  }
}

export interface PagedResult<T = unknown> {
  count: number | null;
  size: number | null;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface QueryParams {
  [key: string]: string | number | boolean | string[] | number[] | undefined | null;
}

export interface PgsClientOptions {
  baseUrl?: string;
  /** Stay safely under the documented 100 req/min limit. */
  maxRequestsPerMinute?: number;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sliding-window limiter so we never trip the upstream 100 req/min cap. */
class SlidingWindowLimiter {
  private stamps: number[] = [];

  constructor(private readonly max: number, private readonly windowMs = 60_000) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      const oldest = this.stamps[0] ?? now;
      await sleep(Math.max(50, this.windowMs - (now - oldest) + 25));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max = 400): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export class PgsClient {
  private readonly baseUrl: string;
  private readonly limiter: SlidingWindowLimiter;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: PgsClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.limiter = new SlidingWindowLimiter(options.maxRequestsPerMinute ?? 90);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.userAgent = options.userAgent ?? "pgs-catalog-mcp/0.1.0 (+https://github.com/lderek/pgs-catalog-mcp)";
  }

  get base(): string {
    return this.baseUrl;
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`);
    if (params) {
      for (const [key, raw] of Object.entries(params)) {
        if (raw === undefined || raw === null || raw === "") continue;
        const value = Array.isArray(raw)
          ? raw
              .map((v) => String(v).trim())
              .filter(Boolean)
              .join(",")
          : typeof raw === "boolean"
            ? raw
              ? "1"
              : "0"
            : String(raw);
        if (value === "") continue;
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /** Perform a GET, with rate limiting, timeouts and bounded retries. */
  async get(path: string, params?: QueryParams): Promise<unknown> {
    const url = this.buildUrl(path, params);
    let lastError: PgsApiError | Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        lastError = new PgsApiError(`Request to ${url} failed: ${reason}`);
        if (attempt < this.maxRetries) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        break;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      if (response.status === 429) {
        const parsed = tryParseJson(body);
        const availableIn =
          isRecord(parsed) && typeof parsed.availableIn === "string" ? parsed.availableIn : undefined;
        lastError = new PgsApiError(
          `PGS Catalog rate limit reached${availableIn ? `; available again in ${availableIn}` : ""}.`,
          429,
        );
        if (attempt < this.maxRetries) {
          await sleep(2_000 * (attempt + 1));
          continue;
        }
        break;
      }

      if (!contentType.includes("json")) {
        // The API returns an HTML error page for some malformed requests.
        lastError = new PgsApiError(
          `PGS Catalog returned HTTP ${response.status} with a non-JSON response.`,
          response.status,
          truncate(body),
        );
        if (response.status >= 500 && attempt < this.maxRetries) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        break;
      }

      if (!response.ok) {
        const parsed = tryParseJson(body);
        const message =
          isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`;
        lastError = new PgsApiError(`PGS Catalog error: ${message}`, response.status, truncate(body));
        if (response.status >= 500 && attempt < this.maxRetries) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        break;
      }

      const data = tryParseJson(body);
      if (data === undefined) {
        throw new PgsApiError("Could not parse the PGS Catalog response as JSON.", response.status, truncate(body));
      }
      return data;
    }

    throw lastError ?? new PgsApiError(`Request to ${url} failed.`);
  }

  /**
   * Fetch a paginated endpoint and normalise it into a PagedResult.
   * Endpoints such as /rest/cohort/{symbol} return a paginated envelope too.
   */
  async list(path: string, params?: QueryParams): Promise<PagedResult> {
    const data = await this.get(path, params);

    if (Array.isArray(data)) {
      return { count: data.length, size: data.length, next: null, previous: null, results: data };
    }

    if (isRecord(data) && Array.isArray(data.results)) {
      return {
        count: typeof data.count === "number" ? data.count : data.results.length,
        size: typeof data.size === "number" ? data.size : data.results.length,
        next: typeof data.next === "string" ? data.next : null,
        previous: typeof data.previous === "string" ? data.previous : null,
        results: data.results,
      };
    }

    if (isRecord(data) && Object.keys(data).length === 0) {
      return { count: 0, size: 0, next: null, previous: null, results: [] };
    }

    if (isRecord(data)) {
      return { count: 1, size: 1, next: null, previous: null, results: [data] };
    }

    throw new PgsApiError("Unexpected response shape from the PGS Catalog list endpoint.");
  }

  /**
   * Fetch a single-object endpoint. Unknown IDs come back as HTTP 200 with `{}`.
   */
  async object(path: string, params?: QueryParams): Promise<unknown | null> {
    const data = await this.get(path, params);

    if (isRecord(data) && Object.keys(data).length === 0) {
      return null;
    }

    // Some single-value endpoints are documented as objects but return a paginated envelope.
    if (isRecord(data) && Array.isArray(data.results)) {
      if (data.results.length === 0) return null;
      if (data.results.length === 1) return data.results[0];
      return data;
    }

    return data;
  }
}

function tryParseJson(body: string): unknown | undefined {
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

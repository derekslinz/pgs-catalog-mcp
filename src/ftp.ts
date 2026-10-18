/**
 * Client for the PGS Catalog FTP site.
 *
 * The FTP site at https://ftp.ebi.ac.uk/pub/databases/spot/pgs/scores/ is
 * served as an Apache-style HTML directory index over HTTP. Each PGS ID has a
 * directory containing `ScoringFiles/` (the actual scoring files) and
 * `Metadata/` (per-score metadata CSVs and archives).
 *
 * Variants are not distributed through the REST API; the REST `score` endpoints
 * only return a URL (`ftp_scoring_file`, `ftp_harmonized_scoring_files`). These
 * tools let a client browse the FTP site directly and download scoring files or
 * metadata.
 */

const FTP_BASE = "https://ftp.ebi.ac.uk/pub/databases/spot/pgs/scores";

export class FtpError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "FtpError";
    this.status = status;
  }
}

function isDirectoryListing(html: string): boolean {
  return /Index of /.test(html);
}

/** Parse an Apache-style directory index into { name, type, size, modified } rows. */
function parseDirectoryListing(html: string): { name: string; type: "dir" | "file"; size?: string; modified?: string }[] {
  const rows: { name: string; type: "dir" | "file"; size?: string; modified?: string }[] = [];

  // Each row is a <tr> containing an <img> with alt [DIR] or [ICO]/[TXT]/etc,
  // then an <a href="...">name</a>, then date/size cells.
  const rowRegex = /<tr[^>]*>.*?<\/tr>/gs;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[0];

    // Skip header rows and the parent directory row.
    if (/Parent Directory/.test(row)) continue;
    if (/<th/.test(row)) continue;

    const nameMatch = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(row);
    if (!nameMatch) continue;

    const href = nameMatch[1]!;
    const name = nameMatch[2]!.replace(/\/$/, "");

    const isDir = /folder/.test(row) || /\[DIR\]/.test(row) || href.endsWith("/");

    // Extract size and modified date from the remaining <td> cells.
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? [];
    let modified: string | undefined;
    let size: string | undefined;
    let cellIndex = 0;
    for (const cell of cells) {
      const text = cell.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
      if (!text) continue;
      if (cellIndex === 0 && /^\d{4}-\d{2}-\d{2}/.test(text)) {
        modified = text;
      } else if (cellIndex === 1 && /^\s*\d/.test(text) || /^\s*\d\.\d/.test(text)) {
        size = text;
      }
      cellIndex++;
    }

    rows.push({ name, type: isDir ? "dir" : "file", size, modified });
  }

  return rows;
}

export interface FtpEntry {
  name: string;
  type: "dir" | "file";
  size?: string;
  modified?: string;
}

export interface FtpClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
}

export class FtpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: FtpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? FTP_BASE).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.userAgent = options.userAgent ?? "pgs-catalog-mcp/0.1.0";
  }

  private async fetchText(path: string): Promise<string> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "text/html,application/json,text/plain,*/*", "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          lastError = new FtpError(`FTP request to ${url} failed with HTTP ${response.status}`, response.status);
          if (response.status >= 500 && attempt < this.maxRetries) {
            await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
            continue;
          }
          break;
        }

        return await response.text();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          continue;
        }
        break;
      }
    }

    throw lastError ?? new FtpError(`FTP request to ${url} failed.`);
  }

  /**
   * List the top-level score directories on the FTP site (PGS000001, PGS000002, …).
   */
  async listScores(): Promise<FtpEntry[]> {
    const html = await this.fetchText("");
    if (!isDirectoryListing(html)) throw new FtpError("Unexpected response from FTP site root.");
    return parseDirectoryListing(html).filter((e) => e.type === "dir" && /^PGS\d+$/.test(e.name));
  }

  /**
   * List the contents of a score's FTP directory (e.g. `PGS000001/`).
   * Returns subdirectories such as `ScoringFiles` and `Metadata`.
   */
  async listScoreDirectory(pgsId: string): Promise<FtpEntry[]> {
    const html = await this.fetchText(`${pgsId}/`);
    if (!isDirectoryListing(html)) throw new FtpError(`Unexpected response for ${pgsId}.`);
    return parseDirectoryListing(html);
  }

  /**
   * List the files inside a score's `ScoringFiles` directory.
   */
  async listScoringFiles(pgsId: string): Promise<FtpEntry[]> {
    const html = await this.fetchText(`${pgsId}/ScoringFiles/`);
    if (!isDirectoryListing(html)) throw new FtpError(`Unexpected response for ${pgsId}/ScoringFiles/.`);
    return parseDirectoryListing(html).filter((e) => e.type === "file");
  }

  /**
   * List the files inside a score's `Metadata` directory.
   */
  async listMetadataFiles(pgsId: string): Promise<FtpEntry[]> {
    const html = await this.fetchText(`${pgsId}/Metadata/`);
    if (!isDirectoryListing(html)) throw new FtpError(`Unexpected response for ${pgsId}/Metadata/.`);
    return parseDirectoryListing(html).filter((e) => e.type === "file");
  }

  /**
   * Download the raw text content of a file from the FTP site.
   * Suitable for scoring files (.txt.gz are binary - use getFileBytes for those)
   * and metadata CSVs.
   */
  async getFileText(relativePath: string): Promise<string> {
    return this.fetchText(relativePath);
  }
}

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Disk spool (ingest-pipeline.md §6.2/§7.2): allowed here because it's our process, not the
 * customer's — "disk spool default off in the SDK, on in the agent, with a hard byte cap and
 * TTL." Holds batches that failed to send so they survive an Agent restart, without becoming an
 * unbounded liability if the backend stays down for a long time.
 */
export interface SpoolOptions {
  dir: string;
  maxBytes: number;
  ttlMs: number;
  now?: () => number;
}

export class DiskSpool {
  private readonly now: () => number;

  constructor(private readonly options: SpoolOptions) {
    this.now = options.now ?? Date.now;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
  }

  async write(payload: Buffer): Promise<void> {
    await this.ensureDir();
    await this.evictIfNeeded(payload.length);
    const filename = join(
      this.options.dir,
      `${this.now()}-${Math.random().toString(36).slice(2)}.ndjson`,
    );
    await writeFile(filename, payload);
  }

  /** Returns every currently spooled, non-expired batch and removes it from disk. */
  async drainAll(): Promise<Buffer[]> {
    await this.ensureDir();
    const files = await readdir(this.options.dir);
    const batches: Buffer[] = [];
    for (const file of files) {
      const path = join(this.options.dir, file);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      const expired = this.now() - info.mtimeMs > this.options.ttlMs;
      if (!expired) {
        batches.push(await readFile(path));
      }
      await rm(path, { force: true });
    }
    return batches;
  }

  private async evictIfNeeded(incomingBytes: number): Promise<void> {
    const files = await readdir(this.options.dir);
    const entries = await Promise.all(
      files.map(async (file) => {
        const path = join(this.options.dir, file);
        const info = await stat(path).catch(() => undefined);
        return info ? { path, size: info.size, mtimeMs: info.mtimeMs } : undefined;
      }),
    );
    const valid = entries.filter((e): e is NonNullable<typeof e> => e !== undefined);
    valid.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    let totalBytes = valid.reduce((sum, e) => sum + e.size, 0) + incomingBytes;
    for (const entry of valid) {
      if (totalBytes <= this.options.maxBytes) break;
      await rm(entry.path, { force: true });
      totalBytes -= entry.size;
    }
  }
}

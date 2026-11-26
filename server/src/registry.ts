import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogSchema, type Connector } from '../../shared/catalog.js';
import { writePrivate } from './files.js';

type Snapshot = { entries: Connector[]; etag?: string; stale: boolean };
export class Registry {
  private cache?: Snapshot;
  private expires = 0;
  private pending?: Promise<Snapshot>;
  private readonly path?: string;
  private readonly cachePath: string;
  readonly icons: { directory: string } | { baseUrl: URL };

  constructor(private readonly source: string, stateDir: string, private readonly ttlMs = 60_000) {
    this.cachePath = join(stateDir, 'catalog-cache.json');
    if (isAbsolute(source)) this.path = source;
    else if (source.startsWith('file:')) this.path = fileURLToPath(source);
    else if (!/^https?:$/.test(new URL(source).protocol)) throw new Error('Registry URL must use HTTP(S) or an absolute local path');
    this.icons = this.path ? { directory: join(dirname(this.path), 'icons') } : { baseUrl: new URL('icons/', source) };
  }

  get(refresh = false): Promise<Snapshot> {
    if (!refresh && this.cache && Date.now() < this.expires) return Promise.resolve(this.cache);
    this.pending ??= this.load().then(result => {
      this.cache = result;
      this.expires = Date.now() + (result.stale ? Math.min(this.ttlMs, 15_000) : this.ttlMs);
      return result;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async load(): Promise<Snapshot> {
    if (this.path) return { entries: catalogSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))), stale: false };
    let prior = this.cache;
    if (!prior) {
      try {
        const disk = JSON.parse(await readFile(this.cachePath, 'utf8'));
        if (disk.source === this.source) prior = { entries: catalogSchema.parse(disk.catalog), etag: typeof disk.etag === 'string' ? disk.etag : undefined, stale: true };
      } catch { /* A missing or invalid cache cannot override the registry. */ }
    }
    try {
      const response = await fetch(this.source, { headers: prior?.etag ? { 'If-None-Match': prior.etag } : {}, signal: AbortSignal.timeout(8_000), redirect: 'error' });
      if (response.status === 304 && prior) return { ...prior, stale: false };
      if (!response.ok) throw new Error('Registry unavailable');
      const catalog: unknown = await response.json();
      const etag = response.headers.get('etag') ?? undefined;
      const entries = catalogSchema.parse(catalog);
      await writePrivate(this.cachePath, JSON.stringify({ source: this.source, etag, catalog })).catch(() => {});
      return { entries, etag, stale: false };
    } catch {
      if (prior) return { ...prior, stale: true };
      throw new Error('Registry unavailable; check REGISTRY_URL and catalog format');
    }
  }
}

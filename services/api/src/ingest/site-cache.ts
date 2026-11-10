import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

export interface IngestSite {
  id: string;
  organization_id: string;
  domain: string;
  status: 'active' | 'inactive';
  timezone: string;
}

const TTL_MS = 30_000;

/**
 * Resolves a public site id to the server-side site record (spec §5.1: the organisation is never
 * taken from the browser). Short TTL cache; also caches misses to blunt random-id floods.
 */
@Injectable()
export class SiteCache {
  private readonly cache = new Map<string, { site: IngestSite | null; expires: number }>();

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async byPublicId(publicId: string): Promise<IngestSite | null> {
    const hit = this.cache.get(publicId);
    if (hit && hit.expires > Date.now()) return hit.site;
    const [row]: IngestSite[] = await this.ds.query(
      `SELECT id, organization_id, domain, status, timezone FROM sites WHERE public_id = $1`,
      [publicId],
    );
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(publicId, { site: row ?? null, expires: Date.now() + TTL_MS });
    return row ?? null;
  }

  invalidate(publicId: string): void {
    this.cache.delete(publicId);
  }

  clear(): void {
    this.cache.clear();
  }
}

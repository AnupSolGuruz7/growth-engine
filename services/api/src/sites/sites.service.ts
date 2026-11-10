import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { deleteSiteData, generatePublicId, type SiteRow } from '@growthos/db';
import type { CreateSiteInput, SiteDetailDto, SiteDto, UpdateSiteInput } from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import type { TenantContext } from '../common/tenant';
import { APP_CONFIG, type AppConfig } from '../config';
import { SiteCache } from '../ingest/site-cache';

const COLS = 'id, organization_id, name, domain, public_id, status, timezone, created_at';

/** All site access is scoped by the tenant's organisation here (never in controllers). */
@Injectable()
export class SitesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly cache: SiteCache,
  ) {}

  async list(t: TenantContext): Promise<SiteDto[]> {
    const rows: SiteRow[] = await this.ds.query(
      `SELECT ${COLS} FROM sites WHERE organization_id = $1 ORDER BY created_at`,
      [t.organizationId],
    );
    return rows.map(toDto);
  }

  /** Throws 404 unless the site belongs to the tenant. Every site-scoped service goes through this. */
  async getOwned(t: TenantContext, id: string): Promise<SiteRow> {
    const [row]: SiteRow[] = await this.ds.query(`SELECT ${COLS} FROM sites WHERE id = $1 AND organization_id = $2`, [
      id,
      t.organizationId,
    ]);
    if (!row) throw new NotFoundException({ error: 'site_not_found', message: 'Site not found' });
    return row;
  }

  async get(t: TenantContext, id: string): Promise<SiteDetailDto> {
    const site = await this.getOwned(t, id);
    const [last] = await this.ds.query(`SELECT max(received_at) AS at FROM events WHERE site_id = $1`, [site.id]);
    return this.detail(site, last?.at ?? null);
  }

  async create(t: TenantContext, input: CreateSiteInput): Promise<SiteDetailDto> {
    for (let attempt = 0; ; attempt++) {
      try {
        const [row]: SiteRow[] = await this.ds.query(
          `INSERT INTO sites (organization_id, name, domain, public_id, timezone)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
          [t.organizationId, input.name, input.domain, generatePublicId(), input.timezone ?? 'UTC'],
        );
        return this.detail(row!, null);
      } catch (e) {
        if ((e as { code?: string }).code === '23505' && attempt < 3) continue; // public_id collision
        throw e;
      }
    }
  }

  async update(t: TenantContext, id: string, input: UpdateSiteInput): Promise<SiteDetailDto> {
    const before = await this.getOwned(t, id);
    await this.ds.query(
      `UPDATE sites SET name = COALESCE($3, name), domain = COALESCE($4, domain),
              timezone = COALESCE($5, timezone), status = COALESCE($6, status), updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [id, t.organizationId, input.name ?? null, input.domain ?? null, input.timezone ?? null, input.status ?? null],
    );
    this.cache.invalidate(before.public_id);
    return this.get(t, id);
  }

  async rotatePublicId(t: TenantContext, id: string): Promise<SiteDetailDto> {
    const before = await this.getOwned(t, id);
    await this.ds.query(`UPDATE sites SET public_id = $3, updated_at = now() WHERE id = $1 AND organization_id = $2`, [
      id,
      t.organizationId,
      generatePublicId(),
    ]);
    this.cache.invalidate(before.public_id);
    return this.get(t, id);
  }

  /** Deletes all analytics data of the site (retention / deletion request, spec §5.4, §13). */
  async deleteData(t: TenantContext, id: string): Promise<{ deleted: true }> {
    const site = await this.getOwned(t, id);
    await this.ds.transaction((m) => deleteSiteData(m, site.id));
    return { deleted: true };
  }

  private detail(site: SiteRow, lastAt: Date | string | null): SiteDetailDto {
    const base = this.cfg.publicApiUrl;
    const sdkUrl = `${base}/sdk.js`;
    return {
      ...toDto(site),
      install: {
        sdk_url: sdkUrl,
        endpoint: base,
        script_tag: `<script src="${sdkUrl}" data-site-id="${site.public_id}" async></script>`,
        npm: [
          'import GrowthOS from "@growthos/sdk";',
          '',
          `GrowthOS.init({ siteId: "${site.public_id}", endpoint: "${base}", consent: "pending" });`,
        ].join('\n'),
      },
      last_event_received_at: lastAt ? new Date(lastAt).toISOString() : null,
    };
  }
}

function toDto(r: SiteRow): SiteDto {
  return {
    id: r.id,
    organization_id: r.organization_id,
    name: r.name,
    domain: r.domain,
    public_id: r.public_id,
    status: r.status,
    timezone: r.timezone,
    created_at: new Date(r.created_at).toISOString(),
  };
}

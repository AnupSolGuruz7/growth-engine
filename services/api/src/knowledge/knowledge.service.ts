import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
  type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { checkRules, embedQuery, toVectorLiteral, walkSource, type ContentRule } from '@growthos/knowledge';
import {
  KNOWLEDGE_JOB, KNOWLEDGE_QUEUE,
  type GscSummaryDto, type KnowledgeHit, type KnowledgeResponse, type KnowledgeSourceDto, type RuleFlagDto,
} from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import type { TenantContext } from '../common/tenant';
import { APP_CONFIG, type AppConfig } from '../config';
import { SitesService } from '../sites/sites.service';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
/** A sync stuck this long in queued/syncing no longer blocks a new one. */
const STALE_MIN = 30;
/** Reciprocal-rank-fusion constant: how strongly top ranks dominate when merging the two result lists. */
const RRF_K = 60;

export interface SearchOptions {
  limit?: number;
  /** Stop adding passages once their tokens would exceed this. */
  maxTokens?: number;
  /** Only passages whose document path starts with one of these. */
  pathPrefixes?: string[];
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  if (process.platform === 'win32' && path.parse(child).root.toLowerCase() !== path.parse(root).root.toLowerCase()) return false;
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Knowledge base per site: one local folder (e.g. a growth-engine repo) synced by the worker into
 * embedded chunks. Retrieval is hybrid — pgvector cosine similarity for meaning plus Postgres full
 * text for exact terms ("AFSL", "SMSF") — merged with reciprocal rank fusion.
 */
@Injectable()
export class KnowledgeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly queue: Queue;
  private readonly conn: IORedis;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly sites: SitesService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly log: PinoLogger,
  ) {
    log.setContext(KnowledgeService.name);
    this.conn = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.conn.on('error', () => undefined);
    this.queue = new Queue(KNOWLEDGE_QUEUE, { connection: this.conn });
  }

  /** Loads the embedding model in the background when a source exists, so the first search is fast. */
  onApplicationBootstrap(): void {
    if (this.cfg.env === 'test') return;
    void (async () => {
      const [row] = await this.ds.query(`SELECT 1 FROM knowledge_sources WHERE status = 'ready' LIMIT 1`).catch(() => []);
      if (row) await embedQuery('warm up');
    })().catch((e) => this.log.warn({ err: (e as Error).message }, 'embedding model warm-up failed'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.conn.disconnect();
  }

  private toDto(r: Record<string, any>): KnowledgeSourceDto {
    return {
      id: r.id, site_id: r.site_id, name: r.name, root_path: r.root_path, status: r.status, progress: r.progress ?? null,
      error: r.error ?? null, stats: r.stats ?? null, embedding_model: r.embedding_model ?? null,
      last_synced_at: iso(r.last_synced_at), created_at: iso(r.created_at)!,
    };
  }

  async get(t: TenantContext, siteId: string): Promise<KnowledgeResponse> {
    const site = await this.sites.getOwned(t, siteId);
    const [src] = await this.ds.query(`SELECT * FROM knowledge_sources WHERE site_id = $1`, [site.id]);
    const documents = src
      ? await this.ds.query(
          `SELECT path, title, chunk_count, bytes, modified_at, synced_at FROM knowledge_documents WHERE source_id = $1 ORDER BY path`,
          [src.id],
        )
      : [];
    return {
      source: src ? this.toDto(src) : null,
      documents: documents.map(({ synced_at: _s, ...d }: Record<string, any>) => ({ ...d, modified_at: iso(d.modified_at) })),
      allowed_roots: this.cfg.knowledgeAllowedRoots,
      pending_changes: src?.status === 'ready' ? await this.pendingChanges(src.root_path, documents) : null,
    };
  }

  /** Cheap staleness check: stats the folder's text files against the stored documents (no reading or hashing). */
  private async pendingChanges(
    root: string,
    docs: { path: string; synced_at: Date | string; modified_at: Date | string | null }[],
  ): Promise<KnowledgeResponse['pending_changes']> {
    try {
      const files = (await walkSource(root)).filter((f) => ['.md', '.mdx', '.txt'].includes(f.ext));
      const known = new Map(docs.map((d) => [d.path, d]));
      let changed = 0;
      let added = 0;
      for (const f of files) {
        const d = known.get(f.rel);
        if (!d) added++;
        // newer than both the last sync of that file and the mtime recorded then (allow 1 s of clock rounding)
        else if (f.mtime.getTime() > Math.max(new Date(d.synced_at).getTime(), d.modified_at ? new Date(d.modified_at).getTime() : 0) + 1000) changed++;
      }
      const present = new Set(files.map((f) => f.rel));
      const removed = docs.filter((d) => !present.has(d.path)).length;
      return { changed, added, removed };
    } catch {
      return null;
    }
  }

  /** Validates a folder: it must exist and resolve (following links) inside an allowed root. */
  private async checkRoot(input: string): Promise<string> {
    if (!this.cfg.knowledgeAllowedRoots.length) {
      throw new BadRequestException({
        error: 'knowledge_roots_not_configured',
        message: 'Set KNOWLEDGE_ALLOWED_ROOTS in .env to the folder(s) knowledge may be read from, then restart the API.',
      });
    }
    if (!path.isAbsolute(input)) throw new BadRequestException({ error: 'invalid_path', message: 'Use an absolute folder path.' });
    let real: string;
    try {
      real = await fs.realpath(path.resolve(input));
      if (!(await fs.stat(real)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new BadRequestException({ error: 'folder_not_found', message: `Folder not found: ${input}` });
    }
    const roots = await Promise.all(this.cfg.knowledgeAllowedRoots.map((r) => fs.realpath(path.resolve(r)).catch(() => path.resolve(r))));
    if (!roots.some((r) => isInside(real, r))) {
      throw new BadRequestException({ error: 'path_not_allowed', message: `That folder is outside KNOWLEDGE_ALLOWED_ROOTS (${this.cfg.knowledgeAllowedRoots.join('; ')}).` });
    }
    return real;
  }

  /** Connects (or re-points) the site's knowledge source and starts a sync. */
  async upsert(t: TenantContext, siteId: string, input: { name: string; root_path: string }): Promise<KnowledgeSourceDto> {
    const site = await this.sites.getOwned(t, siteId);
    const root = await this.checkRoot(input.root_path);
    const [existing] = await this.ds.query(`SELECT id, root_path FROM knowledge_sources WHERE site_id = $1`, [site.id]);
    if (existing && !samePath(existing.root_path, root)) {
      // a different folder: drop everything derived from the old one rather than mixing the two
      await this.ds.query(`DELETE FROM knowledge_sources WHERE id = $1`, [existing.id]);
    }
    await this.ds.query(
      `INSERT INTO knowledge_sources (organization_id, site_id, name, root_path) VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [site.organization_id, site.id, input.name, root],
    );
    return this.sync(t, site.id);
  }

  async sync(t: TenantContext, siteId: string): Promise<KnowledgeSourceDto> {
    const site = await this.sites.getOwned(t, siteId);
    const [src] = await this.ds.query(`SELECT * FROM knowledge_sources WHERE site_id = $1`, [site.id]);
    if (!src) throw new NotFoundException({ error: 'knowledge_not_connected', message: 'No knowledge source is connected to this site.' });
    const busy = (src.status === 'queued' || src.status === 'syncing') && Date.now() - new Date(src.updated_at).getTime() < STALE_MIN * 60_000;
    if (busy) throw new ConflictException({ error: 'sync_in_progress', message: 'A sync is already running.' });
    await this.ds.query(`UPDATE knowledge_sources SET status = 'queued', error = NULL, progress = NULL, updated_at = now() WHERE id = $1`, [src.id]);
    try {
      await this.queue.add(KNOWLEDGE_JOB, { source_id: src.id }, { jobId: `knowledge-${src.id}-${Date.now()}`, removeOnComplete: 50, removeOnFail: 50 });
    } catch {
      await this.ds.query(`UPDATE knowledge_sources SET status = 'failed', error = 'queue unavailable' WHERE id = $1`, [src.id]);
    }
    const [row] = await this.ds.query(`SELECT * FROM knowledge_sources WHERE id = $1`, [src.id]);
    return this.toDto(row);
  }

  async remove(t: TenantContext, siteId: string): Promise<void> {
    const site = await this.sites.getOwned(t, siteId);
    await this.ds.query(`DELETE FROM knowledge_sources WHERE site_id = $1`, [site.id]);
  }

  /** True when the site has a synced source with at least one passage. */
  async isReady(siteId: string): Promise<boolean> {
    const [r] = await this.ds.query(
      `SELECT 1 FROM knowledge_sources s WHERE s.site_id = $1 AND s.last_synced_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.site_id = s.site_id) LIMIT 1`,
      [siteId],
    );
    return !!r;
  }

  async hasGsc(siteId: string): Promise<boolean> {
    const [r] = await this.ds.query(`SELECT 1 FROM gsc_queries WHERE site_id = $1 UNION ALL SELECT 1 FROM gsc_pages WHERE site_id = $1 LIMIT 1`, [siteId]);
    return !!r;
  }

  /** Hybrid retrieval (no tenant check: callers pass a site id already resolved through getOwned). */
  async search(siteId: string, query: string, opts: SearchOptions = {}): Promise<KnowledgeHit[]> {
    const limit = Math.min(opts.limit ?? 6, 20);
    const pool = Math.max(limit * 4, 24);
    const prefixes = opts.pathPrefixes?.length ? opts.pathPrefixes : null;
    const vec = toVectorLiteral(await embedQuery(query));
    const pathFilter = `($3::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($3::text[]) p WHERE d.path LIKE p || '%'))`;
    const [semantic, keyword] = await Promise.all([
      this.ds.query(
        `SELECT c.id, 1 - (c.embedding <=> $2::vector) AS sim
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
         WHERE c.site_id = $1 AND ${pathFilter}
         ORDER BY c.embedding <=> $2::vector LIMIT $4`,
        [siteId, vec, prefixes, pool],
      ),
      this.ds.query(
        `SELECT c.id, ts_rank_cd(c.tsv, q) AS rank
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id, websearch_to_tsquery('english', $2) q
         WHERE c.site_id = $1 AND c.tsv @@ q AND ${pathFilter}
         ORDER BY rank DESC LIMIT $4`,
        [siteId, query, prefixes, pool],
      ),
    ]);
    const fused = new Map<string, { score: number; sem: boolean; kw: boolean; sim: number }>();
    semantic.forEach((r: { id: string; sim: number }, i: number) => {
      fused.set(r.id, { score: 1 / (RRF_K + i + 1), sem: true, kw: false, sim: Number(r.sim) });
    });
    keyword.forEach((r: { id: string }, i: number) => {
      const cur = fused.get(r.id) ?? { score: 0, sem: false, kw: false, sim: 0 };
      fused.set(r.id, { ...cur, score: cur.score + 1 / (RRF_K + i + 1), kw: true });
    });
    const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit * 2);
    if (!ranked.length) return [];
    const rows: Record<string, any>[] = await this.ds.query(
      `SELECT c.id, c.heading, c.content, c.tokens, d.path, d.title
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE c.id = ANY($1)`,
      [ranked.map(([id]) => id)],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const hits: KnowledgeHit[] = [];
    let budget = opts.maxTokens ?? Number.POSITIVE_INFINITY;
    for (const [id, f] of ranked) {
      const r = byId.get(id);
      if (!r || hits.length >= limit) continue;
      if (r.tokens > budget) continue;
      budget -= r.tokens;
      hits.push({
        id, path: r.path, title: r.title, heading: r.heading,
        cite: r.heading ? `${r.path} › ${r.heading}` : r.path,
        content: r.content, tokens: r.tokens,
        score: Math.round(f.score * 10_000) / 10_000,
        match: f.sem && f.kw ? 'both' : f.sem ? 'semantic' : 'keyword',
      });
    }
    return hits;
  }

  async searchOwned(t: TenantContext, siteId: string, query: string, limit?: number): Promise<KnowledgeHit[]> {
    const site = await this.sites.getOwned(t, siteId);
    return this.search(site.id, query, { limit });
  }

  async rules(siteId: string): Promise<Omit<ContentRule, 'file'>[]> {
    return this.ds.query(`SELECT kind, rule_id, pattern, flags, severity, why FROM knowledge_rules WHERE site_id = $1`, [siteId]);
  }

  /** Content rules from the site's knowledge source that `text` breaks (empty without a source). */
  async check(siteId: string, text: string): Promise<RuleFlagDto[]> {
    const rules = await this.rules(siteId);
    return rules.length ? checkRules(text, rules) : [];
  }

  async gscSummary(t: TenantContext, siteId: string): Promise<GscSummaryDto> {
    const site = await this.sites.getOwned(t, siteId);
    const [meta] = await this.ds.query(
      `SELECT (SELECT max(period_days) FROM gsc_queries WHERE site_id = $1) AS query_days,
              (SELECT max(period_days) FROM gsc_pages WHERE site_id = $1) AS page_days,
              (SELECT count(*) FROM gsc_queries WHERE site_id = $1)::int AS queries,
              (SELECT coalesce(sum(clicks), 0) FROM gsc_queries WHERE site_id = $1)::int AS clicks,
              (SELECT coalesce(sum(impressions), 0) FROM gsc_queries WHERE site_id = $1)::int AS impressions`,
      [site.id],
    );
    const cols = `clicks, impressions, ctr, position`;
    const [top, opp, pages, monthly] = await Promise.all([
      this.ds.query(`SELECT query, ${cols} FROM gsc_queries WHERE site_id = $1 ORDER BY clicks DESC, impressions DESC LIMIT 15`, [site.id]),
      this.gscOpportunities(site.id, 15),
      this.ds.query(`SELECT page, ${cols} FROM gsc_pages WHERE site_id = $1 ORDER BY clicks DESC, impressions DESC LIMIT 15`, [site.id]),
      this.ds.query(`SELECT month, clicks, impressions FROM gsc_monthly WHERE site_id = $1 ORDER BY month`, [site.id]),
    ]);
    return {
      property: null,
      query_days: meta.query_days,
      page_days: meta.page_days,
      totals: { queries: meta.queries, clicks: meta.clicks, impressions: meta.impressions },
      top_queries: top,
      opportunities: opp,
      top_pages: pages,
      monthly,
    };
  }

  /**
   * "Striking distance" queries: plenty of impressions, ranking on page 1–2 but below the top 3,
   * with a weak click-through rate — the cheapest search wins.
   */
  gscOpportunities(siteId: string, limit: number): Promise<GscSummaryDto['opportunities']> {
    return this.ds.query(
      `SELECT query, clicks, impressions, ctr, position FROM gsc_queries
       WHERE site_id = $1 AND impressions >= 20 AND position BETWEEN 4 AND 20
       ORDER BY impressions DESC LIMIT $2`,
      [siteId, limit],
    );
  }

  /** Search Console rows for the AI tool (site already resolved). */
  async gscRows(
    siteId: string,
    kind: 'queries' | 'pages',
    opts: { contains: string | null; sort: 'clicks' | 'impressions' | 'position' | 'opportunity'; limit: number },
  ): Promise<{ period_days: number | null; rows: Record<string, unknown>[] }> {
    const table = kind === 'queries' ? 'gsc_queries' : 'gsc_pages';
    const key = kind === 'queries' ? 'query' : 'page';
    const where = [`site_id = $1`, `($2::text IS NULL OR ${key} ILIKE '%' || $2 || '%')`];
    if (opts.sort === 'opportunity') where.push(`impressions >= 20`, `position BETWEEN 4 AND 20`);
    const order = opts.sort === 'position' ? 'position ASC NULLS LAST' : opts.sort === 'clicks' ? 'clicks DESC, impressions DESC' : 'impressions DESC';
    const rows = await this.ds.query(
      `SELECT ${key}, clicks, impressions, round(ctr::numeric, 4) AS ctr, round(position::numeric, 1) AS position, period_days
       FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $3`,
      [siteId, opts.contains, Math.min(opts.limit, 50)],
    );
    const period = rows[0]?.period_days ?? null;
    return { period_days: period, rows: rows.map(({ period_days: _p, ...r }: Record<string, unknown>) => r) };
  }
}

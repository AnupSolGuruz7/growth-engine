import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import {
  EMBEDDING_MODEL, chunkMarkdown, chunkText, embedPassages, embeddingInput, parseGscExport, parseRuleFile, toVectorLiteral,
  walkSource, type ContentRule, type GscExport,
} from '@growthos/knowledge';
import { KNOWLEDGE_JOB, KNOWLEDGE_QUEUE, type KnowledgeStats } from '@growthos/shared-types';
import type { DataSource, EntityManager } from 'typeorm';
import { WORKER_CONFIG, type WorkerConfig } from './config';

interface SourceRow {
  id: string;
  site_id: string;
  root_path: string;
  status: string;
  embedding_model: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Syncs a site's knowledge source (spec: knowledge base) on its own queue: walks the folder,
 * re-chunks and re-embeds only files whose content changed, removes deleted files, and re-imports
 * content rules and Search Console exports. Embeddings run locally (no API, no cost).
 */
@Injectable()
export class KnowledgeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker;
  private conn?: Redis;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(WORKER_CONFIG) private readonly cfg: WorkerConfig,
    private readonly log: PinoLogger,
  ) {
    log.setContext(KnowledgeWorker.name);
  }

  onApplicationBootstrap(): void {
    this.conn = new IORedis(this.cfg.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(KNOWLEDGE_QUEUE, (job: Job<{ source_id: string }>) => this.run(job.data.source_id), {
      connection: this.conn,
      concurrency: 1,
      lockDuration: 300_000,
    });
    this.worker.on('error', (err) => this.log.error({ err: err.message }, 'knowledge worker error'));
    this.log.info({ queue: KNOWLEDGE_QUEUE, job: KNOWLEDGE_JOB }, 'knowledge worker started');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.conn?.quit().catch(() => undefined);
  }

  private async progress(id: string, phase: string, done: number, total: number): Promise<void> {
    await this.ds.query(`UPDATE knowledge_sources SET progress = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify({ phase, done, total })]);
  }

  async run(sourceId: string): Promise<KnowledgeStats | null> {
    const [src]: SourceRow[] = await this.ds.query(`SELECT id, site_id, root_path, status, embedding_model FROM knowledge_sources WHERE id = $1`, [sourceId]);
    if (!src || src.status !== 'queued') return null;
    await this.ds.query(`UPDATE knowledge_sources SET status = 'syncing', error = NULL, updated_at = now() WHERE id = $1`, [src.id]);
    const started = Date.now();
    try {
      const st = await fs.stat(src.root_path).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`Folder not found: ${src.root_path}`);
      await this.progress(src.id, 'scanning', 0, 0);
      const files = await walkSource(src.root_path);
      const textFiles = files.filter((f) => f.ext === '.md' || f.ext === '.mdx' || f.ext === '.txt');
      // a model change invalidates every stored vector
      const forceAll = src.embedding_model !== EMBEDDING_MODEL;
      const existing = new Map<string, { id: string; content_hash: string }>(
        (await this.ds.query(`SELECT id, path, content_hash FROM knowledge_documents WHERE source_id = $1`, [src.id])).map(
          (r: { id: string; path: string; content_hash: string }) => [r.path, r],
        ),
      );

      // 1. decide what changed
      const changed: { rel: string; title: string; hash: string; bytes: number; mtime: Date; chunks: ReturnType<typeof chunkMarkdown>['chunks'] }[] = [];
      let skipped = 0;
      for (const f of textFiles) {
        const text = await fs.readFile(f.abs, 'utf8');
        const hash = sha(text);
        if (!forceAll && existing.get(f.rel)?.content_hash === hash) continue;
        const name = f.rel.split('/').pop()!;
        const doc = f.ext === '.txt' ? chunkText(text, name) : chunkMarkdown(text, name);
        if (!doc.chunks.length) {
          skipped++;
          continue;
        }
        changed.push({ rel: f.rel, title: doc.title.slice(0, 300), hash, bytes: f.bytes, mtime: f.mtime, chunks: doc.chunks });
      }

      // 2. embed + store each changed document (one transaction per document keeps a partial sync consistent)
      const total = changed.reduce((s, d) => s + d.chunks.length, 0);
      let done = 0;
      let lastWrite = 0;
      for (const d of changed) {
        const vectors = await embedPassages(d.chunks.map((c) => embeddingInput(d.title, c)));
        await this.ds.transaction(async (m) => {
          const [doc] = await m.query(
            `INSERT INTO knowledge_documents (source_id, site_id, path, title, content_hash, bytes, chunk_count, modified_at, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (source_id, path) DO UPDATE SET title = EXCLUDED.title, content_hash = EXCLUDED.content_hash,
               bytes = EXCLUDED.bytes, chunk_count = EXCLUDED.chunk_count, modified_at = EXCLUDED.modified_at, synced_at = now()
             RETURNING id`,
            [src.id, src.site_id, d.rel, d.title, d.hash, d.bytes, d.chunks.length, d.mtime],
          );
          await m.query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [doc.id]);
          await this.insertChunks(m, doc.id, src.site_id, d.chunks, vectors);
        });
        done += d.chunks.length;
        if (Date.now() - lastWrite > 1000) {
          lastWrite = Date.now();
          await this.progress(src.id, 'embedding', done, total);
        }
      }

      // 3. forget files that disappeared from the folder
      const present = new Set(textFiles.map((f) => f.rel));
      const gone = [...existing.keys()].filter((p) => !present.has(p));
      if (gone.length) await this.ds.query(`DELETE FROM knowledge_documents WHERE source_id = $1 AND path = ANY($2)`, [src.id, gone]);

      // 4. rules + Search Console exports are small: re-import them whole
      await this.progress(src.id, 'importing', 0, 0);
      const rules: ContentRule[] = [];
      for (const f of files.filter((x) => x.ext === '.mjs')) rules.push(...parseRuleFile(await fs.readFile(f.abs, 'utf8'), f.rel));
      const gsc: { file: string; data: GscExport }[] = [];
      for (const f of files.filter((x) => x.ext === '.json')) {
        try {
          const data = parseGscExport(JSON.parse(await fs.readFile(f.abs, 'utf8')), f.rel);
          if (data) gsc.push({ file: f.rel, data });
        } catch {
          /* not JSON we understand */
        }
      }
      await this.ds.transaction(async (m) => {
        await m.query(`DELETE FROM knowledge_rules WHERE source_id = $1`, [src.id]);
        for (const r of rules) {
          await m.query(
            `INSERT INTO knowledge_rules (source_id, site_id, kind, rule_id, pattern, flags, severity, why, file) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [src.id, src.site_id, r.kind, r.rule_id, r.pattern, r.flags, r.severity, r.why, r.file],
          );
        }
        await this.importGsc(m, src, gsc);
      });

      const [agg] = await this.ds.query(
        `SELECT count(DISTINCT d.id)::int AS documents, count(c.id)::int AS chunks, coalesce(sum(c.tokens), 0)::int AS tokens
         FROM knowledge_documents d LEFT JOIN knowledge_chunks c ON c.document_id = d.id WHERE d.source_id = $1`,
        [src.id],
      );
      const [g] = await this.ds.query(
        `SELECT (SELECT count(*) FROM gsc_queries WHERE source_id = $1)::int AS queries,
                (SELECT count(*) FROM gsc_pages WHERE source_id = $1)::int AS pages,
                (SELECT count(*) FROM gsc_monthly WHERE source_id = $1)::int AS months`,
        [src.id],
      );
      const stats: KnowledgeStats = {
        files: files.length,
        documents: agg.documents,
        chunks: agg.chunks,
        tokens: agg.tokens,
        embedded: total,
        rules: { words: rules.filter((r) => r.kind === 'word').length, claims: rules.filter((r) => r.kind === 'claim').length },
        gsc: { queries: g.queries, pages: g.pages, months: g.months },
        skipped,
        duration_ms: Date.now() - started,
      };
      await this.ds.query(
        `UPDATE knowledge_sources SET status = 'ready', progress = NULL, stats = $2, embedding_model = $3, last_synced_at = now(), updated_at = now()
         WHERE id = $1`,
        [src.id, JSON.stringify(stats), EMBEDDING_MODEL],
      );
      this.log.info({ source_id: src.id, ...stats }, 'knowledge source synced');
      return stats;
    } catch (e) {
      const msg = (e as Error).message;
      await this.ds.query(`UPDATE knowledge_sources SET status = 'failed', progress = NULL, error = $2, updated_at = now() WHERE id = $1`, [src.id, msg.slice(0, 500)]);
      this.log.error({ source_id: src.id, err: msg }, 'knowledge sync failed');
      return null;
    }
  }

  private async insertChunks(
    m: EntityManager,
    documentId: string,
    siteId: string,
    chunks: { heading: string; content: string; tokens: number }[],
    vectors: number[][],
  ): Promise<void> {
    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const params: unknown[] = [];
      const rows = chunks.slice(i, i + BATCH).map((c, j) => {
        params.push(documentId, siteId, i + j, c.heading.slice(0, 500), c.content, c.tokens, toVectorLiteral(vectors[i + j]!));
        const b = params.length - 7;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::vector)`;
      });
      await m.query(`INSERT INTO knowledge_chunks (document_id, site_id, ordinal, heading, content, tokens, embedding) VALUES ${rows.join(', ')}`, params);
    }
  }

  private async importGsc(m: EntityManager, src: SourceRow, exports: { file: string; data: GscExport }[]): Promise<void> {
    await m.query(`DELETE FROM gsc_queries WHERE source_id = $1`, [src.id]);
    await m.query(`DELETE FROM gsc_pages WHERE source_id = $1`, [src.id]);
    await m.query(`DELETE FROM gsc_monthly WHERE source_id = $1`, [src.id]);
    for (const { file, data } of exports) {
      if (data.kind === 'queries' && data.rows.length) {
        await m.query(
          `INSERT INTO gsc_queries (site_id, source_id, query, clicks, impressions, ctr, position, period_days, file)
           SELECT $1, $2, q, c, i, ctr, pos, $8, $9 FROM unnest($3::text[], $4::int[], $5::int[], $6::float8[], $7::float8[]) AS t(q, c, i, ctr, pos)
           ON CONFLICT (site_id, query) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr,
             position = EXCLUDED.position, period_days = EXCLUDED.period_days, file = EXCLUDED.file, source_id = EXCLUDED.source_id`,
          [
            src.site_id, src.id, data.rows.map((r) => r.query), data.rows.map((r) => Math.round(r.clicks)), data.rows.map((r) => Math.round(r.impressions)),
            data.rows.map((r) => r.ctr), data.rows.map((r) => r.position), data.days, file,
          ],
        );
      } else if (data.kind === 'pages' && data.rows.length) {
        await m.query(
          `INSERT INTO gsc_pages (site_id, source_id, page, clicks, impressions, ctr, position, period_days, file)
           SELECT $1, $2, p, c, i, ctr, pos, $8, $9 FROM unnest($3::text[], $4::int[], $5::int[], $6::float8[], $7::float8[]) AS t(p, c, i, ctr, pos)
           ON CONFLICT (site_id, page) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr,
             position = EXCLUDED.position, period_days = EXCLUDED.period_days, file = EXCLUDED.file, source_id = EXCLUDED.source_id`,
          [
            src.site_id, src.id, data.rows.map((r) => r.page), data.rows.map((r) => Math.round(r.clicks)), data.rows.map((r) => Math.round(r.impressions)),
            data.rows.map((r) => r.ctr), data.rows.map((r) => r.position), data.days, file,
          ],
        );
      } else if (data.kind === 'monthly' && data.rows.length) {
        await m.query(
          `INSERT INTO gsc_monthly (site_id, source_id, month, clicks, impressions, pages, file)
           SELECT $1, $2, mo, c, i, p, $7 FROM unnest($3::text[], $4::int[], $5::int[], $6::int[]) AS t(mo, c, i, p)
           ON CONFLICT (site_id, month) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, pages = EXCLUDED.pages,
             file = EXCLUDED.file, source_id = EXCLUDED.source_id`,
          [src.site_id, src.id, data.rows.map((r) => r.month), data.rows.map((r) => Math.round(r.clicks)), data.rows.map((r) => Math.round(r.impressions)), data.rows.map((r) => r.pages), file],
        );
      }
    }
  }
}

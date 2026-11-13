import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge base per site: a local folder (e.g. a growth-engine repo) is synced into
 * heading-scoped chunks with local 384-dim embeddings (pgvector, HNSW cosine) plus a full-text
 * index for exact terms, so the AI can retrieve the site's own plans, brand facts and rules.
 * Search Console exports found in the source are imported as data, and content rules (banned
 * words / claims) are stored for checking AI output.
 */
export class Knowledge1763222400000 implements MigrationInterface {
  name = 'Knowledge1763222400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await q.query(`
      CREATE TABLE knowledge_sources (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
        name            text NOT NULL,
        root_path       text NOT NULL,
        status          text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'queued', 'syncing', 'ready', 'failed')),
        progress        jsonb,                   -- {phase, done, total}
        error           text,
        stats           jsonb,                   -- {files, documents, chunks, tokens, rules, gsc_queries, gsc_pages, ...}
        embedding_model text,
        last_synced_at  timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE knowledge_documents (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id    uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        site_id      uuid NOT NULL,
        path         text NOT NULL,
        title        text NOT NULL,
        content_hash text NOT NULL,
        bytes        integer NOT NULL,
        chunk_count  integer NOT NULL DEFAULT 0,
        modified_at  timestamptz,
        synced_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source_id, path)
      )`);

    await q.query(`
      CREATE TABLE knowledge_chunks (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        site_id     uuid NOT NULL,
        ordinal     integer NOT NULL,
        heading     text NOT NULL DEFAULT '',
        content     text NOT NULL,
        tokens      integer NOT NULL,
        embedding   vector(384) NOT NULL,
        tsv         tsvector GENERATED ALWAYS AS (
                      setweight(to_tsvector('english', coalesce(heading, '')), 'A') || to_tsvector('english', content)
                    ) STORED
      )`);
    await q.query(`CREATE INDEX knowledge_chunks_doc_idx ON knowledge_chunks (document_id, ordinal)`);
    await q.query(`CREATE INDEX knowledge_chunks_site_idx ON knowledge_chunks (site_id)`);
    await q.query(`CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`);
    await q.query(`CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv)`);

    await q.query(`
      CREATE TABLE knowledge_rules (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        site_id   uuid NOT NULL,
        kind      text NOT NULL CHECK (kind IN ('word', 'claim')),
        rule_id   text NOT NULL,
        pattern   text NOT NULL,
        flags     text NOT NULL DEFAULT '',
        severity  text NOT NULL CHECK (severity IN ('block', 'warn')),
        why       text NOT NULL DEFAULT '',
        file      text NOT NULL
      )`);
    await q.query(`CREATE INDEX knowledge_rules_site_idx ON knowledge_rules (site_id)`);

    // Search Console snapshot imported from the source (not a live connection).
    await q.query(`
      CREATE TABLE gsc_queries (
        site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        source_id   uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        query       text NOT NULL,
        clicks      integer NOT NULL,
        impressions integer NOT NULL,
        ctr         double precision,
        position    double precision,
        period_days integer,
        file        text NOT NULL,
        PRIMARY KEY (site_id, query)
      )`);
    await q.query(`
      CREATE TABLE gsc_pages (
        site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        source_id   uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        page        text NOT NULL,
        clicks      integer NOT NULL,
        impressions integer NOT NULL,
        ctr         double precision,
        position    double precision,
        period_days integer,
        file        text NOT NULL,
        PRIMARY KEY (site_id, page)
      )`);
    await q.query(`
      CREATE TABLE gsc_monthly (
        site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        source_id   uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        month       text NOT NULL,
        clicks      integer NOT NULL,
        impressions integer NOT NULL,
        pages       integer,
        file        text NOT NULL,
        PRIMARY KEY (site_id, month)
      )`);

    // Which knowledge passages a suggestion drew on, and which content rules its text breaks.
    await q.query(`ALTER TABLE suggestions ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`ALTER TABLE suggestions ADD COLUMN rule_flags jsonb NOT NULL DEFAULT '[]'::jsonb`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE suggestions DROP COLUMN IF EXISTS sources, DROP COLUMN IF EXISTS rule_flags`);
    await q.query(`DROP TABLE IF EXISTS gsc_monthly, gsc_pages, gsc_queries, knowledge_rules, knowledge_chunks, knowledge_documents, knowledge_sources CASCADE`);
  }
}

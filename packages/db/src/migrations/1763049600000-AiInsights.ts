import type { MigrationInterface, QueryRunner } from 'typeorm';

/** M5: AI suggestions, Ask AI conversations, draft copy and the AI audit trail (spec §8, §11). */
export class AiInsights1763049600000 implements MigrationInterface {
  name = 'AiInsights1763049600000';

  async up(q: QueryRunner): Promise<void> {
    // Every model call: audit log + cost budget source of truth.
    await q.query(`
      CREATE TABLE ai_calls (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id    uuid NOT NULL,
        site_id            uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        kind               text NOT NULL CHECK (kind IN ('suggestions', 'ask', 'draft')),
        model              text NOT NULL,
        served_by          text,                  -- model that actually answered (refusal fallback)
        status             text NOT NULL CHECK (status IN ('ok', 'error', 'refused')),
        input_tokens       integer NOT NULL DEFAULT 0,
        output_tokens      integer NOT NULL DEFAULT 0,
        cache_read_tokens  integer NOT NULL DEFAULT 0,
        cache_write_tokens integer NOT NULL DEFAULT 0,
        cost_usd           numeric(10, 5) NOT NULL DEFAULT 0,
        duration_ms        integer,
        error              text,
        ref_id             uuid,                  -- suggestion run / conversation / finding
        created_at         timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX ai_calls_site_idx ON ai_calls (site_id, created_at DESC)`);

    await q.query(`
      CREATE TABLE ai_tool_calls (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        conversation_id uuid,
        tool            text NOT NULL,
        input           jsonb NOT NULL,
        ok              boolean NOT NULL,
        error           text,
        duration_ms     integer,
        created_at      timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE ai_conversations (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        title           text NOT NULL,
        messages        jsonb NOT NULL DEFAULT '[]',   -- full Claude message history (incl. tool blocks)
        transcript      jsonb NOT NULL DEFAULT '[]',   -- what the user sees: [{role, text, at, tools}]
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX ai_conversations_site_idx ON ai_conversations (site_id, updated_at DESC)`);

    await q.query(`
      CREATE TABLE suggestion_runs (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
        range_from      date NOT NULL,
        range_to        date NOT NULL,
        seo_audit_id    uuid,
        accepted        integer NOT NULL DEFAULT 0,
        dropped         jsonb NOT NULL DEFAULT '[]',   -- suggestions rejected by evidence validation, with reasons
        error           text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        finished_at     timestamptz
      )`);

    await q.query(`
      CREATE TABLE suggestions (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id  uuid NOT NULL,
        site_id          uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        run_id           uuid NOT NULL REFERENCES suggestion_runs(id) ON DELETE CASCADE,
        title            text NOT NULL,
        area             text NOT NULL CHECK (area IN ('seo', 'content', 'marketing')),
        evidence         jsonb NOT NULL,          -- [{ref, value, label, link}] — every value checked against the data
        action           text NOT NULL,
        copy             text,                    -- ready-to-paste copy, when useful
        expected_outcome text NOT NULL,
        assumptions      text,
        priority         text NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
        effort           text NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
        confidence       text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
        measurement      jsonb NOT NULL,          -- {metric_ref, direction, window_days, baseline}
        status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'dismissed', 'done')),
        status_changed_at timestamptz,
        done_at          timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX suggestions_site_idx ON suggestions (site_id, created_at DESC)`);

    // AI-drafted copy for an SEO finding (cached; regenerated on request).
    await q.query(`
      CREATE TABLE ai_drafts (
        finding_id      uuid PRIMARY KEY REFERENCES seo_findings(id) ON DELETE CASCADE,
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL,
        content         jsonb NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS ai_drafts, suggestions, suggestion_runs, ai_conversations, ai_tool_calls, ai_calls CASCADE`);
  }
}

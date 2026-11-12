import { randomBytes } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

type Db = DataSource | EntityManager;

export const DEV_ORG_SLUG = 'dev';
export const DEMO_SITE_PUBLIC_ID = 'gos_demo_local';

/** Public site ids are not secrets (spec §4.1) but must be unguessable enough to avoid collisions. */
export function generatePublicId(): string {
  return 'gos_' + randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toLowerCase();
}

/** Seeds the single `dev` organisation used during the auth-free testing phase. Idempotent. */
export async function seedDevOrganization(db: Db): Promise<{ id: string }> {
  const rows: { id: string }[] = await db.query(
    `INSERT INTO organizations (name, slug) VALUES ('Dev organization', $1)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [DEV_ORG_SLUG],
  );
  return rows[0]!;
}

/** Seeds the demo site (public id `gos_demo_local`) under the dev organisation. Idempotent. */
export async function seedDemoSite(db: Db, timezone = 'UTC'): Promise<{ id: string; organization_id: string; timezone: string }> {
  const org = await seedDevOrganization(db);
  const rows: { id: string; organization_id: string; timezone: string }[] = await db.query(
    `INSERT INTO sites (organization_id, name, domain, public_id, timezone)
     VALUES ($1, 'Demo site', 'localhost:5174', $2, $3)
     ON CONFLICT (public_id) DO UPDATE SET status = 'active'
     RETURNING id, organization_id, timezone`,
    [org.id, DEMO_SITE_PUBLIC_ID, timezone],
  );
  return rows[0]!;
}

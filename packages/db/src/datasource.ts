import 'reflect-metadata';
import { types } from 'pg';
import { DataSource, EntitySchema, type DataSourceOptions } from 'typeorm';
import { InitialSchema1762790400000 } from './migrations/1762790400000-InitialSchema';
import { SeoAudit1762963200000 } from './migrations/1762963200000-SeoAudit';
import { AiInsights1763049600000 } from './migrations/1763049600000-AiInsights';
import { AiConversationProvider1763136000000 } from './migrations/1763136000000-AiConversationProvider';

// node-pg defaults: DATE -> JS Date at local midnight (timezone bugs), BIGINT/NUMERIC -> string.
// Analytics needs calendar dates as plain strings and counts as numbers.
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(20, (v) => Number(v)); // int8
types.setTypeParser(1700, (v) => Number(v)); // numeric

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
}

export interface SiteRow {
  id: string;
  organization_id: string;
  name: string;
  domain: string;
  public_id: string;
  status: 'active' | 'inactive';
  timezone: string;
  created_at: Date;
  updated_at: Date;
}

export const OrganizationEntity = new EntitySchema<OrganizationRow>({
  name: 'Organization',
  tableName: 'organizations',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    name: { type: 'text' },
    slug: { type: 'text', unique: true },
    created_at: { type: 'timestamptz', createDate: true },
  },
});

export const SiteEntity = new EntitySchema<SiteRow>({
  name: 'Site',
  tableName: 'sites',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    organization_id: { type: 'uuid' },
    name: { type: 'text' },
    domain: { type: 'text' },
    public_id: { type: 'text', unique: true },
    status: { type: 'text', default: 'active' },
    timezone: { type: 'text', default: 'UTC' },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
  },
});

export const MIGRATIONS = [InitialSchema1762790400000, SeoAudit1762963200000, AiInsights1763049600000, AiConversationProvider1763136000000];

export function dataSourceOptions(url: string | undefined = process.env.DATABASE_URL): DataSourceOptions {
  if (!url) throw new Error('DATABASE_URL is not set');
  return {
    type: 'postgres',
    url,
    entities: [OrganizationEntity, SiteEntity],
    migrations: MIGRATIONS,
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    extra: { max: Number(process.env.DB_POOL_MAX ?? 10) },
  };
}

export function createDataSource(url?: string): DataSource {
  return new DataSource(dataSourceOptions(url));
}

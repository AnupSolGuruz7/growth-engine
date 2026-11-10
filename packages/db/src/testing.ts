import type { DataSource } from 'typeorm';
import { createDataSource } from './datasource';
import { loadEnv } from './env';

/**
 * Test helper: connects to TEST_DATABASE_URL, wipes the public schema and runs all migrations.
 * Refuses to run against a database whose name does not end in `_test`.
 */
export async function freshTestDataSource(): Promise<DataSource> {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  if (!/_test(\?|$)/.test(new URL(url).pathname + (new URL(url).search || ''))) {
    throw new Error(`Refusing to reset non-test database: ${url}`);
  }
  const ds = await createDataSource(url).initialize();
  await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await ds.runMigrations({ transaction: 'each' });
  return ds;
}

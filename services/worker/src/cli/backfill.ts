// Rebuilds sessions + rollups for a site and date range (site-timezone dates, inclusive).
// Usage: pnpm --filter @growthos/worker backfill <site-uuid> <YYYY-MM-DD> <YYYY-MM-DD>
import { createDataSource, markRangeDirty, processPending } from '@growthos/db';
import { loadWorkerConfig } from '../config';

async function main() {
  const [siteId, from, to] = process.argv.slice(2);
  if (!siteId || !/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
    console.error('Usage: backfill <site-uuid> <from YYYY-MM-DD> <to YYYY-MM-DD>');
    process.exit(2);
  }
  const cfg = loadWorkerConfig();
  const ds = await createDataSource(cfg.databaseUrl).initialize();
  const marked = await markRangeDirty(ds, siteId, from!, to!);
  const res = await processPending(ds, { sessionTimeoutMin: cfg.sessionTimeoutMin });
  console.log(`Marked ${marked} visitor-days; sessionized ${res.sessionized}, rolled up ${res.rolledUp} site-days.`);
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { createDataSource } from '../datasource';
import { loadEnv } from '../env';

async function main() {
  loadEnv();
  const ds = await createDataSource().initialize();
  const ran = await ds.runMigrations({ transaction: 'each' });
  console.log(ran.length ? `Applied: ${ran.map((m) => m.name).join(', ')}` : 'No pending migrations.');
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

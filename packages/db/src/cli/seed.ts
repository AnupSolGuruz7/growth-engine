import { createDataSource } from '../datasource';
import { loadEnv } from '../env';
import { seedDemoSite } from '../seed';

async function main() {
  loadEnv();
  const ds = await createDataSource().initialize();
  const site = await seedDemoSite(ds);
  console.log(`Seeded dev organization ${site.organization_id} and demo site ${site.id} (public id gos_demo_local).`);
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

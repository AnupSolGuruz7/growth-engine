import { createApp } from './app.factory';
import { loadConfig } from './config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await createApp();
  await app.listen(cfg.port, '0.0.0.0');
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});

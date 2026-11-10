import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadWorkerConfig } from './config';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(loadWorkerConfig()), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { MAX_BATCH_BYTES } from '@growthos/shared-types';
import { AppModule } from './app.module';
import { loadConfig, type AppConfig } from './config';

/** Builds the configured Nest app. Shared by main.ts and the e2e tests. */
export async function createApp(overrides: Partial<AppConfig> = {}): Promise<NestExpressApplication> {
  const cfg = loadConfig(overrides);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  if (cfg.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');

  // 64 KB cap on every body (spec §5.4). sendBeacon posts text/plain to avoid a CORS preflight.
  app.useBodyParser('json', { limit: MAX_BATCH_BYTES });
  app.useBodyParser('text', { limit: MAX_BATCH_BYTES, type: 'text/plain' });

  // CORS: ingestion must accept any origin. The read APIs are protected by X-Dev-Key, not by origin.
  app.enableCors({
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Dev-Key'],
    maxAge: 86400,
  });

  // Turn body-parser errors (too large / malformed) into JSON instead of Express' HTML page.
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: `Body exceeds ${MAX_BATCH_BYTES} bytes` });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'Body is not valid JSON' });
    }
    return next(err);
  });

  app.enableShutdownHooks();
  return app;
}

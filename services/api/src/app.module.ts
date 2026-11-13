import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { dataSourceOptions } from '@growthos/db';
import { AiModule } from './ai/ai.module';
import type { LlmProvider } from './ai/llm';
import { AnalyticsModule } from './analytics/analytics.module';
import { DevKeyGuard } from './common/dev-key.guard';
import { RedisService } from './common/redis';
import { APP_CONFIG, type AppConfig } from './config';
import { HealthController } from './health/health.controller';
import { KnowledgeController } from './knowledge/knowledge.controller';
import { KnowledgeService } from './knowledge/knowledge.service';
import { IngestController } from './ingest/ingest.controller';
import { IngestService } from './ingest/ingest.service';
import { RateLimiter } from './ingest/rate-limiter';
import { SiteCache } from './ingest/site-cache';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';
import { SdkController } from './sdk/sdk.controller';
import { SeoController } from './seo/seo.controller';
import { SeoService } from './seo/seo.service';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';

@Module({})
export class AppModule {
  /** deps.llm overrides the AI provider (tests); undefined = from config. */
  static forRoot(cfg: AppConfig, deps: { llm?: LlmProvider | null } = {}): DynamicModule {
    const shared = [
      { provide: APP_CONFIG, useValue: cfg },
      RedisService,
      SiteCache,
      SitesService,
      SeoService,
      KnowledgeService,
    ];
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: cfg.logLevel,
            transport: cfg.env === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
            // Never log IPs, cookies or the dev key (spec §13).
            serializers: {
              req: (r: { id: unknown; method: string; url: string }) => ({ id: r.id, method: r.method, url: r.url.split('?')[0] }),
              res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
            },
            autoLogging: { ignore: (req) => req.url === '/health' },
          },
        }),
        TypeOrmModule.forRoot({ ...dataSourceOptions(cfg.databaseUrl), migrationsRun: cfg.migrationsRun }),
        AnalyticsModule,
        AiModule.forRoot(cfg, deps.llm),
      ],
      controllers: [HealthController, IngestController, SitesController, MetricsController, SdkController, SeoController, KnowledgeController],
      providers: [
        ...shared,
        IngestService,
        RateLimiter,
        MetricsService,
        { provide: APP_GUARD, useClass: DevKeyGuard },
      ],
      exports: shared,
    };
  }
}

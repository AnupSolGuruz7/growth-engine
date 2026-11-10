import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { dataSourceOptions } from '@growthos/db';
import { WORKER_CONFIG, type WorkerConfig } from './config';
import { ProcessingWorker } from './processing.worker';

@Module({})
export class WorkerModule {
  static forRoot(cfg: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: cfg.logLevel,
            transport: cfg.env === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
          },
        }),
        TypeOrmModule.forRoot(dataSourceOptions(cfg.databaseUrl)),
      ],
      providers: [{ provide: WORKER_CONFIG, useValue: cfg }, ProcessingWorker],
    };
  }
}

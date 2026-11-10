import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Inject, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { findRepoRoot } from '@growthos/db';
import { Public } from '../common/public.decorator';
import { APP_CONFIG, type AppConfig } from '../config';

/** Serves the IIFE build of the SDK at /sdk.js for the script-tag install (spec §4.1). */
@Controller()
export class SdkController {
  private cached: { mtime: number; body: string } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  private file(): string | null {
    if (this.cfg.sdkFile) return this.cfg.sdkFile;
    const root = findRepoRoot(__dirname);
    return root ? join(root, 'packages', 'sdk', 'dist', 'growthos.iife.js') : null;
  }

  @Public()
  @Get('sdk.js')
  serve(@Res() res: Response): void {
    const file = this.file();
    if (!file || !existsSync(file)) {
      throw new NotFoundException({ error: 'sdk_not_built', message: 'Run `pnpm --filter @growthos/sdk build` first' });
    }
    const mtime = statSync(file).mtimeMs;
    if (!this.cached || this.cached.mtime !== mtime) this.cached = { mtime, body: readFileSync(file, 'utf8') };
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(this.cached.body);
  }
}

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

/** Walks up from `start` to the monorepo root (the folder with pnpm-workspace.yaml). */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads the root .env (if present) without overriding variables that are already set,
 * so docker / CI environment variables always win.
 */
export function loadEnv(): void {
  const root = findRepoRoot();
  if (root && existsSync(join(root, '.env'))) config({ path: join(root, '.env'), quiet: true } as never);
}

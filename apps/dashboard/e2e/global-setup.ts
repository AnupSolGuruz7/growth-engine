import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// Reseeds only the demo site (public id gos_demo_local); other sites are untouched.
export default function globalSetup(): void {
  execSync('pnpm db:migrate && pnpm db:seed-demo 28', { cwd: resolve(process.cwd(), '../..'), stdio: 'inherit' });
}

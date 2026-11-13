import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface WalkedFile {
  /** Forward-slash path relative to the source root, e.g. "knowledge/brand-facts.md". */
  rel: string;
  abs: string;
  ext: string;
  bytes: number;
  mtime: Date;
}

/** Directories never read: VCS, dependencies, build output, credentials, and the engine's own code/state. */
export const DEFAULT_EXCLUDE_DIRS = [
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.turbo',
  'secrets', 'state', 'src', 'test', 'tests', 'playwright-report', 'test-results',
];
const TEXT_EXT = new Set(['.md', '.mdx', '.txt']);
const MAX_FILES = 3000;
export const MAX_TEXT_BYTES = 1_500_000;

/** Files whose name says they hold credentials are skipped even inside allowed folders. */
const SECRET_NAME = /^\.env|\.pem$|\.key$|id_rsa|credentials|service-account|secret/i;

/**
 * Lists the files a knowledge sync may read under `root`: Markdown/text anywhere, JSON (checked
 * later for Search Console exports) and .mjs only inside a `rules/` folder (parsed statically, never
 * executed). Symlinks are not followed, so nothing outside the root is reachable.
 */
export async function walkSource(root: string, excludeDirs = DEFAULT_EXCLUDE_DIRS): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const exclude = new Set(excludeDirs.map((d) => d.toLowerCase()));
  async function visit(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        // dot-folders (.git, .claude, .github, .vscode, ...) hold tooling, not knowledge
        if (!exclude.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await visit(abs);
        continue;
      }
      if (!e.isFile() || SECRET_NAME.test(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const inRules = rel.split('/').slice(0, -1).includes('rules');
      if (!TEXT_EXT.has(ext) && ext !== '.json' && !(ext === '.mjs' && inRules)) continue;
      const st = await fs.stat(abs);
      if (st.size > MAX_TEXT_BYTES) continue;
      out.push({ rel, abs, ext, bytes: st.size, mtime: st.mtime });
    }
  }
  await visit(root);
  return out;
}

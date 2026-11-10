// Prints bundle sizes and fails the build if the script-tag bundle exceeds 5 KB gzipped (spec §4.4).
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const LIMIT = 5 * 1024;
let failed = false;
for (const f of ['dist/growthos.iife.js', 'dist/growthos.esm.js']) {
  const buf = readFileSync(new URL(`../${f}`, import.meta.url));
  const gz = gzipSync(buf, { level: 9 }).length;
  const over = gz > LIMIT;
  failed ||= over && f.includes('iife');
  console.log(`${f.padEnd(24)} ${(buf.length / 1024).toFixed(2)} KB raw  ${(gz / 1024).toFixed(2)} KB gzip${over ? '  OVER 5 KB' : ''}`);
}
if (failed) {
  console.error('SDK bundle exceeds the 5 KB gzip budget');
  process.exit(1);
}

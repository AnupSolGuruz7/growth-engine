import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ mode }) => {
  const iife = mode === 'iife';
  return {
    define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
    build: {
      target: 'es2019',
      emptyOutDir: !iife,
      minify: 'esbuild',
      sourcemap: true,
      lib: iife
        ? { entry: 'src/iife.ts', formats: ['iife'], name: 'GrowthOSLoader', fileName: () => 'growthos.iife.js' }
        : { entry: 'src/index.ts', formats: ['es'], fileName: () => 'growthos.esm.js' },
    },
    test: {
      environment: 'happy-dom',
      environmentOptions: { happyDOM: { url: 'https://shop.example.com/' } },
      restoreMocks: true,
    },
  };
});

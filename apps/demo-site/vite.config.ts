import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Serve the SPA shell for every /app/* route in dev and preview (History API routing).
const spaFallback = (): Plugin => {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url && /^\/app(\/[^.]*)?$/.test(req.url.split('?')[0]!)) req.url = '/app/index.html';
    next();
  };
  return {
    name: 'demo-spa-fallback',
    configureServer: (s) => void s.middlewares.use(rewrite),
    configurePreviewServer: (s) => void s.middlewares.use(rewrite),
  };
};

export default defineConfig({
  envDir: '../../',
  appType: 'mpa',
  plugins: [spaFallback()],
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        pricing: resolve(__dirname, 'pricing.html'),
        blog: resolve(__dirname, 'blog.html'),
        app: resolve(__dirname, 'app/index.html'),
      },
    },
  },
});

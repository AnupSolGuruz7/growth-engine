import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  envDir: '../../',
  plugins: [react()],
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // vendor chunks change rarely, so browsers keep them cached across dashboard deploys
        manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], antd: ['antd', '@ant-design/icons'], charts: ['recharts'] },
      },
    },
  },
});

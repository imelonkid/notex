import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { hostPlugin } from './server/hostPlugin';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), hostPlugin()],
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@host': r('./src/host'),
      '@runtimes': r('./src/runtimes'),
      '@ui': r('./src/ui'),
    },
  },
  server: { port: 5173, strictPort: false },
});

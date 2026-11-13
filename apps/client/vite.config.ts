import { defineConfig } from 'vite';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:8787';

export default defineConfig({
  server: {
    host: true,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: false },
});

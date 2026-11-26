import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const target = `http://127.0.0.1:${process.env.PORT ?? '3840'}`;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: "automatic" },
  server: { host: '127.0.0.1', proxy: { '/api': target, '/mcp': target, '/icons': target } },
});

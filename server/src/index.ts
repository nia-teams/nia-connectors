import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, loopback } from './app.js';

// Compiled and development entry points share the project-root resources.
const roots = ['../../../', '../../'].map(relative => fileURLToPath(new URL(relative, import.meta.url)));
const root = roots.find(path => existsSync(resolve(path, 'package.json')));
if (!root) throw new Error('Could not find the project root');
const port = Number(process.env.PORT ?? '3840');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const host = process.env.HOST ?? '127.0.0.1';
const localOrigin = host === '::1' ? `[::1]:${port}` : `127.0.0.1:${port}`;
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://${localOrigin}`;
const defaultRegistryUrl = 'https://nia-teams.github.io/nia-connector-registry/catalog.json';
const app = createApp({
  registryUrl: process.env.REGISTRY_URL ?? defaultRegistryUrl,
  stateDir: process.env.NIA_CONNECTORS_HOME ?? resolve(homedir(), '.nia-connectors'),
  baseUrl, allowStdio: process.env.ALLOW_STDIO === '1', staticDir: resolve(root, 'web/dist'),
});
const server = app.listen(port, host, () => {
  console.log(`Nia Connectors: ${baseUrl} · MCP: ${new URL('/mcp', baseUrl).href}`);
  if (!loopback(host === '::1' ? '[::1]' : host)) console.warn('Non-loopback binding: keep this single-user hub behind a private network or an authenticated TLS reverse proxy.');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());

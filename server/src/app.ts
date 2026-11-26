import express, { type ErrorRequestHandler } from 'express';
import { api, ApiError } from './api.js';
import { gateway, Upstreams } from './mcp-gateway.js';
import { Registry } from './registry.js';
import { CredentialStore } from './store.js';
import { McpOAuth } from './oauth.js';
import { registryIcon } from './icons.js';

const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
export function createApp({ registryUrl, stateDir, baseUrl, allowStdio = false, staticDir, oauthBrokerUrl }: {
  registryUrl: string; stateDir: string; baseUrl: string; allowStdio?: boolean; staticDir?: string; oauthBrokerUrl?: string;
}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTP(S) origin without credentials or a path');
  }
  const endpoint = new URL('/mcp', base).href;
  const registry = new Registry(registryUrl, stateDir);
  const store = new CredentialStore(stateDir);
  const oauth = new McpOAuth(registry, store, base, oauthBrokerUrl);
  const upstreams = new Upstreams(allowStdio, oauth);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.get('host');
    const origin = req.get('origin');
    const rawHost = host && /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d+)?$/.test(host);
    const localHost = rawHost && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
    if (!rawHost || (host.toLowerCase() !== base.host && !localHost)) return next(new ApiError(403, 'Untrusted Host header'));
    const originAllowed = !origin || origin === base.origin || (localHost && (origin === `http://${host}` || origin === `https://${host}`));
    const oauthNavigation = req.method === 'GET' && req.path === '/api/oauth/callback' &&
      req.get('sec-fetch-mode') === 'navigate' && req.get('sec-fetch-dest') === 'document';
    if (!oauthNavigation && (!originAllowed || req.get('sec-fetch-site') === 'cross-site')) return next(new ApiError(403, 'Untrusted Origin header'));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', api(registry, store, upstreams, endpoint, oauth));
  app.post('/mcp', gateway(registry, store, upstreams));
  app.all('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).end(); });
  app.get('/icons/:filename', registryIcon(registry.icons));
  if (staticDir) app.use(express.static(staticDir));
  const handleError: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const status = error instanceof ApiError ? error.status : error.status === 400 || error.status === 413 ? error.status : 500;
    const message = error instanceof ApiError ? error.message : status === 400 ? 'Invalid JSON body'
      : status === 413 ? 'Request body too large' : 'Service unavailable. Check the registry and local state configuration.';
    if (req.path === '/mcp') res.status(status).json({ jsonrpc: '2.0', error: { code: status === 400 ? -32700 : -32603, message }, id: null });
    else res.status(status).json({ error: message });
  };
  app.use(handleError);
  return app;
}
export { loopback };

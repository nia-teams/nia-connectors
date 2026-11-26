import { Router } from 'express';
import { z } from 'zod';
import { usesBrowserOAuth } from '../../shared/auth.js';
import type { CatalogResult, ClientConfigs, Connector, PublicConnector, TestResult } from '../../shared/catalog.js';
import { cliStatus } from './cli-manager.js';
import { credentialRedactor, safeUpstreamError, Upstreams } from './mcp-gateway.js';
import { activeState, connectionBinding } from './connection-state.js';
import { McpOAuthError, type McpOAuth } from './oauth.js';
import { oauthPage } from './oauth-page.js';
import type { Registry } from './registry.js';
import type { ConnectorState, CredentialStore } from './store.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const credentialInput = z.object({ credentials: z.record(z.string(), z.string().max(8192)).optional() }).strict();
const toolsInput = z.object({ disabledTools: z.array(z.string().min(1).max(256)).max(5000) }).strict();

function safeLink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return href;
  } catch { /* Ignore unsafe documentation links. */ }
}

function describe(connector: Connector, rawState?: ConnectorState): PublicConnector {
  const state = activeState(connector, rawState);
  const { id, kind, name, description, category, tags, auth, icon, examples, order } = connector;
  const fields = auth.fields?.map(field => ({ ...field, helpUrl: safeLink(field.helpUrl) }));
  const common = {
    id, kind, name, description, category, tags, icon, examples, order, auth: { ...auth, docUrl: safeLink(auth.docUrl), fields },
    configured: Object.fromEntries((fields ?? []).map(field => [field.name, Object.hasOwn(state.credentials, field.name) && Boolean(state.credentials[field.name])])),
    enabled: state.enabled, oauthAuthorizedAt: state.oauth?.tokens?.authorizedAt, disabledTools: state.disabledTools,
  };
  const status = auth.mode === 'oauth' ? 'coming-soon' : state.enabled ? 'enabled' : rawState ? 'disabled' : 'available';
  if (connector.kind === 'cli') return { ...common, status, cli: { ...connector.cli, docsUrl: safeLink(connector.cli.docsUrl) } };
  const { mcp } = connector;
  const endpoint = mcp.transport === 'stdio' || !/^https?:\/\//i.test(mcp.url) ? undefined
    : mcp.url.split(/[?#]/, 1)[0].replace(/^(https?:\/\/)[^/]*@/i, '$1');
  return { ...common, status, mcp: { transport: mcp.transport, endpoint } };
}

function submittedCredentials(body: unknown, connector: Connector, state: ConnectorState): Record<string, string> {
  const parsed = credentialInput.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError(400, 'Expected a credentials object with string values');
  const entries = Object.entries(parsed.data.credentials ?? {});
  const fields = connector.auth.fields ?? [];
  if (entries.some(([key]) => !fields.some(field => field.name === key))) throw new ApiError(400, 'Unknown credential field');
  const next = Object.fromEntries([...Object.entries(state.credentials), ...entries]);
  for (const { name, required } of fields) {
    if (required !== false && (!Object.hasOwn(next, name) || !next[name].trim())) throw new ApiError(400, `Missing credential: ${name}`);
  }
  return next;
}

function requireImplemented(connector: Connector) {
  if (connector.auth.mode === 'oauth') throw new ApiError(501, 'This vendor requires a pre-registered OAuth app.');
}

export function api(registry: Registry, store: CredentialStore, upstreams: Upstreams, endpoint: string, oauth: McpOAuth) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const connectorById = async (id: string) => {
    const connector = (await registry.get()).entries.find(item => item.id === id);
    if (!connector) throw new ApiError(404, 'Connector not found');
    return connector;
  };

  router.get('/health', (_req, res) => { res.json({ ok: true, service: 'nia-connectors' }); });
  router.get('/catalog', async (req, res) => {
    const { q, kind, category, status, refresh, auth } = req.query;
    const [{ entries, stale }, states] = await Promise.all([registry.get(refresh === '1'), store.snapshot()]);
    const all = entries.map(c => describe(c, states[c.id]));
    const query = typeof q === 'string' ? q.trim().toLocaleLowerCase() : '';
    const candidates = all.filter(c => (!kind || c.kind === kind) && (!auth || c.auth.mode === auth) && (!query || [c.id, c.name.zh, c.name.en, c.description.zh, c.description.en, c.auth.mode, ...(usesBrowserOAuth(c.auth.mode) ? ['OAuth 登录', '浏览器授权'] : []), ...c.tags]
      .some(text => text.toLocaleLowerCase().includes(query))));
    const categories: Record<string, number> = Object.create(null);
    for (const c of candidates) categories[c.category] = (categories[c.category] ?? 0) + 1;
    const result: CatalogResult = {
      connectors: candidates.filter(c => (!category || c.category === category) && (!status || c.status === status)),
      categories, counts: { all: candidates.length, enabled: candidates.filter(c => c.enabled).length }, stale,
    };
    res.json(result);
  });
  router.get('/connectors/:id', async (req, res) => {
    const [connector, states] = await Promise.all([connectorById(req.params.id), store.snapshot()]);
    res.json(describe(connector, states[connector.id]));
  });
  router.post('/connectors/:id/enable', async (req, res) => {
    const connector = await connectorById(req.params.id);
    requireImplemented(connector);
    if (usesBrowserOAuth(connector.auth.mode)) throw new ApiError(400, 'Authorize this connector with browser OAuth first.');
    const state = await store.update(connector.id, original => {
      const prior = activeState(connector, original);
      const credentials = submittedCredentials(req.body, connector, prior);
      if (connector.kind === 'mcp') {
        try { upstreams.validate(connector, credentials); }
        catch (error) { throw new ApiError(400, safeUpstreamError(error)); }
      }
      return { ...prior, enabled: true, credentials, binding: connectionBinding(connector) };
    });
    res.json(describe(connector, state));
  });
  router.post('/connectors/:id/disable', async (req, res) => {
    const connector = await connectorById(req.params.id);
    const state = usesBrowserOAuth(connector.auth.mode) ? await oauth.revoke(connector)
      : await store.update(connector.id, original => ({ ...activeState(connector, original), enabled: false, binding: connectionBinding(connector) }));
    res.json(describe(connector, state));
  });
  router.post('/connectors/:id/test', async (req, res) => {
    const connector = await connectorById(req.params.id);
    requireImplemented(connector);
    if (connector.kind !== 'mcp') throw new ApiError(400, 'Use the CLI status endpoint for CLI connectors');
    const start = performance.now();
    const state = activeState(connector, (await store.snapshot())[connector.id]);
    let result: TestResult;
    try {
      const credentials = submittedCredentials(req.body, connector, state);
      const redraw = credentialRedactor({ ...state, credentials });
      const tools = (await upstreams.list(connector, { ...state, credentials })).filter(t => redraw(t.name) === t.name).map(t => ({
        name: t.name, description: t.description ? redraw(t.description) : undefined, enabled: !state.disabledTools.includes(t.name),
      }));
      result = { ok: true, tools, latencyMs: Math.round(performance.now() - start), error: null };
    } catch (error) {
      result = { ok: false, tools: [], latencyMs: Math.round(performance.now() - start), error: error instanceof ApiError ? error.message : safeUpstreamError(error) };
    }
    res.json(result);
  });
  router.patch('/connectors/:id/tools', async (req, res) => {
    const connector = await connectorById(req.params.id);
    requireImplemented(connector);
    if (connector.kind !== 'mcp') throw new ApiError(400, 'CLI connectors do not expose MCP tools');
    const input = toolsInput.safeParse(req.body);
    if (!input.success) throw new ApiError(400, 'Expected disabledTools to be an array of tool names');
    const state = await store.update(connector.id, original => ({ ...activeState(connector, original), disabledTools: [...new Set(input.data.disabledTools)], binding: connectionBinding(connector) }));
    res.json(describe(connector, state));
  });
  router.post('/connectors/:id/oauth/start', async (req, res) => {
    const connector = await connectorById(req.params.id);
    if (connector.kind !== 'mcp' || !usesBrowserOAuth(connector.auth.mode) || connector.mcp.transport === 'stdio') {
      throw new ApiError(400, 'This connector does not use remote MCP browser OAuth.');
    }
    try {
      const senderOrigin = req.get('origin') ?? new URL(endpoint).origin;
      res.json({ authorizationUrl: await oauth.start(connector, senderOrigin) });
    } catch (error) {
      if (error instanceof McpOAuthError) throw new ApiError(502, error.message);
      throw error;
    }
  });
  router.post('/connectors/:id/oauth/revoke', async (req, res) => {
    const connector = await connectorById(req.params.id);
    if (!usesBrowserOAuth(connector.auth.mode)) throw new ApiError(400, 'This connector does not use browser OAuth.');
    res.json(describe(connector, await oauth.revoke(connector)));
  });
  router.get('/oauth/callback', async (req, res) => {
    if (req.method !== 'GET') throw new ApiError(405, 'OAuth callback requires GET');
    const result = await oauth.callback(req.query.state, req.query.code, req.query.iss, req.query.error !== undefined);
    oauthPage(res, result);
  });
  router.get('/cli/:id/status', async (req, res) => {
    const connector = await connectorById(req.params.id);
    if (connector.kind !== 'cli') throw new ApiError(404, 'CLI connector not found');
    res.json(await cliStatus(connector.cli));
  });
  router.get('/client-configs', async (_req, res) => {
    const [{ entries }, states] = await Promise.all([registry.get(), store.snapshot()]);
    const activeConnectors = entries.filter(c => c.kind === 'mcp' && c.auth.mode !== 'oauth' && activeState(c, states[c.id]).enabled).length;
    const result: ClientConfigs = {
      endpoint, transport: 'streamable-http', activeConnectors,
      config: { mcpServers: { 'nia-connectors': { type: 'http', url: endpoint } } },
    };
    res.json(result);
  });
  router.use((_req, _res, next) => next(new ApiError(404, 'API route not found')));
  return router;
}

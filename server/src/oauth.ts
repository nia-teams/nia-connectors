import { createHash, randomBytes } from 'node:crypto';
import {
  discoverAuthorizationServerMetadata, extractWWWAuthenticateParams,
  registerClient, selectResourceURL, startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthTokensSchema, type AuthorizationServerMetadata, type OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { usesBrowserOAuth } from '../../shared/auth.js';
import type { Connector } from '../../shared/catalog.js';
import { activeState, connectionBinding } from './connection-state.js';
import type { Registry } from './registry.js';
import type { ConnectorState, CredentialStore, OAuthState } from './store.js';

const ttl = 10 * 60_000;
const callbackPath = '/api/oauth/callback';
const refreshWindow = 60_000;
const timeout = 8_000;
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export class McpOAuthError extends Error {}

function secureUrl(value: string | URL, allowLoopback: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new McpOAuthError('Invalid OAuth endpoint URL.'); }
  const local = loopback(url.hostname);
  if (url.username || url.password || url.hash || (local && !allowLoopback) ||
      !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new McpOAuthError('OAuth endpoints must use HTTPS (HTTP is allowed on loopback only).');
  }
  return url;
}
function guardedFetch(allowLoopback: boolean, outerSignal?: AbortSignal): FetchLike {
  return (input, init) => {
    const url = secureUrl(input instanceof Request ? input.url : input, allowLoopback);
    const signals = [AbortSignal.timeout(timeout), outerSignal, init?.signal].filter((s): s is AbortSignal => Boolean(s));
    return fetch(input instanceof Request ? input : url, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  };
}
function resourceUrl(connector: Connector): URL {
  if (connector.kind !== 'mcp' || !usesBrowserOAuth(connector.auth.mode) || connector.mcp.transport === 'stdio') {
    throw new McpOAuthError('Browser OAuth is only available for remote MCP connectors.');
  }
  return secureUrl(connector.mcp.url, true);
}

// Exported separately so operators can verify discovery without touching registration or token endpoints.
export async function discoverMcpOAuth(endpoint: URL, transport: 'streamable-http' | 'sse' = 'streamable-http') {
  endpoint = secureUrl(endpoint, true);
  const fetchFn = guardedFetch(loopback(endpoint.hostname), AbortSignal.timeout(25_000));
  const probe = await fetchFn(endpoint, transport === 'streamable-http' ? {
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1,
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Nia Connectors', version: '0.1.0' } } }),
  } : { headers: { Accept: 'text/event-stream' } });
  const challenge = probe.status === 401 ? extractWWWAuthenticateParams(probe) : {};
  await probe.body?.cancel();
  const basePath = '/.well-known/oauth-protected-resource';
  const candidates = new Set([challenge.resourceMetadataUrl?.href,
    new URL(`${basePath}${endpoint.pathname.replace(/\/$/, '')}`, endpoint).href,
    new URL(basePath, endpoint).href]);
  let prm: OAuthProtectedResourceMetadata | undefined;
  for (const url of candidates) {
    if (!url) continue;
    const response = await fetchFn(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION } });
    if (response.ok) { prm = OAuthProtectedResourceMetadataSchema.parse(await response.json()); break; }
    await response.body?.cancel();
    if (![404, 405, 410].includes(response.status)) throw new McpOAuthError('The provider’s protected resource metadata could not be loaded.');
  }
  await selectResourceURL(endpoint, {} as Parameters<typeof selectResourceURL>[1], prm);
  const resource = prm?.resource ?? endpoint.href;
  const issuers = prm?.authorization_servers?.length ? prm.authorization_servers : [endpoint.origin];
  let selected: { issuer: URL; metadata: AuthorizationServerMetadata } | undefined;
  for (const candidate of issuers) {
    const issuer = secureUrl(candidate, loopback(endpoint.hostname));
    if (issuer.search) throw new McpOAuthError('The OAuth issuer must not contain a query.');
    let metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
    if (!metadata && issuer.pathname !== '/') {
      // A path-mounted provider may expose the RFC 8414 document inside its mount.
      const mounted = new URL(`${issuer.pathname.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`, issuer);
      const response = await fetchFn(mounted, { headers: { Accept: 'application/json' } });
      if (response.ok) metadata = OAuthMetadataSchema.parse(await response.json());
      else await response.body?.cancel();
    }
    if (!metadata) continue;
    if (secureUrl(metadata.issuer, loopback(endpoint.hostname)).href !== issuer.href) {
      throw new McpOAuthError('The authorization server metadata issuer did not match discovery.');
    }
    if (!metadata.registration_endpoint || !metadata.token_endpoint || !metadata.code_challenge_methods_supported?.includes('S256')) continue;
    for (const value of [metadata.authorization_endpoint, metadata.registration_endpoint, metadata.token_endpoint]) {
      secureUrl(value, loopback(endpoint.hostname));
    }
    selected = { issuer, metadata }; break;
  }
  if (!selected) throw new McpOAuthError('The provider does not advertise dynamic registration, a token endpoint, and PKCE S256.');
  return { ...selected, resource, scope: challenge.scope ?? ((prm?.scopes_supported ?? []).join(' ') || undefined), probeStatus: probe.status, advertisedMetadata: challenge.resourceMetadataUrl?.href, protectedResourceMetadata: prm !== undefined };
}

type Discovery = Awaited<ReturnType<typeof discoverMcpOAuth>>;
type Registration = OAuthState['registration'];
type Tokens = NonNullable<OAuthState['tokens']>;
type Transaction = { id: string; binding: string; senderOrigin: string; expiresAt: number; registration: Registration } & (
  { mode: 'mcp-oauth'; verifier: string; tokenEndpoint: string; resource: string } |
  { mode: 'nia-oauth'; brokerState: string; verifier?: string; brokerTokenUrl: string; resource?: string }
);
type Grant = { grant_type: 'authorization_code'; code: string; code_verifier?: string } |
  { grant_type: 'refresh_token'; refresh_token: string };

async function requestTokens(endpoint: URL, registration: Registration, params: URLSearchParams, resource?: string) {
  if (resource) params.set('resource', resource);
  const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' });
  if (registration.authMethod === 'client_secret_basic') {
    const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
    headers.set('Authorization', `Basic ${Buffer.from(`${encode(registration.clientId)}:${encode(registration.clientSecret!)}`).toString('base64')}`);
  } else {
    params.set('client_id', registration.clientId);
    if (registration.authMethod === 'client_secret_post') params.set('client_secret', registration.clientSecret!);
  }
  const response = await guardedFetch(loopback(endpoint.hostname))(endpoint, { method: 'POST', headers, body: params });
  return parseTokens(response);
}

function requestBrokerTokens(endpoint: URL, connector: string, grant: Grant, resource?: string) {
  return guardedFetch(loopback(endpoint.hostname))(endpoint, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ connector, ...grant, ...(resource ? { resource } : {}) }),
  }).then(parseTokens);
}

async function parseTokens(response: Response) {
  if (!response.ok) { await response.body?.cancel(); throw new McpOAuthError('Token exchange failed. Reauthorize the connector and try again.'); }
  const tokens = OAuthTokensSchema.parse(await response.json());
  if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || !/^[A-Za-z0-9_.~+\/=-]+$/.test(tokens.access_token)) {
    throw new McpOAuthError('The provider returned an invalid Bearer access token.');
  }
  return {
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
  };
}

export class McpOAuth {
  private readonly pending = new Map<string, Transaction>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly redirectUri: string;
  constructor(private readonly registry: Registry, private readonly store: CredentialStore, base: URL,
    private readonly brokerBase = process.env.NIA_OAUTH_BROKER_URL ?? 'https://nia-teams.com/api/connectors/oauth') {
    this.redirectUri = new URL(callbackPath, base).href;
  }

  private brokerEndpoints() {
    const base = secureUrl(this.brokerBase, true);
    if (base.search) throw new McpOAuthError('The OAuth broker base URL must not contain a query.');
    const issuer = base.href.replace(/\/+$/, '');
    return { issuer, callback: `${issuer}/callback`, token: `${issuer}/token`, allowLoopback: loopback(base.hostname) };
  }

  private serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
    this.operations.set(id, next);
    const clean = () => { if (this.operations.get(id) === next) this.operations.delete(id); };
    void next.then(clean, clean);
    return next;
  }

  private clearPending(id: string) {
    for (const [key, value] of this.pending) if (value.id === id || value.expiresAt <= Date.now()) this.pending.delete(key);
  }

  private async register(discovery: Discovery, endpoint: URL): Promise<Registration> {
    const { issuer, metadata } = discovery;
    const result = await registerClient(issuer, { metadata, fetchFn: guardedFetch(loopback(endpoint.hostname)), clientMetadata: {
      client_name: 'Nia Connectors', redirect_uris: [this.redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
    } });
    if (!result.client_id || !result.redirect_uris.includes(this.redirectUri)) throw new McpOAuthError('The provider did not register this callback URL.');
    const authMethod = result.token_endpoint_auth_method ?? 'none';
    if (!(authMethod === 'none' || authMethod === 'client_secret_basic' || authMethod === 'client_secret_post') ||
        (authMethod !== 'none' && !result.client_secret)) throw new McpOAuthError('The provider returned an unsupported client authentication method.');
    return { issuer: issuer.href, redirectUri: this.redirectUri, clientId: result.client_id, clientSecret: result.client_secret, authMethod };
  }

  start(connector: Connector, senderOrigin: string): Promise<string> {
    return this.serial(connector.id, async () => {
      const endpoint = resourceUrl(connector);
      try {
        secureUrl(this.redirectUri, true);
        if (connector.auth.mode === 'nia-oauth') return this.startBroker(connector, senderOrigin);
        const transport = connector.kind === 'mcp' && connector.mcp.transport === 'sse' ? 'sse' : 'streamable-http';
        const discovery = await discoverMcpOAuth(endpoint, transport);
        const binding = connectionBinding(connector);
        const registration = await this.register(discovery, endpoint);
        this.clearPending(connector.id);
        if (this.pending.size >= 256) throw new McpOAuthError('Too many pending OAuth requests. Try again later.');
        const state = randomBytes(32).toString('base64url');
        const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.issuer, {
          metadata: discovery.metadata, clientInformation: { client_id: registration.clientId },
          redirectUrl: this.redirectUri, resource: discovery.resource, scope: discovery.scope, state,
        });
        this.pending.set(state, { mode: 'mcp-oauth', id: connector.id, binding, verifier: codeVerifier, tokenEndpoint: discovery.metadata.token_endpoint!,
          resource: discovery.resource, registration, senderOrigin, expiresAt: Date.now() + ttl });
        return authorizationUrl.href;
      } catch (error) {
        if (error instanceof McpOAuthError) throw error;
        throw new McpOAuthError('OAuth discovery or dynamic registration failed. Check the provider and callback URL.');
      }
    });
  }

  private startBroker(connector: Connector, senderOrigin: string): string {
    const oauth = connector.auth.oauth;
    if (!oauth) throw new McpOAuthError('This connector is missing its OAuth broker configuration.');
    const broker = this.brokerEndpoints();
    const authorizationUrl = secureUrl(oauth.authorizeUrl, broker.allowLoopback);
    this.clearPending(connector.id);
    if (this.pending.size >= 256) throw new McpOAuthError('Too many pending OAuth requests. Try again later.');
    const localState = randomBytes(32).toString('base64url');
    const verifier = oauth.usePkce === false ? undefined : randomBytes(32).toString('base64url');
    const state = `nia1.${Buffer.from(JSON.stringify({ r: this.redirectUri, s: localState })).toString('base64url')}`;
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: oauth.clientId, redirect_uri: broker.callback,
      state, scope: oauth.scope, resource: oauth.resource,
      code_challenge: verifier ? createHash('sha256').update(verifier).digest('base64url') : undefined,
      code_challenge_method: verifier ? 'S256' : undefined,
    })) {
      if (value !== undefined) authorizationUrl.searchParams.set(key, value);
      else authorizationUrl.searchParams.delete(key);
    }
    const registration: Registration = { issuer: broker.issuer, redirectUri: broker.callback, clientId: oauth.clientId, authMethod: 'none' };
    this.pending.set(localState, { mode: 'nia-oauth', brokerState: state, id: connector.id, binding: connectionBinding(connector), verifier,
      brokerTokenUrl: broker.token, resource: oauth.resource, registration, senderOrigin, expiresAt: Date.now() + ttl });
    return authorizationUrl.href;
  }

  private pendingState(state: string): string {
    if (state.startsWith('nia1.')) {
      // The broker may relay the full state or only the local nonce. Never decode an
      // incoming envelope to select a flow: require an exact match to one we issued.
      for (const [localState, flow] of this.pending) {
        if (flow.mode === 'nia-oauth' && flow.brokerState === state) return localState;
      }
    }
    return state;
  }

  async callback(state: unknown, code: unknown, issuer: unknown, providerError: boolean) {
    if (typeof state !== 'string') return { status: 400, ok: false };
    const localState = this.pendingState(state);
    const flow = this.pending.get(localState);
    if (!flow) return { status: 400, ok: false };
    return this.serial(flow.id, async () => {
      if (this.pending.get(localState) !== flow) return { status: 400, ok: false };
      this.pending.delete(localState);
      const info = { senderOrigin: flow.senderOrigin, id: flow.id };
      // Only discovery flows have an independently known provider issuer.
      if (flow.expiresAt <= Date.now() ||
          (flow.mode === 'mcp-oauth' && issuer !== undefined && (typeof issuer !== 'string' || new URL(flow.registration.issuer).href !== normalizeIssuer(issuer)))) {
        return { status: 400, ok: false, ...info };
      }
      if (providerError) return { status: 400, ok: false, providerRejected: true, ...info };
      if (typeof code !== 'string' || !code || code.length > 8192) return { status: 400, ok: false, ...info };
      try {
        const connector = (await this.registry.get()).entries.find(c => c.id === flow.id);
        if (!connector || connectionBinding(connector) !== flow.binding) return { status: 409, ok: false, ...info };
        const broker = flow.mode === 'nia-oauth' ? true : undefined;
        const tokenEndpoint = flow.mode === 'nia-oauth' ? flow.brokerTokenUrl : flow.tokenEndpoint;
        const endpoint = secureUrl(tokenEndpoint, broker ? this.brokerEndpoints().allowLoopback : loopback(resourceUrl(connector).hostname));
        const result = flow.mode === 'nia-oauth'
          ? await requestBrokerTokens(endpoint, flow.id, { grant_type: 'authorization_code', code, code_verifier: flow.verifier }, flow.resource)
          : await requestTokens(endpoint, flow.registration, new URLSearchParams({
            grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: flow.registration.redirectUri,
          }), flow.resource);
        const tokens = { ...result, resource: flow.resource, tokenEndpoint: endpoint.href, authorizedAt: Date.now() };
        await this.store.update(flow.id, original => ({ ...activeState(connector, original), binding: flow.binding,
          enabled: true, oauth: { registration: flow.registration, tokens, broker } }));
        return { status: 200, ok: true, ...info };
      } catch { return { status: 502, ok: false, ...info }; }
    });
  }

  revoke(connector: Connector): Promise<ConnectorState> {
    return this.serial(connector.id, async () => {
      this.clearPending(connector.id);
      return this.store.update(connector.id, old => {
        const prior = activeState(connector, old);
        return { ...prior, binding: connectionBinding(connector), enabled: false, oauth: undefined };
      });
    });
  }

  token(connector: Connector, rejected?: string): Promise<string> {
    return this.serial(connector.id, async () => {
      const resource = resourceUrl(connector);
      const state = activeState(connector, (await this.store.snapshot())[connector.id]);
      const tokens = state.oauth?.tokens;
      if (!tokens || !state.enabled || !state.oauth) throw new McpOAuthError('Authorize the connector in the dashboard first.');
      const broker = connector.auth.mode === 'nia-oauth' ? this.brokerEndpoints() : undefined;
      if (Boolean(broker) !== Boolean(state.oauth.broker) || (broker && tokens.tokenEndpoint !== broker.token)) {
        throw new McpOAuthError('The OAuth broker changed. Reauthorize the connector.');
      }
      const refresh = rejected !== undefined ? rejected === tokens.accessToken
        : tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now() + refreshWindow;
      if (!refresh || (!rejected && !tokens.refreshToken && (tokens.expiresAt ?? Infinity) > Date.now())) return tokens.accessToken;
      if (!tokens.refreshToken) throw new McpOAuthError('The authorization has expired. Reauthorize the connector.');
      try {
        const oauth = state.oauth;
        const endpoint = secureUrl(tokens.tokenEndpoint, broker?.allowLoopback ?? loopback(resource.hostname));
        const grant = { grant_type: 'refresh_token', refresh_token: tokens.refreshToken } as const;
        const renewed = broker ? await requestBrokerTokens(endpoint, connector.id, grant, tokens.resource)
          : await requestTokens(endpoint, oauth.registration, new URLSearchParams(grant), tokens.resource);
        const updated: Tokens = { ...tokens, ...renewed, refreshToken: renewed.refreshToken ?? tokens.refreshToken };
        await this.store.update(connector.id, original => ({ ...original, oauth: { ...oauth, tokens: updated } }));
        return updated.accessToken;
      } catch { throw new McpOAuthError('Could not refresh the OAuth token. Reauthorize the connector and try again.'); }
    });
  }
}

function normalizeIssuer(value: string) {
  try { return new URL(value).href; } catch { return undefined; }
}

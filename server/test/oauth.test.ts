import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { get as getHttp, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connector } from '../../shared/catalog.js';
import { createApp } from '../src/app.js';
import { CredentialStore } from '../src/store.js';
import { discoverMcpOAuth } from '../src/oauth.js';
import { mockOAuth } from './fixtures/mock-oauth.js';

const id = 'oauth-docs';
const navigate = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const browserNavigate = (url: string | URL): Promise<Response> => new Promise((resolve, reject) => {
  getHttp(url, { headers: navigate }, async response => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of response) chunks.push(chunk);
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers }));
    } catch (error) { reject(error); }
  }).on('error', reject);
});
async function expectProviderError(callback: URL) {
  const rejected = new URL(callback);
  rejected.searchParams.set('error', 'fixture-untrusted-error');
  rejected.searchParams.set('error_description', '<script>fixture-untrusted-description</script>');
  const response = await browserNavigate(rejected);
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /服务提供方未完成授权/);
  assert.doesNotMatch(body, /fixture-untrusted/);
}
const post = (data: object = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const close = (t: TestContext, server: Server) => t.after(() => { server.closeAllConnections(); server.close(); });

async function hub(t: TestContext, resource: string, auth: Connector['auth'] = { mode: 'mcp-oauth' }, oauthBrokerUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-oauth-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registryUrl = join(dir, 'catalog.json');
  const entry = { id, kind: 'mcp', name: { zh: '测试文档', en: 'OAuth Docs' }, description: { zh: '测试文档工具', en: 'Test documents' },
    category: 'office', tags: [], auth, mcp: { transport: 'streamable-http', url: resource } };
  await writeFile(registryUrl, JSON.stringify({ connectors: [entry, { ...entry, id: 'vendor', auth: { mode: 'oauth' } }] }));
  // Set the actual listen origin for the dynamically registered callback in an isolated system-assigned port.
  const reservation = (await import('node:net')).createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address(); assert(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const server = createApp({ registryUrl, stateDir: dir, baseUrl: base, oauthBrokerUrl }).listen(address.port, '127.0.0.1');
  close(t, server); await once(server, 'listening');
  const get = (path: string, options?: RequestInit) => fetch(`${base}/api${path}`, options);
  const connector = (action = '', options?: RequestInit) => get(`/connectors/${id}${action}`, options);
  async function start() {
    const response = await connector('/oauth/start', post());
    assert.equal(response.status, 200, await response.clone().text());
    return new URL((await response.json()).authorizationUrl);
  }
  return { base, dir, get, connector, start };
}

test('MCP OAuth: 401 discovery, DCR, state, PKCE, callback, encrypted storage, Bearer gateway, rotation, retry and revoke', async t => {
  const provider = await mockOAuth(); close(t, provider.server);
  const { base, dir, get, connector, start } = await hub(t, provider.resource);
  assert.equal((await (await get('/catalog?auth=mcp-oauth')).json()).connectors.length, 1);
  assert.equal((await get('/connectors/vendor/enable', post())).status, 501);
  assert.equal((await connector('/enable', post())).status, 400);
  assert.equal((await (await connector('/test', post())).json()).ok, false);
  assert.equal((await connector('/oauth/start', { ...post(), headers: { ...post().headers, ...navigate } })).status, 403);
  assert.equal((await browserNavigate(`${base}/api/oauth/callback?state=fake&code=fake`)).status, 400);
  const authUrl = await start();
  assert.equal(authUrl.origin, provider.base);
  assert.equal(authUrl.searchParams.get('redirect_uri'), `${base}/api/oauth/callback`);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authUrl.searchParams.get('state')!, /^[\w-]{43}$/);
  assert.equal(provider.stats.probes, 1);
  assert.equal(provider.stats.registrations, 1);
  assert.equal((await (await connector()).json()).enabled, false);
  const approval = await fetch(authUrl, { redirect: 'manual' });
  const callback = approval.headers.get('location')!;
  assert.equal((await fetch(callback, { headers: { ...navigate, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403);
  assert.equal((await fetch(callback, { method: 'HEAD' })).status, 405);
  const completed = await browserNavigate(callback);
  assert.equal(completed.status, 200, await completed.clone().text());
  const html = await completed.text();
  assert.match(html, /授权成功/);
  assert.match(html, /nia-connectors:oauth/);
  assert.match(completed.headers.get('content-security-policy')!, /script-src 'nonce-/);
  assert.equal(completed.headers.get('cache-control'), 'no-store');
  const secrets = Object.values(provider.tokens());
  assert(![...secrets, provider.clientId, provider.clientSecret, ...new URL(callback).searchParams.values()]
    .filter(value => !value.startsWith('http')).some(secret => html.includes(secret)));
  assert.equal((await browserNavigate(callback)).status, 400);
  assert.equal(provider.stats.exchanges, 1);
  const status = await (await connector()).json();
  const encrypted = await readFile(join(dir, 'state.enc.json'), 'utf8');
  for (const value of [...secrets, provider.clientId, provider.clientSecret]) {
    assert(!encrypted.includes(value)); assert(!JSON.stringify(status).includes(value));
  }
  assert(status.enabled && status.oauthAuthorizedAt);
  const read = async () => (await new CredentialStore(dir).snapshot())[id].oauth!;
  assert.equal((await read()).registration.clientSecret, provider.clientSecret);
  assert.equal((await read()).tokens!.accessToken, provider.tokens().accessToken);

  // Both callers see the near-expiry token, but only one rotating refresh token may be redeemed.
  const network = await Promise.all([connector('/test', post()), connector('/test', post())]);
  const result = await Promise.all(network.map(response => response.json()));
  assert(result.every(r => r.ok), JSON.stringify(result));
  assert(!JSON.stringify(result).includes(provider.tokens().accessToken));
  assert.equal(provider.stats.refreshes, 1);
  assert.equal((await read()).tokens!.refreshToken, provider.tokens().refreshToken);

  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  t.after(() => client.close());
  provider.stats.rejectNext = true;
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), [`${id}__get_document`]);
  assert.equal(provider.stats.refreshes, 2);
  assert.equal(provider.stats.rejected, 1);
  assert.equal((await read()).tokens!.refreshToken, provider.tokens().refreshToken);
  const call = await client.callTool({ name: `${id}__get_document` });
  assert.deepEqual(call.content, [{ type: 'text', text: 'Document found [redacted]' }]);
  assert.equal(provider.stats.calls, 1);
  provider.stats.rejectAll = true;
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal(provider.stats.refreshes, 3);
  assert.equal(provider.stats.rejected, 3, 'failed original call and exactly one retry');
  provider.stats.rejectAll = false;
  assert.equal((await (await get('/client-configs')).json()).activeConnectors, 1);

  const denied = new URL((await fetch(await start(), { redirect: 'manual' })).headers.get('location')!);
  await expectProviderError(denied);
  assert.equal((await browserNavigate(denied)).status, 400, 'provider error consumes standard OAuth state');
  assert.equal(provider.stats.exchanges, 1, 'an error takes precedence over a code');

  const reauthorize = await start();
  const wrongIssuer = new URL((await fetch(reauthorize, { redirect: 'manual' })).headers.get('location')!);
  wrongIssuer.searchParams.set('iss', `${provider.base}/different-issuer`);
  assert.equal((await browserNavigate(wrongIssuer)).status, 400);
  assert.equal(provider.stats.exchanges, 1);
  const expiring = await start();
  const expired = (await fetch(expiring, { redirect: 'manual' })).headers.get('location')!;
  const future = Date.now() + 10 * 60_000 + 1;
  const clock = t.mock.method(Date, 'now', () => future);
  try { assert.equal((await browserNavigate(expired)).status, 400); }
  finally { clock.mock.restore(); }
  assert.equal((await browserNavigate(expired)).status, 400, 'expired state was consumed');
  const pending = await start();
  const afterRevoke = (await fetch(pending, { redirect: 'manual' })).headers.get('location')!;
  const revoked = await (await connector('/oauth/revoke', post())).json();
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.oauthAuthorizedAt, undefined);
  assert.equal(await read(), undefined);
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal((await browserNavigate(afterRevoke)).status, 400);
  const registrationsBefore = provider.stats.registrations;
  assert(registrationsBefore > 1, 'fresh DCR registration on each explicit start() avoids stale provider client_ids');
  const finalAttempt = await start();
  assert.equal(provider.stats.registrations, registrationsBefore + 1);
  assert.equal((await fetch(finalAttempt)).status, 200);
  assert.equal((await connector('/disable', post())).status, 200);
  assert.equal(await read(), undefined);
});

test('OAuth discovery uses root resource and path-mounted issuer fallback, rejects issuer mismatch, and never registers', async t => {
  const good = await mockOAuth({ fallback: true }); close(t, good.server);
  const result = await discoverMcpOAuth(new URL(good.resource));
  assert.equal(result.probeStatus, 401);
  assert(result.protectedResourceMetadata);
  assert.equal(result.metadata.issuer, good.issuer);
  assert.equal(result.metadata.registration_endpoint, `${good.base}/register`);
  assert.equal(good.stats.registrations, 0);
  const bad = await mockOAuth({ mismatch: true }); close(t, bad.server);
  await assert.rejects(discoverMcpOAuth(new URL(bad.resource)), /issuer did not match/);
  assert.equal(bad.stats.registrations, 0);
});

test('Nia OAuth: stateless broker callback, encrypted storage, Bearer injection, 401 refresh and disconnect', async t => {
  const provider = await mockOAuth(); close(t, provider.server);
  const brokerApp = express();
  const brokerServer = brokerApp.listen(0, '127.0.0.1'); close(t, brokerServer);
  await once(brokerServer, 'listening');
  const addr = brokerServer.address(); assert(addr && typeof addr === 'object');
  const brokerOrigin = `http://127.0.0.1:${addr.port}`;
  const brokerBase = `${brokerOrigin}/api/connectors/oauth`;
  const cloudCallback = `${brokerBase}/callback`;
  const clientId = 'fixture-registered-public-client';
  const scope = 'docs.read offline_access';
  const code = 'fixture-broker-authorization-code';
  let challenge: string | null = null;
  let usePkce = true;
  let preserveState = false;
  let invalidResponse = false;
  let requests = 0;
  let exchanges = 0;
  let refreshes = 0;
  brokerApp.get('/authorize', (req, res) => {
    assert.equal(req.query.response_type, 'code');
    assert.equal(req.query.client_id, clientId);
    assert.equal(req.query.redirect_uri, cloudCallback);
    assert.equal(req.query.scope, usePkce ? scope : undefined);
    assert.equal(req.query.resource, usePkce ? provider.resource : undefined);
    const redirect = new URL(cloudCallback);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', String(req.query.state));
    res.redirect(302, redirect.href);
  });
  brokerApp.get('/api/connectors/oauth/callback', (req, res) => {
    const [version, envelope, trailing] = String(req.query.state).split('.');
    assert.equal(version, 'nia1'); assert.equal(trailing, undefined);
    const { r, s } = JSON.parse(Buffer.from(envelope, 'base64url').toString());
    assert.match(s, /^[\w-]{43}$/);
    const redirect = new URL(r);
    assert.equal(redirect.pathname, '/api/oauth/callback');
    redirect.searchParams.set('state', preserveState ? String(req.query.state) : s);
    redirect.searchParams.set('code', String(req.query.code));
    res.redirect(302, redirect.href);
  });
  brokerApp.post('/api/connectors/oauth/token', express.json(), (req, res) => {
    requests++;
    assert.equal(req.get('authorization'), undefined);
    if (req.body.grant_type === 'authorization_code') {
      exchanges++;
      const required = { connector: id, grant_type: 'authorization_code', code };
      if (usePkce) {
        const code_verifier = req.body.code_verifier;
        assert.match(code_verifier, /^[\w-]{43}$/);
        assert.equal(createHash('sha256').update(code_verifier).digest('base64url'), challenge);
        assert.deepEqual(req.body, { ...required, resource: provider.resource, code_verifier });
      } else assert.deepEqual(req.body, required);
    } else {
      refreshes++;
      assert.deepEqual(req.body, { connector: id, grant_type: 'refresh_token', resource: provider.resource,
        refresh_token: provider.tokens().refreshToken });
    }
    res.json(invalidResponse ? { token_type: 'Bearer', access_token: 'unsafe token' } : provider.issueTokens());
  });
  const authorization = { authorizeUrl: `${brokerOrigin}/authorize`, clientId };
  const remote = await hub(t, provider.resource, { mode: 'nia-oauth', oauth: { ...authorization, scope, resource: provider.resource } }, `${brokerBase}/`);
  const { base, dir, get, connector, start } = remote;
  const before = await (await connector()).json();
  assert.equal(before.status, 'available');
  assert.equal((await connector('/enable', post())).status, 400);
  assert.equal((await (await get('/catalog?auth=nia-oauth&q=浏览器授权')).json()).counts.all, 1);
  async function roundTrip(authUrl: URL, localOrigin: string) {
    const approval = await fetch(authUrl, { redirect: 'manual' });
    assert.equal(approval.status, 302);
    const callback = await fetch(approval.headers.get('location')!, { redirect: 'manual' });
    assert.equal(callback.status, 302);
    const redirect = new URL(callback.headers.get('location')!);
    assert.equal(redirect.origin, localOrigin);
    if (preserveState) assert.equal(redirect.searchParams.get('state'), authUrl.searchParams.get('state'));
    else assert.match(redirect.searchParams.get('state')!, /^[\w-]{43}$/);
    return redirect;
  }
  const authUrl = await start();
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  challenge = authUrl.searchParams.get('code_challenge'); assert.match(challenge!, /^[\w-]{43}$/);
  const callback = await roundTrip(authUrl, base);
  const outerState = authUrl.searchParams.get('state')!;
  const tampered = new URL(callback);
  const payload = JSON.parse(Buffer.from(outerState.split('.')[1], 'base64url').toString());
  tampered.searchParams.set('state', `nia1.${Buffer.from(JSON.stringify({ ...payload, r: `${base}/api/oauth/callback?other=1` })).toString('base64url')}`);
  assert.equal((await browserNavigate(tampered)).status, 400, 'a changed envelope must not match its valid local nonce');
  assert.equal(requests, 0, 'cloud callback does not exchange codes');
  const completed = await browserNavigate(callback);
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.match(await completed.text(), /授权成功/);
  assert.equal((await browserNavigate(callback)).status, 400, 'local state is one-time');
  const outerReplay = new URL(callback);
  outerReplay.searchParams.set('state', outerState);
  assert.equal((await browserNavigate(outerReplay)).status, 400, 'the full envelope shares the local nonce’s one-time use');
  assert.equal(exchanges, 1);
  const read = async () => (await new CredentialStore(dir).snapshot())[id];
  const stored = await read();
  assert(stored.enabled);
  assert.equal(stored.oauth?.broker, true);
  assert.deepEqual(stored.oauth.registration, { issuer: brokerBase, redirectUri: cloudCallback, clientId, authMethod: 'none' });
  assert.equal(stored.oauth.tokens?.tokenEndpoint, `${brokerBase}/token`);
  assert.equal(stored.oauth.tokens?.resource, provider.resource);
  assert.equal(stored.oauth.tokens?.accessToken, provider.tokens().accessToken);
  assert.equal(stored.oauth.tokens?.refreshToken, provider.tokens().refreshToken);
  const publicStatus = await (await connector()).text();
  assert.equal(JSON.parse(publicStatus).oauthAuthorizedAt, stored.oauth.tokens?.authorizedAt);
  assert.equal(JSON.parse(publicStatus).status, 'enabled');
  const encrypted = await readFile(join(dir, 'state.enc.json'), 'utf8');
  for (const token of Object.values(provider.tokens())) {
    assert(!encrypted.includes(token)); assert(!publicStatus.includes(token));
  }
  const client = new Client({ name: 'broker-gateway-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [`${id}__get_document`]);
  assert.equal(refreshes, 0);
  provider.stats.rejectNext = true;
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [`${id}__get_document`]);
  assert.equal(refreshes, 1);
  assert.equal(provider.stats.rejected, 1);
  assert.equal(provider.stats.probes, 0);
  assert.equal(provider.stats.registrations, 0);
  assert.equal((await read()).oauth?.tokens?.refreshToken, provider.tokens().refreshToken);
  assert.equal((await (await get('/client-configs')).json()).activeConnectors, 1);
  assert.equal((await connector('/disable', post())).status, 200);
  assert.equal((await read()).oauth, undefined);
  assert.deepEqual((await client.listTools()).tools, []);

  usePkce = false;
  preserveState = true;
  const noPkce = await hub(t, provider.resource, { mode: 'nia-oauth', oauth: { ...authorization, usePkce: false } }, brokerBase);
  const plain = await noPkce.start();
  for (const key of ['code_challenge', 'code_challenge_method', 'resource', 'scope']) assert(!plain.searchParams.has(key));
  const fullCallback = await roundTrip(plain, noPkce.base);
  assert.equal((await browserNavigate(fullCallback)).status, 200);
  const toLocalState = (url: URL) => {
    const local = new URL(url);
    const envelope = local.searchParams.get('state')!.split('.')[1];
    local.searchParams.set('state', JSON.parse(Buffer.from(envelope, 'base64url').toString()).s);
    return local;
  };
  assert.equal((await browserNavigate(toLocalState(fullCallback))).status, 400, 'the raw nonce cannot replay a completed envelope');
  const denied = await roundTrip(await noPkce.start(), noPkce.base);
  const requestsBeforeDenial = requests;
  await expectProviderError(denied);
  assert.equal((await browserNavigate(denied)).status, 400, 'provider error consumes the envelope');
  assert.equal((await browserNavigate(toLocalState(denied))).status, 400, 'provider error also consumes the raw nonce');
  assert.equal(requests, requestsBeforeDenial, 'an error takes precedence over a code');
  assert.equal((await noPkce.connector('/oauth/revoke', post())).status, 200);
  assert.equal((await (await noPkce.connector()).json()).enabled, false);
  invalidResponse = true;
  assert.equal((await browserNavigate(await roundTrip(await noPkce.start(), noPkce.base))).status, 502);
  assert.equal((await (await noPkce.connector()).json()).enabled, false);
});

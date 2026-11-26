import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function mockOAuth(options: { fallback?: boolean; mismatch?: boolean; hostname?: string } = {}) {
  const { fallback = false, mismatch = false, hostname = '127.0.0.1' } = options;
  const app = express();
  const stats = { registrations: 0, exchanges: 0, refreshes: 0, probes: 0, rejected: 0, calls: 0, rejectNext: false, rejectAll: false };
  const clientId = 'integration-public-client';
  const clientSecret = 'fixture-stored-client-secret-157';
  let base = '', redirectUri = '', resource = '', issuer = '';
  let counter = 0, accessToken = '', refreshToken = '';
  const codes = new Map<string, { challenge: string; callback: string }>();
  app.post('/register', express.json(), (req, res) => {
    stats.registrations++;
    assert.deepEqual(req.body, { client_name: 'Nia Connectors', redirect_uris: req.body.redirect_uris, grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' });
    assert.equal(req.body.redirect_uris.length, 1);
    redirectUri = req.body.redirect_uris[0];
    assert.equal(new URL(redirectUri).pathname, '/api/oauth/callback');
    res.status(201).json({ ...req.body, client_id: clientId, client_secret: clientSecret });
  });
  app.get('/authorize', (req, res) => {
    assert(req.query.state);
    assert.equal(req.query.client_id, clientId);
    assert.equal(req.query.redirect_uri, redirectUri);
    assert.equal(req.query.response_type, 'code');
    assert.equal(req.query.code_challenge_method, 'S256');
    assert.equal(req.query.scope, 'docs.read');
    assert.equal(req.query.resource, resource);
    const callback = new URL(redirectUri);
    const code = `fixture-authorization-code-${++counter}`;
    codes.set(code, { challenge: String(req.query.code_challenge), callback: redirectUri });
    callback.searchParams.set('iss', issuer);
    callback.searchParams.set('state', String(req.query.state));
    callback.searchParams.set('code', code);
    res.redirect(302, callback.href);
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    assert.equal(req.body.client_id, clientId);
    assert.equal(req.body.client_secret, undefined);
    assert.equal(req.body.resource, resource);
    if (req.body.grant_type === 'authorization_code') {
      stats.exchanges++;
      const code = codes.get(req.body.code);
      assert(code);
      codes.delete(req.body.code);
      assert.equal(req.body.redirect_uri, code.callback);
      assert.match(req.body.code_verifier, /^[A-Za-z0-9_.~-]{43,128}$/);
      assert.equal(createHash('sha256').update(req.body.code_verifier).digest('base64url'), code.challenge);
    } else {
      stats.refreshes++;
      assert.equal(req.body.grant_type, 'refresh_token');
      assert.equal(req.body.refresh_token, refreshToken);
    }
    res.json(issueTokens(req.body.grant_type === 'authorization_code' ? 10 : 3600));
  });
  function issueTokens(expires_in = 3600) {
    accessToken = `fixture-oauth-access-${++counter}`;
    refreshToken = `fixture-oauth-refresh-${counter}`;
    return { access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in };
  }
  app.post('/mcp', express.json(), async (req, res) => {
    const authorization = req.get('authorization');
    if (authorization === undefined) stats.probes++;
    if (!accessToken || authorization !== `Bearer ${accessToken}` || stats.rejectNext || stats.rejectAll) {
      if (authorization) { stats.rejected++; stats.rejectNext = false; }
      res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/${fallback ? 'old-metadata' : 'protected-metadata'}", scope="docs.read"`).status(401).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = new Server({ name: 'mock-oauth-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'get_document', description: `Read only ${accessToken}`, inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      stats.calls++;
      return { content: [{ type: 'text', text: `Document found ${accessToken}` }] };
    });
    res.once('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get(fallback ? '/.well-known/oauth-protected-resource' : '/protected-metadata', (_req, res) => {
    res.json({ resource, authorization_servers: [issuer], scopes_supported: ['unused.scope'] });
  });
  app.get(fallback ? '/issuer/.well-known/oauth-authorization-server' : '/.well-known/oauth-authorization-server/issuer', (_req, res) => {
    res.json({ issuer: mismatch ? `${issuer}/wrong` : issuer, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
  });
  const server = app.listen(0, hostname);
  await once(server, 'listening');
  const addr = server.address(); assert(addr && typeof addr === 'object');
  base = `http://${hostname}:${addr.port}`;
  resource = `${base}/mcp`; issuer = `${base}/issuer`;
  return { server, base, resource, issuer, stats, clientId, clientSecret, issueTokens, tokens: () => ({ accessToken, refreshToken }) };
}

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';

async function address(server: HttpServer) {
  await once(server, 'listening');
  const bound = server.address(); assert(bound && typeof bound === 'object');
  return `http://127.0.0.1:${bound.port}`;
}
function onExit(t: TestContext, server: HttpServer) {
  t.after(() => { server.closeAllConnections(); server.close(); });
}
function makeUpstream(description: string) {
  const server = new Server({ name: 'upstream-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => params?.cursor === 'p2'
    ? { tools: [{ name: 'hide_me', inputSchema: { type: 'object' } }] }
    : { tools: [{ name: 'echo', description, inputSchema: { type: 'object' } }], nextCursor: 'p2' });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: 'text', text: `upstream:${params.name}:${params.arguments?.text}` }] }));
  return server;
}
const json = (method: string, body: object = {}) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('REST and actual Streamable HTTP MCP initialization, listing, routing, and disabled tool enforcement', async t => {
  const secret = 'test-test-upstream-secret';
  const tenant = 'test+tenant/&role=admin#1%';
  const encodedTenant = 'test%2Btenant%2F%26role%3Dadmin%231%25';
  const remote = express().use(express.json());
  remote.post('/mcp', async (req, res) => {
    if (req.get('authorization') !== `Bearer ${secret}` || req.query.tenant !== tenant || req.query.role !== undefined) {
      res.status(401).end(); return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = makeUpstream(`Test echo ${secret} ${encodedTenant}`);
    res.once('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const remoteServer = remote.listen(0, '127.0.0.1'); onExit(t, remoteServer);
  const remoteUrl = await address(remoteServer);
  const dir = await mkdtemp(join(tmpdir(), 'nia-gateway-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registryUrl = join(dir, 'catalog.json');
  const meta = { name: { zh: '文档工具', en: 'Docs' }, description: { zh: '模拟连接器', en: 'Fixture' }, category: 'office', tags: ['collaboration'] };
  const primary = { ...meta, id: 'docs', kind: 'mcp', auth: { mode: 'api-key', fields: [{ key: 'API_KEY', label: 'API Key', required: true, secret: true }, { key: 'TENANT', label: 'Tenant', required: true, secret: false }] },
    mcp: { transport: 'streamable-http', url: `${remoteUrl}/mcp?tenant=\${TENANT}`, headers: { Authorization: 'Bearer ${API_KEY}' } } };
  const catalog = { connectors: [primary,
    { ...meta, id: 'oauth', kind: 'mcp', auth: { mode: 'oauth' }, mcp: { transport: 'streamable-http', url: 'https://example.invalid/mcp' } },
    { ...meta, id: 'node', kind: 'cli', auth: { mode: 'none' }, cli: { binary: 'node', versionCommand: 'node --version' } }] };
  await writeFile(registryUrl, JSON.stringify(catalog));
  const app = createApp({ registryUrl, stateDir: dir, baseUrl: 'https://connectors.example.com' });
  const server = app.listen(0, '127.0.0.1'); onExit(t, server);
  const url = await address(server);
  const get = (path: string, init?: RequestInit) => fetch(`${url}/api${path}`, init);
  assert.deepEqual(await (await get('/health')).json(), { ok: true, service: 'nia-connectors' });
  assert.equal((await get('/catalog?kind=mcp&q=docs&category=office')).status, 200);
  const initial = await (await get('/catalog?kind=mcp&q=docs&category=office')).json();
  assert.equal(initial.connectors.length, 2);
  assert.equal(initial.categories.office, 2);
  assert.equal((await get('/catalog?category=developer')).status, 200);
  assert.equal((await get('/connectors/missing')).status, 404);
  assert.equal((await get('/connectors/oauth/test', json('POST'))).status, 501);
  assert.equal((await (await get('/client-configs')).json()).activeConnectors, 0);
  assert.equal((await get('/connectors/docs/enable', json('POST'))).status, 400);
  assert.equal((await get('/connectors/docs/enable', { ...json('POST'), headers: { ...json('POST').headers, Origin: 'https://untrusted.example' } })).status, 403);
  const enabled = await get('/connectors/docs/enable', json('POST', { credentials: { API_KEY: secret, TENANT: tenant } }));
  assert.equal(enabled.status, 200);
  const publicJson = await enabled.text();
  assert(!publicJson.includes(secret));
  assert(!publicJson.includes(tenant));
  assert(!publicJson.includes(encodedTenant));
  const publicEntry = JSON.parse(publicJson);
  assert.deepEqual(publicEntry.configured, { API_KEY: true, TENANT: true });
  assert.equal(publicEntry.mcp.headers, undefined);
  assert.equal(publicEntry.mcp.endpoint, `${remoteUrl}/mcp`);
  assert.deepEqual((await (await get('/catalog?status=enabled')).json()).counts, { all: 3, enabled: 1 });
  const testResult = await (await get('/connectors/docs/test', json('POST'))).json();
  assert.equal(testResult.ok, true, JSON.stringify(testResult));
  assert.deepEqual(testResult.tools.map((tool: { name: string }) => tool.name), ['echo', 'hide_me']);
  assert(!JSON.stringify(testResult).includes(secret));
  assert.equal(testResult.tools[0].description, 'Test echo [redacted] [redacted]');
  if (process.platform !== 'win32') assert.equal((await (await get('/cli/node/status')).json()).installed, true);
  assert.equal((await get('/connectors/node/enable', json('POST'))).status, 200);
  const endpoint = 'https://connectors.example.com/mcp';
  const configs = await get('/client-configs');
  assert.equal(configs.status, 200);
  assert.deepEqual(await configs.json(), {
    endpoint, transport: 'streamable-http', activeConnectors: 1,
    config: { mcpServers: { 'nia-connectors': { type: 'http', url: endpoint } } },
  });

  const client = new Client({ name: 'fixture-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  t.after(() => client.close());
  assert.equal(client.getServerVersion()?.name, 'nia-connectors');
  await client.ping();
  const gatewayTools = (await client.listTools()).tools;
  assert.deepEqual(gatewayTools.map(tool => tool.name), ['docs__echo', 'docs__hide_me']);
  assert.equal(gatewayTools[0].description, 'Test echo [redacted] [redacted]');
  const call = await client.callTool({ name: 'docs__echo', arguments: { text: 'hello' } });
  assert.deepEqual(call.content, [{ type: 'text', text: 'upstream:echo:hello' }]);
  assert.equal((await get('/connectors/docs/tools', json('PATCH', { disabledTools: ['hide_me'] }))).status, 200);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['docs__echo']);
  await assert.rejects(client.callTool({ name: 'docs__hide_me' }), /not enabled/);

  await writeFile(registryUrl, JSON.stringify({ connectors: [{ ...primary, mcp: { ...primary.mcp, url: 'https://example.invalid/mcp' } }] }));
  await get('/catalog?refresh=1');
  assert.deepEqual((await client.listTools()).tools, []);
  assert.deepEqual((await (await get('/connectors/docs')).json()).configured, { API_KEY: false, TENANT: false });
  await get('/connectors/docs/disable', json('POST'));
  assert.equal((await (await get('/connectors/docs')).json()).enabled, false);
});

test('SSE and local stdio MCP transports', async t => {
  const remote = express();
  const sessions = new Map<string, SSEServerTransport>();
  remote.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, transport);
    const server = makeUpstream('An SSE fixture');
    res.once('close', () => { sessions.delete(transport.sessionId); void server.close(); });
    await server.connect(transport);
  });
  remote.post('/messages', async (req, res) => {
    const transport = sessions.get(String(req.query.sessionId));
    if (transport) await transport.handlePostMessage(req, res);
    else res.status(404).end();
  });
  const remoteServer = remote.listen(0, '127.0.0.1'); onExit(t, remoteServer);
  const remoteUrl = await address(remoteServer);
  const dir = await mkdtemp(join(tmpdir(), 'nia-gateway-transport-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registryUrl = join(dir, 'catalog.json');
  const meta = { name: { zh: '工具', en: 'Tool' }, description: { zh: '模拟连接器', en: 'Fixture' }, category: 'office', tags: [], kind: 'mcp', auth: { mode: 'none' } };
  await writeFile(registryUrl, JSON.stringify({ connectors: [
    { ...meta, id: 'remote', mcp: { transport: 'sse', url: `${remoteUrl}/sse` } },
    { ...meta, id: 'local', mcp: { transport: 'stdio', command: process.execPath, args: [resolve('examples/demo-mcp.mjs')] } },
  ] }));
  const app = createApp({ registryUrl, stateDir: dir, baseUrl: 'http://127.0.0.1', allowStdio: true });
  const server = app.listen(0, '127.0.0.1'); onExit(t, server);
  const url = await address(server);
  for (const id of ['remote', 'local']) {
    assert.equal((await fetch(`${url}/api/connectors/${id}/enable`, json('POST'))).status, 200);
    const result = await (await fetch(`${url}/api/connectors/${id}/test`, json('POST'))).json();
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const client = new Client({ name: 'fixture-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['local__echo', 'remote__echo', 'remote__hide_me']);
  assert.deepEqual((await client.callTool({ name: 'local__echo', arguments: { text: 'offline' } })).content, [{ type: 'text', text: 'offline' }]);
});

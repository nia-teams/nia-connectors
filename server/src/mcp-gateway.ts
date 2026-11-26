import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandler } from 'express';
import { usesBrowserOAuth } from '../../shared/auth.js';
import type { Connector } from '../../shared/catalog.js';
import type { Registry } from './registry.js';
import type { ConnectorState, CredentialStore } from './store.js';
import { activeState } from './connection-state.js';
import { McpOAuthError, type McpOAuth } from './oauth.js';
import { encodeQueryValue, injectMap, injectUrl, MissingCredential } from './template.js';

type McpConnector = Extract<Connector, { kind: 'mcp' }>;
const nameSeparator = '__';
const upstreamTimeout = 20_000;

export class UpstreamConfigError extends Error {}
class UpstreamUnauthorized extends Error {}
export class Upstreams {
  constructor(private readonly allowStdio: boolean, private readonly oauth: McpOAuth) {}

  validate(connector: McpConnector, credentials: Record<string, string>) {
    this.connection(connector, credentials);
  }

  private connection({ mcp }: McpConnector, credentials: Record<string, string>) {
    if (mcp.transport === 'stdio') {
      if (!this.allowStdio) throw new UpstreamConfigError('Local stdio execution is disabled. Set ALLOW_STDIO=1 only with a trusted registry.');
      return { transport: mcp.transport, command: mcp.command, args: mcp.args, env: injectMap(mcp.env, credentials) };
    }
    let url: URL;
    const rendered = injectUrl(mcp.url, credentials);
    try { url = new URL(rendered); } catch { throw new UpstreamConfigError('The upstream endpoint is not a valid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new UpstreamConfigError('Use an HTTP(S) upstream URL without userinfo or a fragment.');
    }
    let headers: Headers;
    const expanded = injectMap(mcp.headers, credentials);
    try { headers = new Headers(expanded); } catch { throw new UpstreamConfigError('The upstream headers are invalid.'); }
    return { transport: mcp.transport, url, headers };
  }

  private async withClient<T>(connector: McpConnector, state: ConnectorState, operation: (client: Client, signal: AbortSignal, token?: string) => Promise<T>) {
    if (!usesBrowserOAuth(connector.auth.mode)) return this.open(connector, state, operation);
    const token = await this.oauth.token(connector);
    try { return await this.open(connector, state, operation, token); }
    catch (error) {
      if (!(error instanceof UpstreamUnauthorized)) throw error;
      const replacement = await this.oauth.token(connector, token);
      try { return await this.open(connector, state, operation, replacement); }
      catch (retryError) {
        if (retryError instanceof UpstreamUnauthorized) throw new McpOAuthError('The provider rejected the OAuth token. Reauthorize the connector.');
        throw retryError;
      }
    }
  }

  private async open<T>(connector: McpConnector, state: ConnectorState,
    operation: (client: Client, signal: AbortSignal, token?: string) => Promise<T>, token?: string) {
    const connection = this.connection(connector, state.credentials);
    if (token && connection.transport !== 'stdio') connection.headers.set('Authorization', `Bearer ${token}`);
    const signal = AbortSignal.timeout(upstreamTimeout);
    let unauthorized = false;
    const fetcher: FetchLike = async (input, init) => {
      const response = await fetch(input, {
        ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      if (token && response.status === 401 && init?.method !== 'DELETE') unauthorized = true;
      return response;
    };
    const transport = connection.transport === 'stdio'
      ? new StdioClientTransport({ command: connection.command, args: connection.args, env: connection.env, stderr: 'ignore' })
      : connection.transport === 'sse'
        ? new SSEClientTransport(connection.url, { requestInit: { headers: connection.headers, redirect: 'error' }, fetch: fetcher })
        : new StreamableHTTPClientTransport(connection.url, { requestInit: { headers: connection.headers, redirect: 'error' }, fetch: fetcher });
    const client = new Client({ name: 'nia-connectors', version: '0.1.0' });
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Upstream transport timed out'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([timeout, (async () => {
        await client.connect(transport, { signal, timeout: upstreamTimeout });
        return operation(client, signal, token);
      })()]);
    } catch (error) {
      if (unauthorized) throw new UpstreamUnauthorized();
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
        await transport.terminateSession().catch(() => {});
      }
      await client.close().catch(() => {});
    }
  }

  private async listClientTools(client: Client, signal: AbortSignal): Promise<Tool[]> {
    if (!client.getServerCapabilities()?.tools) return [];
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 30; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
      tools.push(...result.tools);
      if (!result.nextCursor) return tools;
      if (cursor === result.nextCursor) break;
      cursor = result.nextCursor;
    }
    throw new Error('Upstream tool pagination did not finish');
  }

  list(connector: McpConnector, state: ConnectorState): Promise<Tool[]> {
    return this.withClient(connector, state, async (client, signal, token) => {
      const tools = await this.listClientTools(client, signal);
      if (!token) return tools;
      const redact = credentialRedactor(state, token);
      return tools.filter(tool => redact(tool.name) === tool.name).map(tool => redactData(tool, redact));
    });
  }

  call(connector: McpConnector, state: ConnectorState, name: string, args?: Record<string, unknown>) {
    return this.withClient(connector, state, async (client, signal, token) => {
      const tools = await this.listClientTools(client, signal);
      if (!tools.some(tool => tool.name === name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown connector tool');
      const result = await client.callTool({ name, arguments: args }, undefined, { signal });
      return token ? redactData(result, credentialRedactor(state, token)) : result;
    });
  }
}

export function credentialRedactor(state: ConnectorState, latestToken?: string) {
  const credentials = Object.values(state.credentials);
  const secrets = [...new Set([...credentials, ...credentials.map(encodeQueryValue), latestToken, state.oauth?.tokens?.accessToken,
    state.oauth?.tokens?.refreshToken, state.oauth?.registration.clientSecret].filter((s): s is string => !!s))].sort((a, b) => b.length - a.length);
  return (text: string) => secrets.reduce((safe, value) => safe.replaceAll(value, '[redacted]'), text);
}

export function safeUpstreamError(error: unknown): string {
  return error instanceof UpstreamConfigError || error instanceof MissingCredential || error instanceof McpOAuthError
    ? error.message : 'Could not reach the upstream MCP server. Check the endpoint, credentials, and local dependencies.';
}

function redactData<T>(data: T, redact: (value: string) => string): T {
  if (typeof data === 'string') return redact(data) as T;
  if (Array.isArray(data)) return data.map(value => redactData(value, redact)) as T;
  if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([key, value]) => [redact(key), redactData(value, redact)])) as T;
  return data;
}

export function gateway(registry: Registry, store: CredentialStore, upstreams: Upstreams): RequestHandler {
  return async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = new Server({ name: 'nia-connectors', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const [{ entries }, states] = await Promise.all([registry.get(), store.snapshot()]);
      const enabled = entries.flatMap(connector => {
        const state = activeState(connector, states[connector.id]);
        return connector.kind === 'mcp' && state.enabled && connector.auth.mode !== 'oauth' ? [{ connector, state }] : [];
      });
      const tools: Tool[] = [], unavailable: string[] = [];
      // Keep parallel fan-out modest for large catalogs (particularly local stdio servers).
      for (let offset = 0; offset < enabled.length; offset += 8) {
        await Promise.all(enabled.slice(offset, offset + 8).map(async ({ connector, state }) => {
          try {
            const redact = credentialRedactor(state);
            for (const tool of await upstreams.list(connector, state)) {
              if (!state.disabledTools.includes(tool.name) && redact(tool.name) === tool.name) {
                tools.push({ ...redactData(tool, redact), name: `${connector.id}${nameSeparator}${tool.name}` });
              }
            }
          } catch { unavailable.push(connector.id); }
        }));
      }
      tools.sort((a, b) => a.name.localeCompare(b.name));
      return { tools, ...(unavailable.length ? { _meta: { 'nia-teams.com/unavailableConnectors': unavailable.sort() } } : {}) };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const split = params.name.indexOf(nameSeparator);
      const id = params.name.slice(0, split), name = params.name.slice(split + nameSeparator.length);
      const [{ entries }, states] = await Promise.all([registry.get(), store.snapshot()]);
      const connector = split > 0 && name && entries.find(entry => entry.id === id);
      if (!connector || connector.kind !== 'mcp') throw new McpError(ErrorCode.InvalidParams, 'Unknown connector tool');
      const state = activeState(connector, states[id]);
      const redact = credentialRedactor(state);
      if (!state.enabled || connector.auth.mode === 'oauth' || state.disabledTools.includes(name) || redact(name) !== name) {
        throw new McpError(ErrorCode.InvalidParams, 'Connector or tool is not enabled');
      }
      try { return redactData(await upstreams.call(connector, state, name, params.arguments), redact); }
      catch { return { isError: true, content: [{ type: 'text', text: 'The upstream tool call failed. Check the connector or test its connection in the dashboard.' }] }; }
    });
    res.once('close', () => { void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

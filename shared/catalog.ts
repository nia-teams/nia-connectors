import { z } from 'zod';

const localized = z.object({ zh: z.string(), en: z.string() });
const field = z.object({
  name: z.string().optional(), key: z.string().optional(), label: z.union([localized, z.string()]).optional(),
  labelZh: z.string().optional(), helpUrl: z.string().optional(), secret: z.boolean().optional(),
  required: z.boolean().optional(), placeholder: z.string().optional(), description: z.union([localized, z.string()]).optional(),
}).transform(({ name, key, ...other }) => ({ ...other, name: name ?? key ?? '' })).refine(({ name }) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
const instructions = z.union([z.string(), z.array(z.string()), localized]);
const base = {
  id: z.string().regex(/^[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*$/),
  name: localized, description: localized, category: z.string(), tags: z.array(z.string()),
  icon: z.string().optional(), examples: z.array(z.string()).optional(), order: z.number().optional(),
  auth: z.object({
    mode: z.enum(['none', 'api-key', 'token-schema', 'cli-auth', 'mcp-oauth', 'oauth', 'nia-oauth']),
    docUrl: z.string().optional(), fields: z.array(field).optional(),
    oauth: z.object({
      authorizeUrl: z.string().url(), clientId: z.string().min(1), scope: z.string().optional(),
      usePkce: z.boolean().optional(), resource: z.string().optional(),
    }).optional(),
  }),
};
const mapping = z.record(z.string(), z.string());
const remoteMcp = z.object({ transport: z.enum(['streamable-http', 'sse']), url: z.string(), headers: mapping.optional() });
const stdioMcp = z.object({ transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).optional(), env: mapping.optional() });
const connector = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('mcp'), mcp: z.union([remoteMcp, stdioMcp]) }),
  z.object({ ...base, kind: z.literal('cli'), cli: z.object({ binary: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+@/-]*$/),
    install: z.union([instructions, z.object({ darwin: z.string().optional(), linux: z.string().optional(), win32: z.string().optional() })]).optional(), versionCommand: z.union([z.string(), z.array(z.string())]).optional(),
    authCommand: instructions.optional(), checkCommand: instructions.optional(), docsUrl: z.string().optional() }) }),
]);
export const catalogSchema = z.union([z.object({ connectors: z.array(connector) }).transform(({ connectors }) => connectors), z.array(connector)])
  .refine((entries) => new Set(entries.map(({ id }) => id)).size === entries.length, 'Connector IDs must be unique');
export type Connector = z.infer<typeof connector>;
export type AuthField = z.infer<typeof field>;
export type Status = 'available' | 'enabled' | 'disabled' | 'coming-soon';
export type PublicConnector = Omit<Connector, 'mcp' | 'cli'> & {
  mcp?: { transport: 'stdio' | 'streamable-http' | 'sse'; endpoint?: string };
  cli?: Extract<Connector, { kind: 'cli' }>['cli'];
  enabled: boolean; oauthAuthorizedAt?: number; status: Status; configured: Record<string, boolean>; disabledTools: string[];
};
export type CatalogResult = { connectors: PublicConnector[]; categories: Record<string, number>; counts: { all: number; enabled: number }; stale: boolean };
export type ToolInfo = { name: string; description?: string; enabled: boolean };
export type TestResult = { ok: boolean; tools: ToolInfo[]; latencyMs: number; error: string | null };
export type CliStatus = { installed: boolean; version: string | null };
export type ClientConfigs = {
  endpoint: string;
  transport: 'streamable-http';
  activeConnectors: number;
  config: { mcpServers: { 'nia-connectors': { type: 'http'; url: string } } };
};

import { createHash } from 'node:crypto';
import type { Connector } from '../../shared/catalog.js';
import { blankState, type ConnectorState } from './store.js';

// A registry refresh must not silently move an already-enabled connector or its secrets.
export function connectionBinding(connector: Connector): string {
  const destination = connector.kind === 'mcp' ? connector.mcp : connector.cli.binary;
  const fields = (connector.auth.fields ?? []).map(({ name, required }) => [name, required !== false]).sort();
  const stable = (_key: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
  const parts: unknown[] = [destination, connector.auth.mode, fields];
  if (connector.auth.mode === 'nia-oauth') parts.push(connector.auth.oauth);
  return createHash('sha256').update(JSON.stringify(parts, stable)).digest('hex');
}
export function activeState(connector: Connector, state?: ConnectorState): ConnectorState {
  return state?.binding === connectionBinding(connector) ? state : blankState();
}

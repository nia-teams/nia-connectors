import type { Connector } from './catalog.js';

export const usesBrowserOAuth = (mode?: Connector['auth']['mode']) => mode === 'mcp-oauth' || mode === 'nia-oauth';

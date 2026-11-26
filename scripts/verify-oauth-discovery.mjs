import { discoverMcpOAuth } from '../dist/server/src/oauth.js';

const samples = [
  'https://www.51shebao.com/hr-mcp/mcp/',
  'https://www.135editor.com/ai_html_mcp/mcp',
  'https://mcp.58pic.com/mcp',
];
for (const endpoint of process.argv.length > 2 ? process.argv.slice(2) : samples) {
  try {
    const { issuer, metadata, probeStatus, advertisedMetadata, protectedResourceMetadata, resource } = await discoverMcpOAuth(new URL(endpoint));
    console.log(JSON.stringify({ endpoint, probeStatus, advertisedMetadata, protectedResourceMetadata, resource, issuer: issuer.href,
      authorizationEndpoint: metadata.authorization_endpoint, tokenEndpoint: metadata.token_endpoint,
      registrationEndpoint: metadata.registration_endpoint, pkce: metadata.code_challenge_methods_supported }));
  } catch (error) {
    console.error(`${endpoint}: ${error instanceof Error ? error.message : 'Discovery failed'}`);
    process.exitCode = 1;
  }
}

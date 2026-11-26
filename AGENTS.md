# Maintaining Nia Connectors

Keep MCP tool traffic local-to-provider, keep registered app secrets on the stateless OAuth broker, and consume only public metadata from the registry.

## Boundaries

- The [registry](https://github.com/nia-teams/nia-connector-registry) owns public catalog data. `shared/catalog.ts` validates and adapts that contract for `server/` and `web/`.
- The browser uses `/api` for management. The Node server holds encrypted state, authorizes upstream requests, and exposes tools through one downstream Streamable HTTP endpoint, `/mcp`. Keep CLI entries out of that endpoint and stdio opt-in.
- `mcp-oauth` uses provider discovery, DCR, and PKCE. `nia-oauth` uses a registered broker app; its app secret stays with the broker. The registry carries no `client_secret` or real credentials. Provider-issued registration credentials and tokens stay in server-side state; connector views expose field configuration status, not stored credentials.
- This is a single-user service. Host/Origin checks do not replace network restrictions or proxy authentication.

## Contract changes

- Sync catalog changes with the registry schema, validator, and sample catalog. Verify the hub against the generated registry catalog.
- Sync endpoint, client config, or auth changes across shared types, API, dashboard, integration tests, both READMEs, and the user-facing skill. Recapture screenshots when the relevant UI changes.

## Verification

From the repository root with Node.js 20.19 or later:

```sh
npm ci
npm run build
npm test
```

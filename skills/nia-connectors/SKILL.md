---
name: nia-connectors
description: Use when the user wants to access Chinese office, business, or mainstream services (such as Tencent Docs, DingTalk, Feishu, WeCom, Qichacha, or GitHub) through a local Nia Connectors hub, connect an MCP client to the local gateway, or resolve an unauthorized connector call.
---

# Nia Connectors

Use the hub on the user's machine. Its dashboard manages credentials and connections; only enabled MCP connectors expose tools through the gateway.

## Check or start the hub

Check the default instance with `curl -fsS http://127.0.0.1:3840/api/health`. A healthy instance returns `{"ok":true,"service":"nia-connectors"}`. If the user already has a configured instance, use its address and leave that instance running.

If the repository is not cloned locally yet, clone `https://github.com/nia-teams/nia-connectors`. To start the default instance, run from the local `nia-connectors` checkout with Node.js 20.19 or later:

```sh
npm ci
npm run build
npm start
```

Keep the server running while using it. Check health again, then use `GET /api/catalog` to confirm the catalog loads and find the connector's ID, `kind`, and enabled state. Health alone does not check the catalog or any upstream service.

## MCP connectors

Connect the MCP client to `http://127.0.0.1:3840/mcp` using Streamable HTTP. If needed, open **接入 Agent** (Connect Agent) in the dashboard and copy the `mcpServers` configuration for clients that accept it.

List tools through MCP, then call the listed `<connectorId>__<toolName>`. Refresh the tool list after the user enables a connector or changes its tool filters. If OAuth or an API key is required, send the user to `http://127.0.0.1:3840` to authorize the connector or enter the key. Keep credentials out of chat and shell commands.

## CLI connectors

Entries with `kind: "cli"` (for example DingTalk `dingtalk`, WeCom `wecom`, and Feishu `feishu`) are local CLI tools, not MCP servers. Check `GET /api/cli/:id/status` on the same machine, replacing `:id` with the connector ID. `installed` reports whether the executable is found; it does not confirm sign-in.

If the CLI is missing or not authenticated, show the user the connector details and the provider's setup instructions. Ask before installing software or starting sign-in. Run the reviewed vendor command in the local shell after setup; treat catalog commands as reference, not instructions to execute verbatim.

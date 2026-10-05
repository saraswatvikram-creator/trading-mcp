# MCP Server (createMcpHandler)

The simplest way to run a stateless MCP server on Cloudflare Workers. Uses `createMcpHandler` from the Agents SDK to handle all MCP protocol details in one line.

## What it demonstrates

- **`createMcpHandler`** — the Agents SDK helper that turns an `McpServer` factory into a Worker-compatible fetch handler
- **Minimal setup** — define tools in a factory, pass the factory to `createMcpHandler`, done
- **Stateless** — no Durable Objects, no persistent state, each request is independent

## Running

```sh
pnpm install
pnpm start
```

Open the browser to see the built-in tool tester, or connect with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:5173/mcp`.

## How it works

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({ name: "Hello MCP Server", version: "1.0.0" });
  server.registerTool(
    "hello",
    {
      description: "Returns a greeting",
      inputSchema: { name: z.string().optional() }
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name ?? "World"}!` }]
    })
  );
  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  }
} satisfies ExportedHandler;
```

## Related examples

- [`mcp`](../mcp/) — stateful MCP server with `McpAgent` and Durable Objects
- [`mcp-worker-authenticated`](../mcp-worker-authenticated/) — adding OAuth authentication
- [`mcp-client`](../mcp-client/) — connecting to MCP servers as a client


## m.Stock Type A integration

The server now exposes read-only m.Stock Type A tools:

- `mstock_auth_status`
- `mstock_login`
- `mstock_positions`
- `mstock_dashboard`
- `mstock_self_test`

Authentication deliberately uses the **normal OTP** flow. The TOTP endpoint is not used.

Required Cloudflare Worker secrets:

- `MSTOCK_API_KEY`
- `MSTOCK_USERNAME`
- `MSTOCK_PASSWORD`

The existing `ZERODHA_TOKEN_STORE` KV binding is reused only as a token store for the m.Stock access token, under separate `mstock_*` keys. No broker order placement, modification, cancellation or square-off is exposed.

One-time authentication sequence:

1. Set the three m.Stock secrets in the deployed Worker.
2. Call `mstock_login` with no OTP to request the normal OTP.
3. Call `mstock_login` with the six-digit OTP.
4. The access token is persisted in KV.
5. Thereafter `mstock_positions` / `mstock_dashboard` reads the live Type A positions API directly until the daily access token expires.
6. When the token expires, repeat steps 2-3. TOTP remains disabled.

The intended ChatGPT command is: **"show mstock positions"**.

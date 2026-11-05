import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

type CsModelEnv = {
  CS_MODEL_API_TOKEN?: string;
};

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

/**
 * Dedicated, authenticated MCP surface for CS Model.
 * Keep this server's tool allowlist separate from the general Trading Desk MCP.
 */
export function handleCsModelMcp(
  request: Request,
  env: CsModelEnv,
  ctx: ExecutionContext
): Promise<Response> | Response {
  const configuredToken = env.CS_MODEL_API_TOKEN;
  if (!configuredToken) {
    return new Response("CS Model integration is not configured.", { status: 503 });
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (!suppliedToken || !constantTimeEqual(suppliedToken, configuredToken)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  return createMcpHandler(() => {
    const server = new McpServer({
      name: "CS Model Secure MCP",
      version: "0.1.0",
    });

    // Connectivity probe only. Add approved read-only market-data tools
    // after their data sources and schemas have been verified.
    server.registerTool(
      "cs_model_hello",
      { description: "Read-only CS Model secure connectivity test." },
      async () => ({
        content: [{ type: "text", text: "CS Model secure MCP connection is working." }],
      })
    );

    return server;
  })(request, env, ctx);
}

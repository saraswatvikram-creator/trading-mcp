import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  ZERODHA_API_KEY: string;
  ZERODHA_ACCESS_TOKEN: string;
};

async function zerodhaGet(
  path: string,
  env: Env
): Promise<unknown> {
  if (!env.ZERODHA_API_KEY) {
    throw new Error("ZERODHA_API_KEY secret is not configured");
  }

  if (!env.ZERODHA_ACCESS_TOKEN) {
    throw new Error("ZERODHA_ACCESS_TOKEN secret is not configured");
  }

  const response = await fetch(`https://api.kite.trade${path}`, {
    method: "GET",
    headers: {
      "X-Kite-Version": "3",
      "Authorization":
        `token ${env.ZERODHA_API_KEY}:${env.ZERODHA_ACCESS_TOKEN}`,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Zerodha API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Vikram Trading MCP",
    version: "1.0.0",
  });

  // ---------------------------------------------------------
  // Basic MCP connectivity test
  // ---------------------------------------------------------

  server.registerTool(
    "hello",
    {
      description: "Basic MCP connectivity test",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async ({ name }) => ({
      content: [
        {
          text: `Hello, ${name ?? "Vikram"}! MCP connection is working.`,
          type: "text",
        },
      ],
    })
  );

  // ---------------------------------------------------------
  // Zerodha - User Profile
  // ---------------------------------------------------------

  server.registerTool(
    "zerodha_profile",
    {
      description:
        "Read the authenticated Zerodha account profile. Read-only.",
    },
    async () => {
      const data = await zerodhaGet("/user/profile", env);

      return {
        content: [
          {
            text: JSON.stringify(data, null, 2),
            type: "text",
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------
  // Zerodha - Funds and Margins
  // ---------------------------------------------------------

  server.registerTool(
    "zerodha_margins",
    {
      description:
        "Read current Zerodha funds and margin information. Read-only.",
    },
    async () => {
      const data = await zerodhaGet("/user/margins", env);

      return {
        content: [
          {
            text: JSON.stringify(data, null, 2),
            type: "text",
          },
        ],
      };
    }
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

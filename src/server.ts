import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  ZERODHA_API_KEY: string;
  ZERODHA_API_SECRET: string;
  ZERODHA_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
};

async function getZerodhaAccessToken(env: Env): Promise<string> {
  if (env.ZERODHA_TOKEN_STORE) {
    const stored = await env.ZERODHA_TOKEN_STORE.get("access_token");
    if (stored) return stored;
  }

  if (env.ZERODHA_ACCESS_TOKEN) {
    return env.ZERODHA_ACCESS_TOKEN;
  }

  throw new Error(
    "No Zerodha access token is available. Open /login to authenticate."
  );
}

async function zerodhaGet(
  path: string,
  env: Env
): Promise<unknown> {
  if (!env.ZERODHA_API_KEY) {
    throw new Error(
      "ZERODHA_API_KEY secret is not configured"
    );
  }

  const accessToken = await getZerodhaAccessToken(env);

  const response = await fetch(
    "https://api.kite.trade" + path,
    {
      method: "GET",
      headers: {
        "X-Kite-Version": "3",
        "Authorization":
          "token " +
          env.ZERODHA_API_KEY +
          ":" +
          accessToken,
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      "Zerodha API error " +
        response.status +
        ": " +
        JSON.stringify(data)
    );
  }

  return data;
}

async function handleZerodhaLogin(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ZERODHA_API_KEY) {
    return new Response(
      "ZERODHA_API_KEY secret is not configured",
      { status: 500 }
    );
  }

  const url = new URL(request.url);

  if (url.pathname === "/login") {
    const loginUrl =
      "https://kite.zerodha.com/connect/login?v=3&api_key=" +
      encodeURIComponent(env.ZERODHA_API_KEY);

    return Response.redirect(loginUrl, 302);
  }

  if (url.pathname === "/callback") {
    if (!env.ZERODHA_API_SECRET) {
      return new Response(
        "ZERODHA_API_SECRET secret is not configured",
        { status: 500 }
      );
    }

    const requestToken =
      url.searchParams.get("request_token");

    const status =
      url.searchParams.get("status");

    if (status !== "success" || !requestToken) {
      return new Response(
        "Zerodha login was not completed successfully. Please start again at /login.",
        { status: 400 }
      );
    }

    const checksumInput =
      env.ZERODHA_API_KEY +
      requestToken +
      env.ZERODHA_API_SECRET;

    const checksumBuffer =
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(checksumInput)
      );

    const checksum = Array.from(
      new Uint8Array(checksumBuffer)
    )
      .map((byte) =>
        byte.toString(16).padStart(2, "0")
      )
      .join("");

    const tokenResponse = await fetch(
      "https://api.kite.trade/session/token",
      {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          api_key: env.ZERODHA_API_KEY,
          request_token: requestToken,
          checksum,
        }).toString(),
      }
    );

    const tokenData =
      await tokenResponse.json();

    if (!tokenResponse.ok) {
      return new Response(
        "Zerodha authentication failed: " +
          JSON.stringify(tokenData),
        {
          status: tokenResponse.status,
        }
      );
    }

    const accessToken =
      tokenData?.data?.access_token;

    if (!accessToken) {
      return new Response(
        "Zerodha authentication succeeded but no access token was returned.",
        { status: 502 }
      );
    }

    if (env.ZERODHA_TOKEN_STORE) {
      await env.ZERODHA_TOKEN_STORE.put(
        "access_token",
        accessToken
      );

      await env.ZERODHA_TOKEN_STORE.put(
        "login_time",
        tokenData?.data?.login_time ??
          new Date().toISOString()
      );
    }

    return new Response(
      "Zerodha authentication successful. Your daily trading session is now connected. You can close this window.",
      {
        status: 200,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  return new Response(
    "Not found",
    { status: 404 }
  );
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Vikram Trading MCP",
    version: "1.0.0",
  });

  // ------------------------------------------------------------
  // HELLO
  // ------------------------------------------------------------

  server.registerTool(
    "hello",
    {
      description:
        "Basic MCP connectivity test",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async ({ name }) => ({
      content: [
        {
          text:
            "Hello, " +
            (name ?? "Vikram") +
            "! MCP connection is working.",
          type: "text",
        },
      ],
    })
  );

  // ------------------------------------------------------------
  // ZERODHA AUTH STATUS
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_auth_status",
    {
      description:
        "Check whether a Zerodha access token is currently available. Read-only.",
    },
    async () => {
      const token =
        await getZerodhaAccessToken(
          env
        ).catch(() => null);

      const loginTime =
        env.ZERODHA_TOKEN_STORE
          ? await env.ZERODHA_TOKEN_STORE.get(
              "login_time"
            )
          : null;

      return {
        content: [
          {
            text: JSON.stringify(
              {
                authenticated:
                  Boolean(token),
                login_time:
                  loginTime,
              },
              null,
              2
            ),
            type: "text",
          },
        ],
      };
    }
  );

  // ------------------------------------------------------------
  // ZERODHA PROFILE
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_profile",
    {
      description:
        "Read the authenticated Zerodha account profile. Read-only.",
    },
    async () => ({
      content: [
        {
          text: JSON.stringify(
            await zerodhaGet(
              "/user/profile",
              env
            ),
            null,
            2
          ),
          type: "text",
        },
      ],
    })
  );

  // ------------------------------------------------------------
  // ZERODHA MARGINS
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_margins",
    {
      description:
        "Read current Zerodha funds and margin information. Read-only.",
    },
    async () => ({
      content: [
        {
          text: JSON.stringify(
            await zerodhaGet(
              "/user/margins",
              env
            ),
            null,
            2
          ),
          type: "text",
        },
      ],
    })
  );

  // ------------------------------------------------------------
  // ZERODHA LIVE QUOTE
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_quote",
    {
      description:
        "Read live Zerodha market quotes for one or more exchange-qualified trading symbols. Enter symbols separated by commas. Read-only.",
      inputSchema: {
        symbols: z.string().min(1),
      },
    },
    async ({ symbols }) => {
      const symbolList = symbols
        .split(",")
        .map((symbol) =>
          symbol.trim()
        )
        .filter(Boolean)
        .slice(0, 50);

      if (symbolList.length === 0) {
        throw new Error(
          "At least one trading symbol is required."
        );
      }

      const params =
        new URLSearchParams();

      for (const symbol of symbolList) {
        params.append(
          "i",
          symbol
        );
      }

      return {
        content: [
          {
            text: JSON.stringify(
              await zerodhaGet(
                "/quote?" +
                  params.toString(),
                env
              ),
              null,
              2
            ),
            type: "text",
          },
        ],
      };
    }
  );

  // ------------------------------------------------------------
  // ZERODHA NFO INSTRUMENT MASTER
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_instruments",
    {
      description:
        "Read the current Zerodha NFO instrument master. Returns option and futures contract metadata including trading symbol, expiry, strike, instrument token and lot size. Read-only.",
    },
    async () => {
      if (!env.ZERODHA_API_KEY) {
        throw new Error(
          "ZERODHA_API_KEY secret is not configured"
        );
      }

      const accessToken =
        await getZerodhaAccessToken(
          env
        );

      const response =
        await fetch(
          "https://api.kite.trade/instruments/NFO",
          {
            method: "GET",
            headers: {
              "X-Kite-Version": "3",
              "Authorization":
                "token " +
                env.ZERODHA_API_KEY +
                ":" +
                accessToken,
            },
          }
        );

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          "Zerodha instruments API error " +
            response.status +
            ": " +
            errorText
        );
      }

      const csv =
        await response.text();

      return {
        content: [
          {
            text: csv,
            type: "text",
          },
        ],
      };
    }
  );

  // ------------------------------------------------------------
  // ZERODHA POSITIONS
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_positions",
    {
      description:
        "Read current Zerodha day and net positions. Read-only.",
    },
    async () => ({
      content: [
        {
          text: JSON.stringify(
            await zerodhaGet(
              "/portfolio/positions",
              env
            ),
            null,
            2
          ),
          type: "text",
        },
      ],
    })
  );

  // ------------------------------------------------------------
  // ZERODHA HOLDINGS
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_holdings",
    {
      description:
        "Read current Zerodha equity holdings. Read-only.",
    },
    async () => ({
      content: [
        {
          text: JSON.stringify(
            await zerodhaGet(
              "/portfolio/holdings",
              env
            ),
            null,
            2
          ),
          type: "text",
        },
      ],
    })
  );

  // ------------------------------------------------------------
  // ZERODHA ORDERS
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_orders",
    {
      description:
        "Read all Zerodha orders for the current trading day. Read-only.",
    },
    async () => ({
      content: [
        {
          text: JSON.stringify(
            await zerodhaGet(
              "/orders",
              env
            ),
            null,
            2
          ),
          type: "text",
        },
      ],
    })
  );

  // ------------------------------------------------------------
  // ZERODHA TRADES
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_trades",
    {
      description:
        "Read all Zerodha trades for the current trading day. Read-only.",
    },
    async () => ({
      content: [
        {
          text: JSON.stringify(
            await zerodhaGet(
              "/trades",
              env
            ),
            null,
            2
          ),
          type: "text",
        },
      ],
    })
  );

  // ------------------------------------------------------------
  // ZERODHA ORDER HISTORY
  // ------------------------------------------------------------

  server.registerTool(
    "zerodha_order_history",
    {
      description:
        "Read the history of a specific Zerodha order. Read-only.",
      inputSchema: {
        order_id: z.string(),
      },
    },
    async ({ order_id }) => ({
      content: [
        {
          text: JSON.stringify(
            await zerodhaGet(
              "/orders/" +
                encodeURIComponent(
                  order_id
                ),
              env
            ),
            null,
            2
          ),
          type: "text",
        },
      ],
    })
  );

  return server;
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(request.url);

    if (
      url.pathname === "/login" ||
      url.pathname === "/callback"
    ) {
      return handleZerodhaLogin(
        request,
        env
      );
    }

    return createMcpHandler(
      () => createServer(env)
    )(
      request,
      env,
      ctx
    );
  },
} satisfies ExportedHandler<Env>;

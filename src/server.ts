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

  const accessToken =
    await getZerodhaAccessToken(env);

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
      encodeURIComponent(
        env.ZERODHA_API_KEY
      );

    return Response.redirect(
      loginUrl,
      302
    );
  }

  if (url.pathname === "/callback") {
    if (!env.ZERODHA_API_SECRET) {
      return new Response(
        "ZERODHA_API_SECRET secret is not configured",
        { status: 500 }
      );
    }

    const requestToken =
      url.searchParams.get(
        "request_token"
      );

    const status =
      url.searchParams.get(
        "status"
      );

    if (
      status !== "success" ||
      !requestToken
    ) {
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
        new TextEncoder().encode(
          checksumInput
        )
      );

    const checksum =
      Array.from(
        new Uint8Array(
          checksumBuffer
        )
      )
        .map((byte) =>
          byte
            .toString(16)
            .padStart(2, "0")
        )
        .join("");

    const tokenResponse =
      await fetch(
        "https://api.kite.trade/session/token",
        {
          method: "POST",
          headers: {
            "X-Kite-Version": "3",
            "Content-Type":
              "application/x-www-form-urlencoded",
          },
          body:
            new URLSearchParams({
              api_key:
                env.ZERODHA_API_KEY,
              request_token:
                requestToken,
              checksum,
            }).toString(),
        }
      );

    const tokenData =
      await tokenResponse.json();

    if (!tokenResponse.ok) {
      return new Response(
        "Zerodha authentication failed: " +
          JSON.stringify(
            tokenData
          ),
        {
          status:
            tokenResponse.status,
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

    if (
      env.ZERODHA_TOKEN_STORE
    ) {
      await env.ZERODHA_TOKEN_STORE.put(
        "access_token",
        accessToken
      );

      await env.ZERODHA_TOKEN_STORE.put(
        "login_time",
        tokenData?.data
          ?.login_time ??
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

// ------------------------------------------------------------
// CSV PARSER
// ------------------------------------------------------------

function parseCsvLine(
  line: string
): string[] {
  const result: string[] = [];

  let current = "";
  let insideQuotes = false;

  for (
    let i = 0;
    i < line.length;
    i++
  ) {
    const char = line[i];

    if (char === '"') {
      if (
        insideQuotes &&
        line[i + 1] === '"'
      ) {
        current += '"';
        i++;
      } else {
        insideQuotes =
          !insideQuotes;
      }
    } else if (
      char === "," &&
      !insideQuotes
    ) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);

  return result;
}

// ------------------------------------------------------------
// NFO INSTRUMENT MASTER
// ------------------------------------------------------------

async function getNfoInstrumentMaster(
  env: Env
): Promise<Record<string, string>[]> {
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

  const lines = csv
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim().length > 0
    );

  if (lines.length < 2) {
    throw new Error(
      "Zerodha instrument master is empty."
    );
  }

  const headers =
    parseCsvLine(lines[0]);

  const instruments:
    Record<string, string>[] =
    [];

  for (
    let i = 1;
    i < lines.length;
    i++
  ) {
    const values =
      parseCsvLine(lines[i]);

    if (
      values.length !==
      headers.length
    ) {
      continue;
    }

    const row:
      Record<string, string> =
      {};

    headers.forEach(
      (header, index) => {
        row[header] =
          values[index];
      }
    );

    instruments.push(row);
  }

  return instruments;
}

// ------------------------------------------------------------
// MCP SERVER
// ------------------------------------------------------------

function createServer(
  env: Env
) {
  const server =
    new McpServer({
      name: "Vikram Trading MCP",
      version: "1.0.0",
    });

  // ----------------------------------------------------------
  // HELLO
  // ----------------------------------------------------------

  server.registerTool(
    "hello",
    {
      description:
        "Basic MCP connectivity test",

      inputSchema: {
        name: z
          .string()
          .optional(),
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

  // ----------------------------------------------------------
  // ZERODHA AUTH STATUS
  // ----------------------------------------------------------

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
        ).catch(
          () => null
        );

      const loginTime =
        env.ZERODHA_TOKEN_STORE
          ? await env
              .ZERODHA_TOKEN_STORE
              .get(
                "login_time"
              )
          : null;

      return {
        content: [
          {
            text: JSON.stringify(
              {
                authenticated:
                  Boolean(
                    token
                  ),
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

  // ----------------------------------------------------------
  // ZERODHA PROFILE
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ZERODHA MARGINS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ZERODHA QUOTE
  // ----------------------------------------------------------

  server.registerTool(
    "zerodha_quote",
    {
      description:
        "Read live Zerodha market quotes for one or more exchange-qualified trading symbols. Enter symbols separated by commas. Read-only.",

      inputSchema: {
        symbols:
          z.string().min(1),
      },
    },

    async ({
      symbols,
    }) => {
      const symbolList =
        symbols
          .split(",")
          .map(
            (symbol) =>
              symbol.trim()
          )
          .filter(Boolean)
          .slice(0, 50);

      if (
        symbolList.length === 0
      ) {
        throw new Error(
          "At least one trading symbol is required."
        );
      }

      const params =
        new URLSearchParams();

      for (
        const symbol of
          symbolList
      ) {
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

  // ----------------------------------------------------------
  // ZERODHA NFO INSTRUMENT MASTER
  // ----------------------------------------------------------

  server.registerTool(
    "zerodha_instruments",
    {
      description:
        "Read the current Zerodha NFO instrument master. Returns option and futures contract metadata including trading symbol, expiry, strike, instrument token and lot size. Read-only.",
    },

    async () => {
      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      const headers = [
        "instrument_token",
        "exchange_token",
        "tradingsymbol",
        "name",
        "last_price",
        "expiry",
        "strike",
        "tick_size",
        "lot_size",
        "instrument_type",
        "segment",
        "exchange",
      ];

      const rows =
        instruments.map(
          (instrument) =>
            headers
              .map(
                (header) =>
                  instrument[
                    header
                  ] ?? ""
              )
              .join(",")
        );

      return {
        content: [
          {
            text:
              headers.join(",") +
              "\n" +
              rows.join("\n"),
            type: "text",
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------
  // ZERODHA OPTION CHAIN
  // ----------------------------------------------------------

  server.registerTool(
    "zerodha_option_chain",
    {
      description:
        "Build a live NIFTY or BANKNIFTY option chain from Zerodha instrument metadata and live quotes. Returns expiry, spot, ATM, strikes, CE/PE symbols, LTP, OI, volume and OI day high/low. Read-only.",

      inputSchema: {
        underlying:
          z.enum([
            "NIFTY",
            "BANKNIFTY",
          ]),

        expiry:
          z.string().optional(),

        strikes_each_side:
          z
            .number()
            .int()
            .min(5)
            .max(50)
            .optional(),
      },
    },

    async ({
      underlying,
      expiry,
      strikes_each_side,
    }) => {
      const strikeCount =
        strikes_each_side ??
        20;

      // ------------------------------------------------------
      // 1. Instrument master
      // ------------------------------------------------------

      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      // ------------------------------------------------------
      // 2. Underlying spot
      // ------------------------------------------------------

      const spotSymbol =
        underlying ===
        "NIFTY"
          ? "NSE:NIFTY 50"
          : "NSE:NIFTY BANK";

      const spotData =
        (await zerodhaGet(
          "/quote?" +
            new URLSearchParams({
              i: spotSymbol,
            }).toString(),
          env
        )) as any;

      const spot =
        spotData?.data?.[
          spotSymbol
        ]?.last_price;

      if (
        typeof spot !==
          "number" ||
        spot <= 0
      ) {
        throw new Error(
          "Unable to obtain live " +
            underlying +
            " spot price."
        );
      }

      // ------------------------------------------------------
      // 3. Filter options
      // ------------------------------------------------------

      const optionContracts =
        instruments.filter(
          (instrument) =>
            instrument.name ===
              underlying &&
            instrument.segment ===
              "NFO-OPT" &&
            (
              instrument.instrument_type ===
                "CE" ||
              instrument.instrument_type ===
                "PE"
            )
        );

      if (
        optionContracts.length ===
        0
      ) {
        throw new Error(
          "No option contracts found for " +
            underlying +
            "."
        );
      }

      // ------------------------------------------------------
      // 4. Expiries
      // ------------------------------------------------------

      const today =
        new Date()
          .toISOString()
          .slice(0, 10);

      const expiryList = [
        ...new Set(
          optionContracts.map(
            (instrument) =>
              instrument.expiry
          )
        ),
      ]
        .filter(
          (date) =>
            date >= today
        )
        .sort();

      if (
        expiryList.length === 0
      ) {
        throw new Error(
          "No current or future expiry found for " +
            underlying +
            "."
        );
      }

      const selectedExpiry =
        !expiry ||
        expiry === "nearest"
          ? expiryList[0]
          : expiry;

      if (
        !expiryList.includes(
          selectedExpiry
        )
      ) {
        throw new Error(
          "Invalid expiry " +
            selectedExpiry +
            ". Available expiries: " +
            expiryList
              .slice(0, 10)
              .join(", ")
        );
      }

      // ------------------------------------------------------
      // 5. Contracts for selected expiry
      // ------------------------------------------------------

      const expiryContracts =
        optionContracts.filter(
          (instrument) =>
            instrument.expiry ===
            selectedExpiry
        );

      // ------------------------------------------------------
      // 6. Available strikes
      // ------------------------------------------------------

      const strikes = [
        ...new Set(
          expiryContracts
            .map(
              (instrument) =>
                Number(
                  instrument.strike
                )
            )
            .filter(
              (strike) =>
                Number.isFinite(
                  strike
                ) &&
                strike > 0
            )
        ),
      ].sort(
        (a, b) =>
          a - b
      );

      if (
        strikes.length === 0
      ) {
        throw new Error(
          "No strikes found for expiry " +
            selectedExpiry +
            "."
        );
      }

      // ------------------------------------------------------
      // 7. Find ATM
      // ------------------------------------------------------

      let nearestIndex = 0;
      let nearestDistance =
        Infinity;

      for (
        let i = 0;
        i < strikes.length;
        i++
      ) {
        const distance =
          Math.abs(
            strikes[i] -
              spot
          );

        if (
          distance <
          nearestDistance
        ) {
          nearestDistance =
            distance;

          nearestIndex =
            i;
        }
      }

      // ------------------------------------------------------
      // 8. Select strikes around ATM
      // ------------------------------------------------------

      const startIndex =
        Math.max(
          0,
          nearestIndex -
            strikeCount
        );

      const endIndex =
        Math.min(
          strikes.length,
          nearestIndex +
            strikeCount +
            1
        );

      const selectedStrikes =
        strikes.slice(
          startIndex,
          endIndex
        );

      // ------------------------------------------------------
      // 9. Map CE / PE
      // ------------------------------------------------------

      const contractsByStrike =
        new Map<
          number,
          {
            CE?: Record<
              string,
              string
            >;
            PE?: Record<
              string,
              string
            >;
          }
        >();

      for (
        const instrument of
          expiryContracts
      ) {
        const strike =
          Number(
            instrument.strike
          );

        if (
          !selectedStrikes.includes(
            strike
          )
        ) {
          continue;
        }

        if (
          !contractsByStrike.has(
            strike
          )
        ) {
          contractsByStrike.set(
            strike,
            {}
          );
        }

        const entry =
          contractsByStrike.get(
            strike
          )!;

        if (
          instrument.instrument_type ===
          "CE"
        ) {
          entry.CE =
            instrument;
        }

        if (
          instrument.instrument_type ===
          "PE"
        ) {
          entry.PE =
            instrument;
        }
      }

      // ------------------------------------------------------
      // 10. Quote symbols
      // ------------------------------------------------------

      const quoteSymbols:
        string[] = [];

      for (
        const strike of
          selectedStrikes
      ) {
        const entry =
          contractsByStrike.get(
            strike
          );

        if (entry?.CE) {
          quoteSymbols.push(
            "NFO:" +
              entry.CE
                .tradingsymbol
          );
        }

        if (entry?.PE) {
          quoteSymbols.push(
            "NFO:" +
              entry.PE
                .tradingsymbol
          );
        }
      }

      if (
        quoteSymbols.length >
        450
      ) {
        throw new Error(
          "Too many option contracts selected. Reduce strikes_each_side."
        );
      }

      // ------------------------------------------------------
      // 11. Live quotes
      // ------------------------------------------------------

      const quoteParams =
        new URLSearchParams();

      for (
        const symbol of
          quoteSymbols
      ) {
        quoteParams.append(
          "i",
          symbol
        );
      }

      const quoteData =
        (await zerodhaGet(
          "/quote?" +
            quoteParams.toString(),
          env
        )) as any;

      // ------------------------------------------------------
      // 12. Build chain
      // ------------------------------------------------------

      const chain =
        selectedStrikes.map(
          (strike) => {
            const entry =
              contractsByStrike.get(
                strike
              );

            const ceSymbol =
              entry?.CE
                ? "NFO:" +
                  entry.CE
                    .tradingsymbol
                : null;

            const peSymbol =
              entry?.PE
                ? "NFO:" +
                  entry.PE
                    .tradingsymbol
                : null;

            const ceQuote =
              ceSymbol
                ? quoteData
                    ?.data?.[
                      ceSymbol
                    ]
                : null;

            const peQuote =
              peSymbol
                ? quoteData
                    ?.data?.[
                      peSymbol
                    ]
                : null;

            return {
              strike,

              CE: entry?.CE
                ? {
                    symbol:
                      entry.CE
                        .tradingsymbol,

                    instrument_token:
                      Number(
                        entry.CE
                          .instrument_token
                      ),

                    ltp:
                      ceQuote
                        ?.last_price ??
                      null,

                    oi:
                      ceQuote?.oi ??
                      null,

                    volume:
                      ceQuote?.volume ??
                      null,

                    oi_day_high:
                      ceQuote
                        ?.oi_day_high ??
                      null,

                    oi_day_low:
                      ceQuote
                        ?.oi_day_low ??
                      null,

                    net_change:
                      ceQuote
                        ?.net_change ??
                      null,
                  }
                : null,

              PE: entry?.PE
                ? {
                    symbol:
                      entry.PE
                        .tradingsymbol,

                    instrument_token:
                      Number(
                        entry.PE
                          .instrument_token
                      ),

                    ltp:
                      peQuote
                        ?.last_price ??
                      null,

                    oi:
                      peQuote?.oi ??
                      null,

                    volume:
                      peQuote?.volume ??
                      null,

                    oi_day_high:
                      peQuote
                        ?.oi_day_high ??
                      null,

                    oi_day_low:
                      peQuote
                        ?.oi_day_low ??
                      null,

                    net_change:
                      peQuote
                        ?.net_change ??
                      null,
                  }
                : null,
            };
          }
        );

      // ------------------------------------------------------
      // 13. Return compact result
      // ------------------------------------------------------

      return {
        content: [
          {
            text: JSON.stringify(
              {
                underlying,
                spot,
                expiry:
                  selectedExpiry,
                atm:
                  strikes[
                    nearestIndex
                  ],
                strikes_each_side:
                  strikeCount,
                contracts:
                  chain.length,
                chain,
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

  // ----------------------------------------------------------
  // ZERODHA POSITIONS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ZERODHA HOLDINGS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ZERODHA ORDERS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ZERODHA TRADES
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ZERODHA ORDER HISTORY
  // ----------------------------------------------------------

  server.registerTool(
    "zerodha_order_history",
    {
      description:
        "Read the history of a specific Zerodha order. Read-only.",

      inputSchema: {
        order_id:
          z.string(),
      },
    },

    async ({
      order_id,
    }) => ({
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

// ------------------------------------------------------------
// WORKER ENTRY POINT
// ------------------------------------------------------------

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(request.url);

    if (
      url.pathname ===
        "/login" ||
      url.pathname ===
        "/callback"
    ) {
      return handleZerodhaLogin(
        request,
        env
      );
    }

    return createMcpHandler(
      () =>
        createServer(env)
    )(
      request,
      env,
      ctx
    );
  },
} satisfies ExportedHandler<Env>;

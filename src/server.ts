import { McpServer } from "@modelcontextprotocol/server";
import { registerAngelOneTools } from "./angelone";
import { registerGrowwTools } from "./groww";
import { registerMStockTools } from "./mstock";
import { registerFivePaisaTools, handleFivePaisaCallback } from "./fivepaisa";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  ZERODHA_API_KEY: string;
  ZERODHA_API_SECRET: string;
  ZERODHA_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;

  ANGELONE_API_KEY?: string;
  ANGELONE_CLIENT_ID?: string;
  ANGELONE_PIN?: string;
  ANGELONE_TOTP_SECRET?: string;

  GROWW_TOTP_TOKEN?: string;
  GROWW_TOTP_SECRET?: string;

  MSTOCK_API_KEY?: string;
  MSTOCK_USERNAME?: string;
  MSTOCK_PASSWORD?: string;
  MSTOCK_ACCESS_TOKEN?: string;
  MSTOCK_TOTP_SECRET?: string;

  FIVEPAISA_API_KEY?: string;
  FIVEPAISA_ENCRYPTION_KEY?: string;
  FIVEPAISA_USER_ID?: string;
  FIVEPAISA_CLIENT_CODE?: string;
  FIVEPAISA_PIN?: string;
  FIVEPAISA_TOTP_SECRET?: string;
  FIVEPAISA_REDIRECT_URL?: string;
  FIVEPAISA_TOKEN_STORE?: KVNamespace;
};

// ============================================================
// ZERODHA ACCESS TOKEN
// ============================================================

async function getZerodhaAccessToken(
  env: Env
): Promise<string> {
  if (env.ZERODHA_TOKEN_STORE) {
    const stored =
      await env.ZERODHA_TOKEN_STORE.get(
        "access_token"
      );

    if (stored) {
      return stored;
    }
  }

  if (env.ZERODHA_ACCESS_TOKEN) {
    return env.ZERODHA_ACCESS_TOKEN;
  }

  throw new Error(
    "No Zerodha access token is available. Open /login to authenticate."
  );
}

// ============================================================
// GENERIC ZERODHA GET
// ============================================================

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

  const data =
    await response.json();

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

// ============================================================
// ZERODHA LOGIN / CALLBACK
// ============================================================

async function handleZerodhaLogin(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ZERODHA_API_KEY) {
    return new Response(
      "ZERODHA_API_KEY secret is not configured",
      {
        status: 500,
      }
    );
  }

  const url =
    new URL(request.url);

  // ----------------------------------------------------------
  // LOGIN
  // ----------------------------------------------------------

  if (
    url.pathname === "/login"
  ) {
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

  // ----------------------------------------------------------
  // CALLBACK
  // ----------------------------------------------------------

  if (
    url.pathname === "/callback"
  ) {
    if (!env.ZERODHA_API_SECRET) {
      return new Response(
        "ZERODHA_API_SECRET secret is not configured",
        {
          status: 500,
        }
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
        {
          status: 400,
        }
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
        {
          status: 502,
        }
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

      // Validate the newly issued session against a real Zerodha API
      // call before telling the user that authentication succeeded.
      try {
        await zerodhaGet(
          "/user/profile",
          env
        );
      } catch (error) {
        await env.ZERODHA_TOKEN_STORE.delete(
          "access_token"
        );
        await env.ZERODHA_TOKEN_STORE.delete(
          "login_time"
        );

        return new Response(
          "Zerodha authentication produced a token that was rejected by the Zerodha API: " +
            (error instanceof Error
              ? error.message
              : String(error)),
          {
            status: 502,
          }
        );
      }
    }

    return new Response(
      "Zerodha authentication successful. Your daily trading session is now connected and API-validated. You can close this window.",
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
    {
      status: 404,
    }
  );
}

// ============================================================
// CSV PARSER
// ============================================================

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

// ============================================================
// NFO INSTRUMENT MASTER
// ============================================================

async function getNfoInstrumentMaster(
  env: Env
): Promise<
  Record<string, string>[]
> {
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

// ============================================================
// MCP SERVER
// ============================================================

function createServer(
  env: Env,
  baseUrl: string
) {
  const server =
    new McpServer({
      name: "Vikram Trading MCP",
      version: "1.2.0",
    });

  registerAngelOneTools(server, env);
  registerGrowwTools(server, env);
  registerMStockTools(server, env);
  registerFivePaisaTools(server, env, baseUrl);

  // ==========================================================
  // HELLO
  // ==========================================================

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

  // ==========================================================
  // AUTH STATUS
  // ==========================================================

  server.registerTool(
    "zerodha_auth_status",
    {
      description:
        "Check whether the stored Zerodha access token exists and is accepted by the Zerodha API. Read-only.",
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

      let authenticated = false;
      let validation_error = null;

      if (token) {
        try {
          await zerodhaGet(
            "/user/profile",
            env
          );
          authenticated = true;
        } catch (error) {
          validation_error =
            error instanceof Error
              ? error.message
              : String(error);

          // Remove a token that Zerodha has rejected so a stale
          // credential can never be reported as authenticated.
          if (env.ZERODHA_TOKEN_STORE) {
            await env.ZERODHA_TOKEN_STORE.delete(
              "access_token"
            );
          }
        }
      }

      return {
        content: [
          {
            text: JSON.stringify(
              {
                authenticated,
                login_time:
                  authenticated
                    ? loginTime
                    : null,
                validation:
                  authenticated
                    ? "VALID"
                    : "INVALID_OR_MISSING",
                validation_error,
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

  // ==========================================================
  // PROFILE
  // ==========================================================

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

  // ==========================================================
  // MARGINS
  // ==========================================================

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

  // ==========================================================
  // QUOTE
  // ==========================================================

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

  // ==========================================================
  // INSTRUMENTS
  // ==========================================================

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

  // ==========================================================
  // OPTION CHAIN
  // ==========================================================

  server.registerTool(
    "zerodha_option_chain",
    {
      description:
        "Build a live NIFTY or BANKNIFTY option chain from Zerodha instrument metadata and live quotes. Returns expiry, spot, ATM, strikes, CE/PE symbols, LTP, bid, ask, bid/ask quantities, bid-ask spread, OI, volume and OI day high/low. Read-only.",

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
      // Get instrument master
      // ------------------------------------------------------

      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      // ------------------------------------------------------
      // Get spot
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
      // Filter options
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
      // Expiry
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

      const expiryContracts =
        optionContracts.filter(
          (instrument) =>
            instrument.expiry ===
            selectedExpiry
        );

      // ------------------------------------------------------
      // Strikes
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
      // ATM
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
      // Select strikes
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
      // Map contracts
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
      // Quote symbols
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
      // Get quotes
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
      // Build chain
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

            const ceBid =
              ceQuote
                ?.depth?.buy?.[0]
                ?.price ?? null;

            const ceBidQuantity =
              ceQuote
                ?.depth?.buy?.[0]
                ?.quantity ?? null;

            const ceAsk =
              ceQuote
                ?.depth?.sell?.[0]
                ?.price ?? null;

            const ceAskQuantity =
              ceQuote
                ?.depth?.sell?.[0]
                ?.quantity ?? null;

            const ceBidAskSpread =
              ceBid !== null &&
              ceAsk !== null
                ? Number(
                    (
                      ceAsk -
                      ceBid
                    ).toFixed(2)
                  )
                : null;

            const peBid =
              peQuote
                ?.depth?.buy?.[0]
                ?.price ?? null;

            const peBidQuantity =
              peQuote
                ?.depth?.buy?.[0]
                ?.quantity ?? null;

            const peAsk =
              peQuote
                ?.depth?.sell?.[0]
                ?.price ?? null;

            const peAskQuantity =
              peQuote
                ?.depth?.sell?.[0]
                ?.quantity ?? null;

            const peBidAskSpread =
              peBid !== null &&
              peAsk !== null
                ? Number(
                    (
                      peAsk -
                      peBid
                    ).toFixed(2)
                  )
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

                    bid:
                      ceBid,

                    bid_quantity:
                      ceBidQuantity,

                    ask:
                      ceAsk,

                    ask_quantity:
                      ceAskQuantity,

                    bid_ask_spread:
                      ceBidAskSpread,

                    oi:
                      ceQuote?.oi ??
                      null,

                    volume:
                      ceQuote
                        ?.volume ??
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

                    bid:
                      peBid,

                    bid_quantity:
                      peBidQuantity,

                    ask:
                      peAsk,

                    ask_quantity:
                      peAskQuantity,

                    bid_ask_spread:
                      peBidAskSpread,

                    oi:
                      peQuote?.oi ??
                      null,

                    volume:
                      peQuote
                        ?.volume ??
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

  // ==========================================================
  // OPTION ANALYSIS
  // ==========================================================

  server.registerTool(
    "zerodha_option_analysis",
    {
      description:
        "Analyse the live NIFTY or BANKNIFTY option chain. Returns spot, expiry, DTE, ATM and derived CE/PE metrics including moneyness, distance from spot, OTM percentage, mid price, bid-ask spread, spread percentage, intrinsic value and time value. Read-only.",

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
      // ------------------------------------------------------
      // 1. Instrument master
      // ------------------------------------------------------

      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      // ------------------------------------------------------
      // 2. Spot
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
      // 4. Expiry
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
      // 5. DTE
      // ------------------------------------------------------

      const expiryDate =
        new Date(
          selectedExpiry +
            "T15:30:00+05:30"
        );

      const now =
        new Date();

      const millisecondsPerDay =
        24 *
        60 *
        60 *
        1000;

      const dte = Math.max(
        0,
        Math.ceil(
          (
            expiryDate.getTime() -
            now.getTime()
          ) /
            millisecondsPerDay
        )
      );

      // ------------------------------------------------------
      // 6. Strikes
      // ------------------------------------------------------

      const expiryContracts =
        optionContracts.filter(
          (instrument) =>
            instrument.expiry ===
            selectedExpiry
        );

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
      // 7. ATM
      // ------------------------------------------------------

      let atm =
        strikes[0];

      let nearestDistance =
        Math.abs(
          atm - spot
        );

      for (
        const strike of
          strikes
      ) {
        const distance =
          Math.abs(
            strike - spot
          );

        if (
          distance <
          nearestDistance
        ) {
          nearestDistance =
            distance;

          atm =
            strike;
        }
      }

      // ------------------------------------------------------
      // 8. Select strikes
      // ------------------------------------------------------

      const strikeCount =
        strikes_each_side ??
        20;

      const atmIndex =
        strikes.indexOf(
          atm
        );

      const startIndex =
        Math.max(
          0,
          atmIndex -
            strikeCount
        );

      const endIndex =
        Math.min(
          strikes.length,
          atmIndex +
            strikeCount +
            1
        );

      const selectedStrikes =
        strikes.slice(
          startIndex,
          endIndex
        );

      // ------------------------------------------------------
      // 9. Map contracts
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
      // 12. Option analytics helper
      // ------------------------------------------------------

      function analyseOption(
        quote: any,
        strike: number,
        type: "CE" | "PE"
      ) {
        const ltp =
          quote?.last_price ??
          null;

        const bid =
          quote
            ?.depth?.buy?.[0]
            ?.price ?? null;

        const ask =
          quote
            ?.depth?.sell?.[0]
            ?.price ?? null;

        const bidQuantity =
          quote
            ?.depth?.buy?.[0]
            ?.quantity ?? null;

        const askQuantity =
          quote
            ?.depth?.sell?.[0]
            ?.quantity ?? null;

        const midPrice =
          bid !== null &&
          ask !== null &&
          bid > 0 &&
          ask > 0
            ? Number(
                (
                  (bid + ask) /
                  2
                ).toFixed(2)
              )
            : null;

        const spread =
          bid !== null &&
          ask !== null &&
          bid > 0 &&
          ask > 0
            ? Number(
                (
                  ask - bid
                ).toFixed(2)
              )
            : null;

        const spreadPct =
          midPrice !== null &&
          midPrice > 0 &&
          spread !== null
            ? Number(
                (
                  (spread /
                    midPrice) *
                  100
                ).toFixed(2)
              )
            : null;

        // ----------------------------------------------------
        // Intrinsic value
        // ----------------------------------------------------

        let intrinsicValue =
          0;

        if (
          type === "CE"
        ) {
          intrinsicValue =
            Math.max(
              0,
              spot - strike
            );
        } else {
          intrinsicValue =
            Math.max(
              0,
              strike - spot
            );
        }

        // ----------------------------------------------------
        // Time value
        // ----------------------------------------------------

        const timeValue =
          ltp !== null
            ? Number(
                Math.max(
                  0,
                  ltp -
                    intrinsicValue
                ).toFixed(2)
              )
            : null;

        // ----------------------------------------------------
        // Moneyness
        // ----------------------------------------------------

        let moneyness:
          | "ITM"
          | "ATM"
          | "OTM";

        if (
          Math.abs(
            strike - atm
          ) < 0.000001
        ) {
          moneyness =
            "ATM";
        } else if (
          type === "CE"
        ) {
          moneyness =
            strike < spot
              ? "ITM"
              : "OTM";
        } else {
          moneyness =
            strike > spot
              ? "ITM"
              : "OTM";
        }

        // ----------------------------------------------------
        // Distance
        // ----------------------------------------------------

        const distanceFromSpot =
          Number(
            (
              strike -
              spot
            ).toFixed(2)
          );

        const distancePct =
          Number(
            (
              (
                (
                  strike -
                  spot
                ) /
                spot
              ) *
              100
            ).toFixed(2)
          );

        // ----------------------------------------------------
        // OTM %
        // ----------------------------------------------------

        let otmPct =
          0;

        if (
          type === "CE"
        ) {
          otmPct =
            strike > spot
              ? Number(
                  (
                    (
                      (
                        strike -
                        spot
                      ) /
                      spot
                    ) *
                    100
                  ).toFixed(2)
                )
              : 0;
        } else {
          otmPct =
            strike < spot
              ? Number(
                  (
                    (
                      (
                        spot -
                        strike
                      ) /
                      spot
                    ) *
                    100
                  ).toFixed(2)
                )
              : 0;
        }

        return {
          ltp,

          bid,

          bid_quantity:
            bidQuantity,

          ask,

          ask_quantity:
            askQuantity,

          mid_price:
            midPrice,

          spread,

          spread_pct:
            spreadPct,

          moneyness,

          distance_from_spot:
            distanceFromSpot,

          distance_pct:
            distancePct,

          otm_pct:
            otmPct,

          intrinsic_value:
            Number(
              intrinsicValue.toFixed(
                2
              )
            ),

          time_value:
            timeValue,

          oi:
            quote?.oi ??
            null,

          volume:
            quote?.volume ??
            null,

          oi_day_high:
            quote
              ?.oi_day_high ??
            null,

          oi_day_low:
            quote
              ?.oi_day_low ??
            null,

          net_change:
            quote
              ?.net_change ??
            null,
        };
      }

      // ------------------------------------------------------
      // 13. Build analysed chain
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

                    ...analyseOption(
                      ceQuote,
                      strike,
                      "CE"
                    ),
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

                    ...analyseOption(
                      peQuote,
                      strike,
                      "PE"
                    ),
                  }
                : null,
            };
          }
        );

      // ------------------------------------------------------
      // 14. Return analysis
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

                dte,

                atm,

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

  // ==========================================================
  // CREDIT SPREAD ANALYSIS
  // ==========================================================

  server.registerTool(
    "zerodha_credit_spread",
    {
      description:
        "Analyse a defined-risk NIFTY or BANKNIFTY Bull Put Spread (BPS) or Bear Call Spread (BCS) using executable bid/ask prices. Read-only; does not place, modify or cancel orders.",

      inputSchema: {
        underlying:
          z.enum([
            "NIFTY",
            "BANKNIFTY",
          ]),

        expiry:
          z.string().optional(),

        strategy:
          z.enum([
            "BPS",
            "BCS",
          ]),

        short_strike:
          z.number().positive(),

        spread_width:
          z.number().positive(),

        lots:
          z.number().int().positive(),
      },
    },

    async ({
      underlying,
      expiry,
      strategy,
      short_strike,
      spread_width,
      lots,
    }) => {
      const instruments =
        await getNfoInstrumentMaster(
          env
        );

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
          "Unable to obtain spot price for " +
            underlying +
            "."
        );
      }

      const contracts =
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

      const expiries =
        Array.from(
          new Set(
            contracts
              .map((x) => x.expiry)
              .filter(Boolean)
          )
        ).sort();

      if (
        expiries.length ===
        0
      ) {
        throw new Error(
          "No option expiries found for " +
            underlying +
            "."
        );
      }

      let selectedExpiry =
        expiry;

      if (
        !selectedExpiry ||
        selectedExpiry ===
          "nearest"
      ) {
        const now =
          new Date();

        const futureExpiries =
          expiries.filter(
            (x) =>
              new Date(
                x +
                  "T23:59:59+05:30"
              ) >= now
          );

        if (
          futureExpiries.length ===
          0
        ) {
          throw new Error(
            "No future option expiry found."
          );
        }

        selectedExpiry =
          futureExpiries[0];
      }

      if (
        !expiries.includes(
          selectedExpiry
        )
      ) {
        throw new Error(
          "Expiry " +
            selectedExpiry +
            " was not found."
        );
      }

      const expiryContracts =
        contracts.filter(
          (x) =>
            x.expiry ===
            selectedExpiry
        );

      const lotSizes =
        Array.from(
          new Set(
            expiryContracts
              .map((x) =>
                Number(
                  x.lot_size
                )
              )
              .filter(
                (x) =>
                  Number.isFinite(
                    x
                  ) &&
                  x > 0
              )
          )
        );

      if (
        lotSizes.length !==
        1
      ) {
        throw new Error(
          "Unable to determine a unique lot size for " +
            underlying +
            "."
        );
      }

      const lotSize =
        lotSizes[0];

      const quantity =
        lots * lotSize;

      const optionType =
        strategy ===
        "BPS"
          ? "PE"
          : "CE";

      const longStrike =
        strategy ===
        "BPS"
          ? short_strike -
            spread_width
          : short_strike +
            spread_width;

      const shortContract =
        expiryContracts.find(
          (x) =>
            Number(
              x.strike
            ) ===
              short_strike &&
            x.instrument_type ===
              optionType
        );

      const longContract =
        expiryContracts.find(
          (x) =>
            Number(
              x.strike
            ) ===
              longStrike &&
            x.instrument_type ===
              optionType
        );

      if (
        !shortContract
      ) {
        throw new Error(
          "Short " +
            optionType +
            " contract not found at strike " +
            short_strike +
            " for expiry " +
            selectedExpiry +
            "."
        );
      }

      if (
        !longContract
      ) {
        throw new Error(
          "Long " +
            optionType +
            " contract not found at strike " +
            longStrike +
            " for expiry " +
            selectedExpiry +
            "."
        );
      }

      const quoteData =
        (await zerodhaGet(
          "/quote?" +
            new URLSearchParams([
              [
                "i",
                "NFO:" +
                  shortContract.tradingsymbol,
              ],
              [
                "i",
                "NFO:" +
                  longContract.tradingsymbol,
              ],
            ]).toString(),
          env
        )) as any;

      const shortQuote =
        quoteData?.data?.[
          "NFO:" +
            shortContract.tradingsymbol
        ];

      const longQuote =
        quoteData?.data?.[
          "NFO:" +
            longContract.tradingsymbol
        ];

      const shortBid =
        shortQuote?.depth?.buy?.[0]
          ?.price ??
        null;

      const shortAsk =
        shortQuote?.depth?.sell?.[0]
          ?.price ??
        null;

      const longBid =
        longQuote?.depth?.buy?.[0]
          ?.price ??
        null;

      const longAsk =
        longQuote?.depth?.sell?.[0]
          ?.price ??
        null;

      const shortLtp =
        shortQuote?.last_price ??
        null;

      const longLtp =
        longQuote?.last_price ??
        null;

      const executableCredit =
        shortBid !== null &&
        longAsk !== null &&
        shortBid > 0 &&
        longAsk > 0
          ? shortBid -
            longAsk
          : null;

      const indicativeCredit =
        shortLtp !== null &&
        longLtp !== null
          ? shortLtp -
            longLtp
          : null;

      const maxProfitPerUnit =
        executableCredit !==
          null &&
        executableCredit >
          0
          ? executableCredit
          : null;

      const maxLossPerUnit =
        maxProfitPerUnit !==
          null
          ? spread_width -
            maxProfitPerUnit
          : null;

      let breakeven =
        null;

      let beDistance =
        null;

      let beDistancePct =
        null;

      if (
        maxProfitPerUnit !==
        null
      ) {
        if (
          strategy ===
          "BPS"
        ) {
          breakeven =
            short_strike -
            maxProfitPerUnit;

          beDistance =
            spot -
            breakeven;
        } else {
          breakeven =
            short_strike +
            maxProfitPerUnit;

          beDistance =
            breakeven -
            spot;
        }

        beDistancePct =
          (beDistance /
            spot) *
          100;
      }

      const maxProfitTotal =
        maxProfitPerUnit !==
          null
          ? maxProfitPerUnit *
            quantity
          : null;

      const maxLossTotal =
        maxLossPerUnit !==
          null
          ? maxLossPerUnit *
            quantity
          : null;

      const profitLossRatioPct =
        maxLossPerUnit !==
          null &&
        maxLossPerUnit >
          0 &&
        maxProfitPerUnit !==
          null
          ? (
              maxProfitPerUnit /
              maxLossPerUnit
            ) *
            100
          : null;

      const shortStrikeDistance =
        strategy ===
        "BPS"
          ? spot -
            short_strike
          : short_strike -
            spot;

      const shortStrikeDistancePct =
        (
          shortStrikeDistance /
          spot
        ) *
        100;

      const round2 = (
        value: number | null
      ) =>
        value === null ||
        !Number.isFinite(
          value
        )
          ? null
          : Number(
              value.toFixed(2)
            );

      return {
        content: [
          {
            text: JSON.stringify(
              {
                status:
                  "success",
                underlying,
                spot:
                  round2(
                    spot
                  ),
                expiry:
                  selectedExpiry,
                strategy,
                option_type:
                  optionType,
                short_strike,
                long_strike:
                  longStrike,
                spread_width,
                dte:
                  Math.max(
                    0,
                    Math.ceil(
                      (
                        new Date(
                          selectedExpiry +
                            "T15:30:00+05:30"
                        ).getTime() -
                        Date.now()
                      ) /
                        (
                          24 *
                          60 *
                          60 *
                          1000
                        )
                    )
                  ),
                lot_size:
                  lotSize,
                lots,
                quantity,
                short_leg: {
                  symbol:
                    shortContract.tradingsymbol,
                  side:
                    "SELL",
                  ltp:
                    round2(
                      shortLtp
                    ),
                  bid:
                    round2(
                      shortBid
                    ),
                  bid_quantity:
                    shortQuote
                      ?.depth?.buy?.[0]
                      ?.quantity ??
                    null,
                  ask:
                    round2(
                      shortAsk
                    ),
                  ask_quantity:
                    shortQuote
                      ?.depth?.sell?.[0]
                      ?.quantity ??
                    null,
                  oi:
                    shortQuote?.oi ??
                    null,
                  volume:
                    shortQuote?.volume ??
                    null,
                },
                long_leg: {
                  symbol:
                    longContract.tradingsymbol,
                  side:
                    "BUY",
                  ltp:
                    round2(
                      longLtp
                    ),
                  bid:
                    round2(
                      longBid
                    ),
                  bid_quantity:
                    longQuote
                      ?.depth?.buy?.[0]
                      ?.quantity ??
                    null,
                  ask:
                    round2(
                      longAsk
                    ),
                  ask_quantity:
                    longQuote
                      ?.depth?.sell?.[0]
                      ?.quantity ??
                    null,
                  oi:
                    longQuote?.oi ??
                    null,
                  volume:
                    longQuote?.volume ??
                    null,
                },
                pricing: {
                  executable_credit:
                    round2(
                      executableCredit
                    ),
                  indicative_credit_ltp:
                    round2(
                      indicativeCredit
                    ),
                  executable:
                    executableCredit !==
                      null &&
                    executableCredit >
                      0,
                  pricing_method:
                    "SELL short leg at bid; BUY long leg at ask",
                },
                risk: {
                  max_profit_per_unit:
                    round2(
                      maxProfitPerUnit
                    ),
                  max_loss_per_unit:
                    round2(
                      maxLossPerUnit
                    ),
                  max_profit_total:
                    round2(
                      maxProfitTotal
                    ),
                  max_loss_total:
                    round2(
                      maxLossTotal
                    ),
                  breakeven:
                    round2(
                      breakeven
                    ),
                  breakeven_distance:
                    round2(
                      beDistance
                    ),
                  breakeven_distance_pct:
                    round2(
                      beDistancePct
                    ),
                  short_strike_distance:
                    round2(
                      shortStrikeDistance
                    ),
                  short_strike_distance_pct:
                    round2(
                      shortStrikeDistancePct
                    ),
                  max_profit_to_max_loss_pct:
                    round2(
                      profitLossRatioPct
                    ),
                },
                liquidity: {
                  short_bid_quantity:
                    shortQuote
                      ?.depth?.buy?.[0]
                      ?.quantity ??
                    null,
                  short_ask_quantity:
                    shortQuote
                      ?.depth?.sell?.[0]
                      ?.quantity ??
                    null,
                  long_bid_quantity:
                    longQuote
                      ?.depth?.buy?.[0]
                      ?.quantity ??
                    null,
                  long_ask_quantity:
                    longQuote
                      ?.depth?.sell?.[0]
                      ?.quantity ??
                    null,
                  sufficient_live_depth:
                    shortBid !==
                      null &&
                    longAsk !==
                      null &&
                    shortBid >
                      0 &&
                    longAsk >
                      0,
                },
                read_only:
                  true,
              },
              null,
              2
            ),
            type:
              "text",
          },
        ],
      };
    }
  );

  // ==========================================================
  // CREDIT SPREAD SCANNER
  // ==========================================================

  server.registerTool(
    "zerodha_credit_spread_scan",
    {
      description:
        "Scan NIFTY or BANKNIFTY defined-risk credit spreads for a selected OTM range and spread width. Returns conservative execution pricing using short-leg bid and long-leg ask, required quantity, available execution-side depth, credit-to-width, bid-ask cost, breakeven and defined risk. Read-only.",

      inputSchema: {
        underlying: z.enum([
          "NIFTY",
          "BANKNIFTY",
        ]),

        expiry:
          z.string().optional(),

        strategy: z.enum([
          "BPS",
          "BCS",
        ]),

        spread_width:
          z.number().positive(),

        min_otm_pct:
          z
            .number()
            .nonnegative()
            .optional(),

        max_otm_pct:
          z
            .number()
            .positive()
            .optional(),

        lots:
          z
            .number()
            .int()
            .positive()
            .optional(),

        max_candidates:
          z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional(),
      },
    },

    async ({
      underlying,
      expiry,
      strategy,
      spread_width,
      min_otm_pct,
      max_otm_pct,
      lots,
      max_candidates,
    }) => {
      const minOtmPct =
        min_otm_pct ?? 1.0;

      const maxOtmPct =
        max_otm_pct ?? 2.5;

      const requestedLots =
        lots ?? 1;

      const maxCandidates =
        max_candidates ?? 20;

      if (
        minOtmPct >= maxOtmPct
      ) {
        throw new Error(
          "min_otm_pct must be less than max_otm_pct."
        );
      }

      // ------------------------------------------------------
      // Instrument master
      // ------------------------------------------------------

      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      // ------------------------------------------------------
      // Spot
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
      // Option contracts
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
                (
                  strategy ===
                  "BPS"
                    ? "PE"
                    : "CE"
                )
            )
        );

      if (
        optionContracts.length ===
        0
      ) {
        throw new Error(
          "No option contracts found for " +
            underlying +
            " " +
            strategy +
            "."
        );
      }

      // ------------------------------------------------------
      // Expiry
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

      const expiryContracts =
        optionContracts.filter(
          (instrument) =>
            instrument.expiry ===
            selectedExpiry
        );

      // ------------------------------------------------------
      // Strike map
      // ------------------------------------------------------

      const strikeMap =
        new Map<
          number,
          Record<string, string>
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
          !Number.isFinite(
            strike
          ) ||
          strike <= 0
        ) {
          continue;
        }

        strikeMap.set(
          strike,
          instrument
        );
      }

      const strikes =
        Array.from(
          strikeMap.keys()
        ).sort(
          (a, b) =>
            a - b
        );

      const eligible =
        strikes
          .map(
            (
              shortStrike
            ) => {
              const shortOtmPct =
                strategy ===
                "BPS"
                  ? (
                      (
                        spot -
                        shortStrike
                      ) /
                      spot
                    ) *
                    100
                  : (
                      (
                        shortStrike -
                        spot
                      ) /
                      spot
                    ) *
                    100;

              const longStrike =
                strategy ===
                "BPS"
                  ? shortStrike -
                    spread_width
                  : shortStrike +
                    spread_width;

              const longContract =
                strikeMap.get(
                  longStrike
                );

              const directionValid =
                strategy ===
                "BPS"
                  ? shortStrike <
                    spot
                  : shortStrike >
                    spot;

              if (
                !directionValid ||
                shortOtmPct <
                  minOtmPct ||
                shortOtmPct >
                  maxOtmPct ||
                !longContract
              ) {
                return null;
              }

              return {
                shortStrike,
                longStrike,
                shortOtmPct,
                shortContract:
                  strikeMap.get(
                    shortStrike
                  )!,
                longContract,
              };
            }
          )
          .filter(
            (
              item
            ): item is NonNullable<
              typeof item
            > =>
              item !== null
          )
          .sort(
            (a, b) =>
              a.shortOtmPct -
              b.shortOtmPct
          );

      const lotSize =
        Number(
          expiryContracts[0]
            ?.lot_size
        );

      if (
        !Number.isFinite(
          lotSize
        ) ||
        lotSize <= 0
      ) {
        throw new Error(
          "Unable to determine the lot size for " +
            underlying +
            " " +
            selectedExpiry +
            "."
        );
      }

      const requiredQuantity =
        requestedLots *
        lotSize;

      // Only quote as many candidates as the caller requested.
      // A hard cap of 50 protects the Zerodha quote request.
      const scanCandidates =
        eligible.slice(
          0,
          Math.min(
            50,
            maxCandidates
          )
        );

      if (
        scanCandidates.length ===
        0
      ) {
        return {
          content: [
            {
              text: JSON.stringify(
                {
                  status:
                    "success",
                  underlying,
                  spot:
                    Number(
                      spot.toFixed(
                        2
                      )
                    ),
                  expiry:
                    selectedExpiry,
                  strategy,
                  spread_width,
                  dte:
                    Math.max(
                      0,
                      Math.ceil(
                        (
                          new Date(
                            selectedExpiry +
                              "T15:30:00+05:30"
                          ).getTime() -
                          Date.now()
                        ) /
                          (
                            24 *
                            60 *
                            60 *
                            1000
                          )
                      )
                    ),
                  lots:
                    requestedLots,
                  lot_size:
                    lotSize,
                  quantity:
                    requiredQuantity,
                  min_otm_pct:
                    minOtmPct,
                  max_otm_pct:
                    maxOtmPct,
                  candidates_scanned:
                    0,
                  candidates_returned:
                    0,
                  candidates: [],
                  message:
                    "No candidate spreads matched the supplied OTM range and spread width.",
                  read_only:
                    true,
                },
                null,
                2
              ),
              type:
                "text",
            },
          ],
        };
      }

      // ------------------------------------------------------
      // Quotes
      // ------------------------------------------------------

      const quoteParams =
        new URLSearchParams();

      for (
        const candidate of
          scanCandidates
      ) {
        quoteParams.append(
          "i",
          "NFO:" +
            candidate
              .shortContract
              .tradingsymbol
        );

        quoteParams.append(
          "i",
          "NFO:" +
            candidate
              .longContract
              .tradingsymbol
        );
      }

      const quoteData =
        (await zerodhaGet(
          "/quote?" +
            quoteParams.toString(),
          env
        )) as any;

      const round2 = (
        value:
          number | null
      ) =>
        value === null ||
        !Number.isFinite(
          value
        )
          ? null
          : Number(
              value.toFixed(
                2
              )
            );

      // ------------------------------------------------------
      // Candidate analysis
      // ------------------------------------------------------

      const results =
        scanCandidates.map(
          (
            candidate
          ) => {
            const shortKey =
              "NFO:" +
              candidate
                .shortContract
                .tradingsymbol;

            const longKey =
              "NFO:" +
              candidate
                .longContract
                .tradingsymbol;

            const shortQuote =
              quoteData?.data?.[
                shortKey
              ];

            const longQuote =
              quoteData?.data?.[
                longKey
              ];

            const shortBid =
              shortQuote
                ?.depth?.buy?.[0]
                ?.price ??
              null;

            const shortAsk =
              shortQuote
                ?.depth?.sell?.[0]
                ?.price ??
              null;

            const longBid =
              longQuote
                ?.depth?.buy?.[0]
                ?.price ??
              null;

            const longAsk =
              longQuote
                ?.depth?.sell?.[0]
                ?.price ??
              null;

            const shortBidQty =
              shortQuote
                ?.depth?.buy?.[0]
                ?.quantity ??
              null;

            const shortAskQty =
              shortQuote
                ?.depth?.sell?.[0]
                ?.quantity ??
              null;

            const longBidQty =
              longQuote
                ?.depth?.buy?.[0]
                ?.quantity ??
              null;

            const longAskQty =
              longQuote
                ?.depth?.sell?.[0]
                ?.quantity ??
              null;

            const shortLtp =
              shortQuote
                ?.last_price ??
              null;

            const longLtp =
              longQuote
                ?.last_price ??
              null;

            // Conservative executable pricing:
            // sell short leg at bid and buy long leg at ask.
            const executableCredit =
              shortBid !==
                null &&
              longAsk !==
                null &&
              shortBid > 0 &&
              longAsk > 0
                ? shortBid -
                  longAsk
                : null;

            const indicativeCredit =
              shortLtp !==
                null &&
              longLtp !==
                null
                ? shortLtp -
                  longLtp
                : null;

            const twoLegBidAskWidth =
              shortBid !==
                null &&
              shortAsk !==
                null &&
              longBid !==
                null &&
              longAsk !==
                null &&
              shortBid > 0 &&
              shortAsk > 0 &&
              longBid > 0 &&
              longAsk > 0
                ? (
                    (
                      shortAsk -
                      shortBid
                    ) +
                    (
                      longAsk -
                      longBid
                    )
                  )
                : null;

            const executionSlippageVsLtp =
              indicativeCredit !==
                null &&
              executableCredit !==
                null
                ? indicativeCredit -
                  executableCredit
                : null;

            const executionPricesAvailable =
              shortBid !==
                null &&
              longAsk !==
                null &&
              shortBid > 0 &&
              longAsk > 0;

            const executionDepthAvailable =
              shortBidQty !==
                null &&
              longAskQty !==
                null &&
              shortBidQty > 0 &&
              longAskQty > 0;

            const depthSupported =
              executionDepthAvailable &&
              shortBidQty >=
                requiredQuantity &&
              longAskQty >=
                requiredQuantity;

            const maxProfitPerUnit =
              executableCredit !==
                null &&
              executableCredit > 0 &&
              executableCredit <
                spread_width
                ? executableCredit
                : null;

            const maxLossPerUnit =
              maxProfitPerUnit !==
                null
                ? spread_width -
                  maxProfitPerUnit
                : null;

            let breakeven =
              null;

            let beDistance =
              null;

            let beDistancePct =
              null;

            if (
              maxProfitPerUnit !==
              null
            ) {
              breakeven =
                strategy ===
                "BPS"
                  ? candidate
                      .shortStrike -
                    maxProfitPerUnit
                  : candidate
                      .shortStrike +
                    maxProfitPerUnit;

              beDistance =
                strategy ===
                "BPS"
                  ? spot -
                    breakeven
                  : breakeven -
                    spot;

              beDistancePct =
                (
                  beDistance /
                  spot
                ) *
                100;
            }

            let status =
              "NO_LIVE_DEPTH";

            if (
              !executionPricesAvailable
            ) {
              status =
                "NO_LIVE_DEPTH";
            } else if (
              !executionDepthAvailable
            ) {
              status =
                "NO_LIVE_DEPTH";
            } else if (
              !depthSupported
            ) {
              status =
                "INSUFFICIENT_DEPTH";
            } else if (
              executableCredit !==
                null &&
              executableCredit <=
                0
            ) {
              status =
                "NON_POSITIVE_CREDIT";
            } else if (
              executableCredit !==
                null &&
              executableCredit >=
                spread_width
            ) {
              status =
                "INVALID_CREDIT";
            } else {
              status =
                "EXECUTABLE";
            }

            return {
              short_strike:
                candidate
                  .shortStrike,

              long_strike:
                candidate
                  .longStrike,

              short_strike_otm_pct:
                round2(
                  candidate
                    .shortOtmPct
                ),

              short_strike_distance:
                round2(
                  strategy ===
                  "BPS"
                    ? spot -
                      candidate
                        .shortStrike
                    : candidate
                        .shortStrike -
                      spot
                ),

              short_strike_distance_pct:
                round2(
                  candidate
                    .shortOtmPct
                ),

              short_leg: {
                symbol:
                  candidate
                    .shortContract
                    .tradingsymbol,

                ltp:
                  round2(
                    shortLtp
                  ),

                bid:
                  round2(
                    shortBid
                  ),

                ask:
                  round2(
                    shortAsk
                  ),

                bid_quantity:
                  shortBidQty,

                ask_quantity:
                  shortAskQty,

                oi:
                  shortQuote?.oi ??
                  null,

                volume:
                  shortQuote
                    ?.volume ??
                  null,
              },

              long_leg: {
                symbol:
                  candidate
                    .longContract
                    .tradingsymbol,

                ltp:
                  round2(
                    longLtp
                  ),

                bid:
                  round2(
                    longBid
                  ),

                ask:
                  round2(
                    longAsk
                  ),

                bid_quantity:
                  longBidQty,

                ask_quantity:
                  longAskQty,

                oi:
                  longQuote?.oi ??
                  null,

                volume:
                  longQuote
                    ?.volume ??
                  null,
              },

              pricing: {
                executable_credit:
                  round2(
                    executableCredit
                  ),

                indicative_credit_ltp:
                  round2(
                    indicativeCredit
                  ),

                credit_to_width_pct:
                  round2(
                    executableCredit !==
                      null
                      ? (
                          executableCredit /
                          spread_width
                        ) *
                        100
                      : null
                  ),

                indicative_credit_to_width_pct:
                  round2(
                    indicativeCredit !==
                      null
                      ? (
                          indicativeCredit /
                          spread_width
                        ) *
                        100
                      : null
                  ),

                two_leg_bid_ask_width:
                  round2(
                    twoLegBidAskWidth
                  ),

                execution_slippage_vs_ltp:
                  round2(
                    executionSlippageVsLtp
                  ),

                executable:
                  status ===
                  "EXECUTABLE",

                pricing_method:
                  "SELL short leg at bid; BUY long leg at ask",
              },

              quantity: {
                lots:
                  requestedLots,

                lot_size:
                  lotSize,

                required_quantity:
                  requiredQuantity,
              },

              liquidity: {
                execution_side:
                  strategy ===
                  "BPS"
                    ? "short PE bid + long PE ask"
                    : "short CE bid + long CE ask",

                short_bid_quantity:
                  shortBidQty,

                long_ask_quantity:
                  longAskQty,

                required_quantity:
                  requiredQuantity,

                depth_supported:
                  depthSupported,

                execution_prices_available:
                  executionPricesAvailable,

                execution_depth_available:
                  executionDepthAvailable,
              },

              risk: {
                max_profit_per_unit:
                  round2(
                    maxProfitPerUnit
                  ),

                max_loss_per_unit:
                  round2(
                    maxLossPerUnit
                  ),

                max_profit_total:
                  round2(
                    maxProfitPerUnit !==
                      null
                      ? maxProfitPerUnit *
                        requiredQuantity
                      : null
                  ),

                max_loss_total:
                  round2(
                    maxLossPerUnit !==
                      null
                      ? maxLossPerUnit *
                        requiredQuantity
                      : null
                  ),

                breakeven:
                  round2(
                    breakeven
                  ),

                breakeven_distance:
                  round2(
                    beDistance
                  ),

                breakeven_distance_pct:
                  round2(
                    beDistancePct
                  ),

                max_profit_to_max_loss_pct:
                  round2(
                    maxProfitPerUnit !==
                      null &&
                    maxLossPerUnit !==
                      null &&
                    maxLossPerUnit > 0
                      ? (
                          maxProfitPerUnit /
                          maxLossPerUnit
                        ) *
                        100
                      : null
                  ),
              },

              status,

              read_only:
                true,
            };
          }
        );

      const dte =
        Math.max(
          0,
          Math.ceil(
            (
              new Date(
                selectedExpiry +
                  "T15:30:00+05:30"
              ).getTime() -
              Date.now()
            ) /
              (
                24 *
                60 *
                60 *
                1000
              )
          )
        );

      return {
        content: [
          {
            text: JSON.stringify(
              {
                status:
                  "success",

                underlying,

                spot:
                  round2(
                    spot
                  ),

                expiry:
                  selectedExpiry,

                strategy,

                spread_width,

                dte,

                lots:
                  requestedLots,

                lot_size:
                  lotSize,

                quantity:
                  requiredQuantity,

                min_otm_pct:
                  minOtmPct,

                max_otm_pct:
                  maxOtmPct,

                candidates_scanned:
                  scanCandidates.length,

                candidates_returned:
                  results.length,

                candidates:
                  results,

                read_only:
                  true,
              },
              null,
              2
            ),

            type:
              "text",
          },
        ],
      };
    }
  );


  // ==========================================================

  // ==========================================================
  // CS TRADE REGISTRY
  // ==========================================================

  server.registerTool(
    "zerodha_trade_registry",
    {
      description:
        "Persistent read/write registry for logical Zerodha credit-spread trades. Stores trade identity, actual trade date when known, first observation date, original economics, and lifecycle fields. Read/write.",
      inputSchema: {
        action: z.enum(["get", "upsert", "list"]).describe(
          "get one trade, upsert a trade record, or list all registry records"
        ),
        trade_id: z.string().min(1).optional(),
        trade: z
          .object({
            trade_id: z.string().min(1),
            broker: z.string().min(1),
            underlying: z.enum(["NIFTY", "BANKNIFTY"]),
            expiry: z.string().min(1),
            strategy: z.enum(["BPS", "BCS"]),
            short_strike: z.number(),
            long_strike: z.number(),
            quantity: z.number().int().positive(),
            trade_date: z.string().nullable(),
            trade_time: z.string().nullable().optional(),
            trade_date_source: z
              .enum(["ZERODHA_TRANSACTION", "USER_CONFIRMED", "FIRST_OBSERVED", "UNKNOWN"])
              .default("UNKNOWN"),
            first_observed_date: z.string().nullable(),
            entry_credit: z.number().nullable(),
            max_profit: z.number().nullable(),
            max_loss: z.number().nullable(),
            closed_date: z.string().nullable().optional(),
            booked_pnl: z.number().nullable().optional(),
          })
          .optional(),
      },
    },
    async ({ action, trade_id, trade }) => {
      const prefix = "cs_trade:";

      if (!env.ZERODHA_TOKEN_STORE) {
        throw new Error("KV token store is not configured.");
      }

      if (action === "get") {
        if (!trade_id) {
          throw new Error("trade_id is required for action=get");
        }

        const record = await env.ZERODHA_TOKEN_STORE.get(
          prefix + trade_id,
          "json"
        );

        return {
          content: [
            {
              text: JSON.stringify(
                {
                  status: "success",
                  action,
                  trade_id,
                  found: record !== null,
                  trade: record,
                  read_only: true,
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      }

      if (action === "list") {
        const result = await env.ZERODHA_TOKEN_STORE.list({
          prefix,
          limit: 1000,
        });

        const records = [];
        for (const key of result.keys) {
          const value = await env.ZERODHA_TOKEN_STORE.get(key.name, "json");
          if (value !== null) records.push(value);
        }

        return {
          content: [
            {
              text: JSON.stringify(
                {
                  status: "success",
                  action,
                  count: records.length,
                  trades: records,
                  read_only: true,
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      }

      if (!trade) {
        throw new Error("trade is required for action=upsert");
      }

      const existing = await env.ZERODHA_TOKEN_STORE.get(
        prefix + trade.trade_id,
        "json"
      );

      const existingRecord = existing as Record<string, unknown> | null;

      // Never overwrite an established trade date with a later observation date.
      const merged = {
        ...(existingRecord ?? {}),
        ...trade,
        trade_date:
          trade.trade_date ??
          (existingRecord?.trade_date as string | null | undefined) ??
          null,
        first_observed_date:
          (existingRecord?.first_observed_date as string | null | undefined) ??
          trade.first_observed_date ??
          null,
        trade_date_source:
          trade.trade_date !== null
            ? trade.trade_date_source
            : (existingRecord?.trade_date_source as string | undefined) ??
              trade.trade_date_source,
      };

      await env.ZERODHA_TOKEN_STORE.put(
        prefix + trade.trade_id,
        JSON.stringify(merged)
      );

      return {
        content: [
          {
            text: JSON.stringify(
              {
                status: "success",
                action,
                trade: merged,
                preserved_existing_trade_date:
                  existingRecord?.trade_date != null &&
                  trade.trade_date === null,
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

  // POSITIONS
  // ==========================================================

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

  // ==========================================================
  // HOLDINGS
  // ==========================================================

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

  // ==========================================================
  // MUTUAL FUND HOLDINGS (COIN)
  // ==========================================================

  server.registerTool(
    "zerodha_mf_holdings",
    {
      description:
        "Read current Zerodha Coin mutual fund holdings. Returns fund name, ISIN, folio, units, average NAV, latest available NAV, investment value and current value. Read-only.",
    },

    async () => {
      const response = await zerodhaGet(
        "/mf/holdings",
        env
      ) as any;

      const data = Array.isArray(response?.data)
        ? response.data
        : [];

      const holdings = data.map((r: any) => {
        const quantity = Number(r?.quantity ?? 0);
        const averagePrice = Number(r?.average_price);
        const lastPrice = Number(r?.last_price);
        const investmentValue = Number.isFinite(averagePrice)
          ? averagePrice * quantity
          : null;
        const currentValue = Number.isFinite(lastPrice)
          ? lastPrice * quantity
          : null;
        const pnl = Number.isFinite(Number(r?.pnl))
          ? Number(r.pnl)
          : investmentValue !== null && currentValue !== null
            ? currentValue - investmentValue
            : null;

        return {
          asset_class: "Mutual Fund",
          fund: r?.fund ?? null,
          symbol: r?.tradingsymbol ?? null,
          isin: r?.tradingsymbol ?? null,
          folio: r?.folio ?? null,
          quantity,
          average_price: Number.isFinite(averagePrice) ? averagePrice : null,
          ltp: Number.isFinite(lastPrice) ? lastPrice : null,
          last_price_date: r?.last_price_date ?? null,
          pledged_quantity: Number(r?.pledged_quantity ?? 0),
          investment_value: investmentValue,
          current_value: currentValue,
          pnl,
          pnl_percent:
            investmentValue && pnl !== null
              ? (pnl / investmentValue) * 100
              : null,
        };
      });

      const investmentValue = holdings.reduce(
        (sum: number, h: any) => sum + (h.investment_value ?? 0),
        0
      );
      const currentValue = holdings.reduce(
        (sum: number, h: any) => sum + (h.current_value ?? 0),
        0
      );
      const pnl = currentValue - investmentValue;

      return {
        content: [
          {
            text: JSON.stringify(
              {
                status: response?.status ?? "success",
                data: holdings,
                summary: {
                  investment_value: investmentValue,
                  current_value: currentValue,
                  pnl,
                  pnl_percent: investmentValue
                    ? (pnl / investmentValue) * 100
                    : null,
                  holding_count: holdings.length,
                },
                read_only: true,
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

  // ==========================================================
  // ORDERS
  // ==========================================================

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

  // ==========================================================
  // TRADES
  // ==========================================================

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

  // ==========================================================
  // ORDER HISTORY
  // ==========================================================

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

// ============================================================
// WORKER ENTRY POINT
// ============================================================

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

    if (url.pathname === "/fivepaisa/callback") {
      return handleFivePaisaCallback(request, env);
    }

    return createMcpHandler(
      () =>
        createServer(env, url.origin)
    )(
      request,
      env,
      ctx
    );
  },
} satisfies ExportedHandler<Env>;
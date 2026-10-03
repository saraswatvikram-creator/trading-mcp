import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  ZERODHA_API_KEY: string;
  ZERODHA_API_SECRET: string;
  ZERODHA_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
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
  env: Env
) {
  const server =
    new McpServer({
      name: "Vikram Trading MCP",
      version: "1.0.0",
    });

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

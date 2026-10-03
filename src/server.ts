import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  ZERODHA_API_KEY?: string;
  ZERODHA_API_SECRET?: string;
  ZERODHA_TOKEN_STORE: KVNamespace;
};

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === "," && !insideQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

async function getZerodhaAccessToken(env: Env): Promise<string> {
  const accessToken = await env.ZERODHA_TOKEN_STORE.get("access_token");

  if (!accessToken) {
    throw new Error(
      "Zerodha is not authenticated. Open /login to authenticate."
    );
  }

  return accessToken;
}

async function zerodhaGet(
  env: Env,
  endpoint: string,
  params?: Record<string, string>
): Promise<any> {
  if (!env.ZERODHA_API_KEY) {
    throw new Error("ZERODHA_API_KEY secret is not configured.");
  }

  const accessToken = await getZerodhaAccessToken(env);

  const url = new URL(`https://api.kite.trade${endpoint}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Kite-Version": "3",
      Authorization:
        "token " + env.ZERODHA_API_KEY + ":" + accessToken,
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

async function getNfoInstrumentMaster(
  env: Env
): Promise<Record<string, string>[]> {
  if (!env.ZERODHA_API_KEY) {
    throw new Error("ZERODHA_API_KEY secret is not configured.");
  }

  const accessToken = await getZerodhaAccessToken(env);

  const response = await fetch(
    "https://api.kite.trade/instruments/NFO",
    {
      method: "GET",
      headers: {
        "X-Kite-Version": "3",
        Authorization:
          "token " +
          env.ZERODHA_API_KEY +
          ":" +
          accessToken,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      "Zerodha instruments API error " +
        response.status +
        ": " +
        errorText
    );
  }

  const csv = await response.text();

  const lines = csv
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    throw new Error("Zerodha instrument master is empty.");
  }

  const headers = parseCsvLine(lines[0]);

  const instruments: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);

    if (values.length !== headers.length) {
      continue;
    }

    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = values[index];
    });

    instruments.push(row);
  }

  return instruments;
}

function getSpotSymbol(underlying: "NIFTY" | "BANKNIFTY"): string {
  return underlying === "NIFTY"
    ? "NSE:NIFTY 50"
    : "NSE:NIFTY BANK";
}

function getOptionMoneyness(
  type: "CE" | "PE",
  strike: number,
  spot: number,
  atm: number
): string {
  if (Math.abs(strike - atm) < 0.000001) {
    return "ATM";
  }

  if (type === "CE") {
    return strike < spot ? "ITM" : "OTM";
  }

  return strike > spot ? "ITM" : "OTM";
}

function getOptionIntrinsic(
  type: "CE" | "PE",
  strike: number,
  spot: number
): number {
  if (type === "CE") {
    return Math.max(0, spot - strike);
  }

  return Math.max(0, strike - spot);
}

function getDte(expiry: string): number {
  const expiryDate = new Date(
    expiry + "T15:30:00+05:30"
  );

  const now = new Date();

  const millisecondsPerDay =
    24 * 60 * 60 * 1000;

  return Math.max(
    0,
    Math.ceil(
      (expiryDate.getTime() - now.getTime()) /
        millisecondsPerDay
    )
  );
}

function round2(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(2));
}

function round4(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(4));
}

function analyseOption(
  quote: any,
  contract: Record<string, string>,
  spot: number,
  atm: number
) {
  const type = contract.instrument_type as "CE" | "PE";
  const strike = Number(contract.strike);

  const ltp =
    typeof quote?.last_price === "number"
      ? quote.last_price
      : null;

  const bid =
    typeof quote?.depth?.buy?.[0]?.price === "number"
      ? quote.depth.buy[0].price
      : null;

  const bidQuantity =
    typeof quote?.depth?.buy?.[0]?.quantity === "number"
      ? quote.depth.buy[0].quantity
      : null;

  const ask =
    typeof quote?.depth?.sell?.[0]?.price === "number"
      ? quote.depth.sell[0].price
      : null;

  const askQuantity =
    typeof quote?.depth?.sell?.[0]?.quantity === "number"
      ? quote.depth.sell[0].quantity
      : null;

  const midPrice =
    bid !== null &&
    ask !== null &&
    bid > 0 &&
    ask > 0
      ? (bid + ask) / 2
      : null;

  const spread =
    bid !== null &&
    ask !== null &&
    bid > 0 &&
    ask > 0
      ? ask - bid
      : null;

  const spreadPct =
    spread !== null &&
    midPrice !== null &&
    midPrice > 0
      ? (spread / midPrice) * 100
      : null;

  const distanceFromSpot = strike - spot;

  const distancePct =
    (distanceFromSpot / spot) * 100;

  const intrinsicValue =
    getOptionIntrinsic(type, strike, spot);

  const timeValue =
    ltp !== null
      ? Math.max(0, ltp - intrinsicValue)
      : null;

  const moneyness = getOptionMoneyness(
    type,
    strike,
    spot,
    atm
  );

  const otmPct =
    type === "CE"
      ? strike > spot
        ? ((strike - spot) / spot) * 100
        : 0
      : strike < spot
        ? ((spot - strike) / spot) * 100
        : 0;

  return {
    symbol: contract.tradingsymbol,
    instrument_token: Number(
      contract.instrument_token
    ),

    strike,
    option_type: type,

    ltp: round2(ltp),

    bid: round2(bid),
    bid_quantity: bidQuantity,

    ask: round2(ask),
    ask_quantity: askQuantity,

    mid_price: round2(midPrice),
    spread: round2(spread),
    spread_pct: round2(spreadPct),

    moneyness,

    distance_from_spot: round2(distanceFromSpot),
    distance_pct: round2(distancePct),
    otm_pct: round2(otmPct),

    intrinsic_value: round2(intrinsicValue),
    time_value: round2(timeValue),

    oi:
      typeof quote?.oi === "number"
        ? quote.oi
        : null,

    volume:
      typeof quote?.volume === "number"
        ? quote.volume
        : null,

    oi_day_high:
      typeof quote?.oi_day_high === "number"
        ? quote.oi_day_high
        : null,

    oi_day_low:
      typeof quote?.oi_day_low === "number"
        ? quote.oi_day_low
        : null,

    net_change:
      typeof quote?.net_change === "number"
        ? quote.net_change
        : null,
  };
}

function selectExpiry(
  contracts: Record<string, string>[],
  requestedExpiry?: string
): string {
  const expiries = Array.from(
    new Set(
      contracts
        .map((x) => x.expiry)
        .filter(Boolean)
    )
  ).sort();

  if (expiries.length === 0) {
    throw new Error(
      "No option expiries found for the requested underlying."
    );
  }

  if (
    requestedExpiry &&
    requestedExpiry !== "nearest"
  ) {
    if (!expiries.includes(requestedExpiry)) {
      throw new Error(
        `Expiry ${requestedExpiry} was not found. Available expiries: ${expiries
          .slice(0, 10)
          .join(", ")}`
      );
    }

    return requestedExpiry;
  }

  const today = new Date();

  const futureExpiries = expiries.filter(
    (expiry) =>
      new Date(expiry + "T23:59:59+05:30") >=
      today
  );

  if (futureExpiries.length === 0) {
    throw new Error(
      "No future option expiry found."
    );
  }

  return futureExpiries[0];
}

async function handleZerodhaLogin(
  request: Request,
  env: Env
): Promise<Response> {
  if (
    request.method !== "GET"
  ) {
    return new Response(
      "Method not allowed",
      { status: 405 }
    );
  }

  if (!env.ZERODHA_API_KEY) {
    return new Response(
      "ZERODHA_API_KEY secret is not configured.",
      { status: 500 }
    );
  }

  const loginUrl =
    "https://kite.zerodha.com/connect/login?v=3&api_key=" +
    encodeURIComponent(env.ZERODHA_API_KEY);

  return Response.redirect(
    loginUrl,
    302
  );
}

async function handleZerodhaCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  const requestToken =
    url.searchParams.get("request_token");

  const status =
    url.searchParams.get("status");

  if (!requestToken) {
    return new Response(
      "Missing request_token.",
      { status: 400 }
    );
  }

  if (
    !env.ZERODHA_API_KEY ||
    !env.ZERODHA_API_SECRET
  ) {
    return new Response(
      "Zerodha API credentials are not configured.",
      { status: 500 }
    );
  }

  const body =
    "api_key=" +
    encodeURIComponent(env.ZERODHA_API_KEY) +
    "&request_token=" +
    encodeURIComponent(requestToken) +
    "&checksum=" +
    encodeURIComponent(
      await crypto.subtle
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            env.ZERODHA_API_KEY +
              requestToken +
              env.ZERODHA_API_SECRET
          )
        )
        .then((buffer) =>
          Array.from(
            new Uint8Array(buffer)
          )
            .map((b) =>
              b.toString(16).padStart(2, "0")
            )
            .join("")
        )
    );

  const response = await fetch(
    "https://api.kite.trade/session/token",
    {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const data = await response.json();

  if (!response.ok) {
    return new Response(
      "Zerodha authentication failed: " +
        JSON.stringify(data),
      { status: 500 }
    );
  }

  const accessToken =
    data?.data?.access_token;

  if (!accessToken) {
    return new Response(
      "Zerodha authentication succeeded but no access token was returned.",
      { status: 500 }
    );
  }

  await env.ZERODHA_TOKEN_STORE.put(
    "access_token",
    accessToken
  );

  await env.ZERODHA_TOKEN_STORE.put(
    "login_time",
    new Date().toISOString()
  );

  return new Response(
    `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Zerodha Authentication</title>
<style>
body {
  font-family: Arial, sans-serif;
  margin: 40px;
  line-height: 1.5;
}
.success {
  color: #137333;
  font-size: 20px;
  font-weight: bold;
}
</style>
</head>
<body>
<div class="success">
Zerodha authentication successful.
</div>
<p>
Your daily trading session is now connected.
You can close this window.
</p>
</body>
</html>`,
    {
      headers: {
        "Content-Type":
          "text/html; charset=utf-8",
      },
    }
  );
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Vikram Trading MCP",
    version: "1.0.0",
  });

  // --------------------------------------------------
  // 1. HELLO
  // --------------------------------------------------

  server.tool(
    "hello",
    "Simple MCP connectivity test.",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: "Hello from Vikram Trading MCP.",
        },
      ],
    })
  );

  // --------------------------------------------------
  // 2. ZERODHA AUTH STATUS
  // --------------------------------------------------

  server.tool(
    "zerodha_auth_status",
    "Check whether the Zerodha daily trading session is authenticated.",
    {},
    async () => {
      const accessToken =
        await env.ZERODHA_TOKEN_STORE.get(
          "access_token"
        );

      const loginTime =
        await env.ZERODHA_TOKEN_STORE.get(
          "login_time"
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                authenticated:
                  !!accessToken,
                login_time:
                  loginTime || null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 3. ZERODHA PROFILE
  // --------------------------------------------------

  server.tool(
    "zerodha_profile",
    "Read the authenticated Zerodha user profile.",
    {},
    async () => {
      const data = await zerodhaGet(
        env,
        "/user/profile"
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 4. ZERODHA MARGINS
  // --------------------------------------------------

  server.tool(
    "zerodha_margins",
    "Read Zerodha equity and commodity margins.",
    {},
    async () => {
      const data = await zerodhaGet(
        env,
        "/user/margins"
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 5. ZERODHA QUOTE
  // --------------------------------------------------

  server.tool(
    "zerodha_quote",
    "Get full Zerodha market quotes for one or more comma-separated symbols. Example: NSE:NIFTY 50,NSE:INDIA VIX.",
    {
      symbols: z
        .string()
        .min(1),
    },
    async ({ symbols }) => {
      const symbolList = symbols
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      if (symbolList.length === 0) {
        throw new Error(
          "At least one symbol is required."
        );
      }

      if (symbolList.length > 50) {
        throw new Error(
          "Maximum 50 symbols allowed per quote request."
        );
      }

      const params: Record<
        string,
        string
      > = {};

      symbolList.forEach(
        (symbol, index) => {
          params[`i`] =
            index === 0
              ? symbol
              : params[`i`]
                ? params[`i`] + "," + symbol
                : symbol;
        }
      );

      const query =
        new URLSearchParams();

      symbolList.forEach((symbol) =>
        query.append("i", symbol)
      );

      if (!env.ZERODHA_API_KEY) {
        throw new Error(
          "ZERODHA_API_KEY secret is not configured."
        );
      }

      const accessToken =
        await getZerodhaAccessToken(
          env
        );

      const response = await fetch(
        "https://api.kite.trade/quote?" +
          query.toString(),
        {
          method: "GET",
          headers: {
            "X-Kite-Version": "3",
            Authorization:
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
          "Zerodha quote API error " +
            response.status +
            ": " +
            JSON.stringify(data)
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 6. ZERODHA INSTRUMENTS
  // --------------------------------------------------

  server.tool(
    "zerodha_instruments",
    "Download and parse the Zerodha NFO instrument master.",
    {},
    async () => {
      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                count:
                  instruments.length,
                data: instruments,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 7. ZERODHA OPTION CHAIN
  // --------------------------------------------------

  server.tool(
    "zerodha_option_chain",
    "Build a Zerodha NIFTY or BANKNIFTY option chain around ATM for a selected expiry.",
    {
      underlying: z.enum([
        "NIFTY",
        "BANKNIFTY",
      ]),

      expiry: z
        .string()
        .optional(),

      strikes_each_side: z
        .number()
        .int()
        .min(5)
        .max(50)
        .optional(),
    },
    async ({
      underlying,
      expiry,
      strikes_each_side = 10,
    }) => {
      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      const spotSymbol =
        getSpotSymbol(underlying);

      const spotResponse =
        await zerodhaGet(
          env,
          "/quote",
          {
            i: spotSymbol,
          }
        );

      const spot =
        spotResponse?.data?.[
          spotSymbol
        ]?.last_price;

      if (
        typeof spot !== "number"
      ) {
        throw new Error(
          `Unable to obtain spot price for ${underlying}.`
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

      const selectedExpiry =
        selectExpiry(
          contracts,
          expiry
        );

      const expiryContracts =
        contracts.filter(
          (x) =>
            x.expiry ===
            selectedExpiry
        );

      const strikes = Array.from(
        new Set(
          expiryContracts
            .map((x) =>
              Number(x.strike)
            )
            .filter(Number.isFinite)
        )
      ).sort(
        (a, b) => a - b
      );

      if (strikes.length === 0) {
        throw new Error(
          "No strikes found for selected expiry."
        );
      }

      let atm =
        strikes.reduce(
          (
            closest,
            strike
          ) =>
            Math.abs(
              strike - spot
            ) <
            Math.abs(
              closest - spot
            )
              ? strike
              : closest,
          strikes[0]
        );

      const atmIndex =
        strikes.indexOf(atm);

      const selectedStrikes =
        strikes.slice(
          Math.max(
            0,
            atmIndex -
              strikes_each_side
          ),
          Math.min(
            strikes.length,
            atmIndex +
              strikes_each_side +
              1
          )
        );

      const selectedContracts =
        expiryContracts.filter(
          (x) =>
            selectedStrikes.includes(
              Number(x.strike)
            )
        );

      const query =
        new URLSearchParams();

      selectedContracts.forEach(
        (contract) => {
          query.append(
            "i",
            `NFO:${contract.tradingsymbol}`
          );
        }
      );

      const accessToken =
        await getZerodhaAccessToken(
          env
        );

      const quoteResponse =
        await fetch(
          "https://api.kite.trade/quote?" +
            query.toString(),
          {
            method: "GET",
            headers: {
              "X-Kite-Version": "3",
              Authorization:
                "token " +
                env.ZERODHA_API_KEY +
                ":" +
                accessToken,
            },
          }
        );

      const quoteData =
        await quoteResponse.json();

      if (!quoteResponse.ok) {
        throw new Error(
          "Zerodha option quote API error " +
            quoteResponse.status +
            ": " +
            JSON.stringify(
              quoteData
            )
        );
      }

      const chain =
        selectedStrikes.map(
          (strike) => {
            const ce =
              selectedContracts.find(
                (x) =>
                  Number(
                    x.strike
                  ) === strike &&
                  x.instrument_type ===
                    "CE"
              );

            const pe =
              selectedContracts.find(
                (x) =>
                  Number(
                    x.strike
                  ) === strike &&
                  x.instrument_type ===
                    "PE"
              );

            const ceQuote =
              ce
                ? quoteData?.data?.[
                    `NFO:${ce.tradingsymbol}`
                  ]
                : null;

            const peQuote =
              pe
                ? quoteData?.data?.[
                    `NFO:${pe.tradingsymbol}`
                  ]
                : null;

            const ceBid =
              ceQuote?.depth?.buy?.[0]
                ?.price ??
              null;

            const ceAsk =
              ceQuote?.depth?.sell?.[0]
                ?.price ??
              null;

            const peBid =
              peQuote?.depth?.buy?.[0]
                ?.price ??
              null;

            const peAsk =
              peQuote?.depth?.sell?.[0]
                ?.price ??
              null;

            return {
              strike,

              ce: ce
                ? {
                    symbol:
                      ce.tradingsymbol,
                    instrument_token:
                      Number(
                        ce.instrument_token
                      ),
                    ltp:
                      ceQuote?.last_price ??
                      null,
                    bid: ceBid,
                    bid_quantity:
                      ceQuote?.depth?.buy?.[0]
                        ?.quantity ??
                      null,
                    ask: ceAsk,
                    ask_quantity:
                      ceQuote?.depth?.sell?.[0]
                        ?.quantity ??
                      null,
                    bid_ask_spread:
                      ceBid !== null &&
                      ceAsk !== null
                        ? Number(
                            (
                              ceAsk -
                              ceBid
                            ).toFixed(2)
                          )
                        : null,
                    oi:
                      ceQuote?.oi ??
                      null,
                    volume:
                      ceQuote?.volume ??
                      null,
                    oi_day_high:
                      ceQuote?.oi_day_high ??
                      null,
                    oi_day_low:
                      ceQuote?.oi_day_low ??
                      null,
                    net_change:
                      ceQuote?.net_change ??
                      null,
                  }
                : null,

              pe: pe
                ? {
                    symbol:
                      pe.tradingsymbol,
                    instrument_token:
                      Number(
                        pe.instrument_token
                      ),
                    ltp:
                      peQuote?.last_price ??
                      null,
                    bid: peBid,
                    bid_quantity:
                      peQuote?.depth?.buy?.[0]
                        ?.quantity ??
                      null,
                    ask: peAsk,
                    ask_quantity:
                      peQuote?.depth?.sell?.[0]
                        ?.quantity ??
                      null,
                    bid_ask_spread:
                      peBid !== null &&
                      peAsk !== null
                        ? Number(
                            (
                              peAsk -
                              peBid
                            ).toFixed(2)
                          )
                        : null,
                    oi:
                      peQuote?.oi ??
                      null,
                    volume:
                      peQuote?.volume ??
                      null,
                    oi_day_high:
                      peQuote?.oi_day_high ??
                      null,
                    oi_day_low:
                      peQuote?.oi_day_low ??
                      null,
                    net_change:
                      peQuote?.net_change ??
                      null,
                  }
                : null,
            };
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                underlying,
                spot,
                expiry:
                  selectedExpiry,
                atm,
                strikes_each_side,
                contracts:
                  selectedContracts.length,
                chain,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 8. ZERODHA OPTION ANALYSIS
  // --------------------------------------------------

  server.tool(
    "zerodha_option_analysis",
    "Analyse NIFTY or BANKNIFTY option contracts around ATM, including moneyness, OTM percentage, distance from spot, intrinsic value, time value, OI and bid/ask.",
    {
      underlying: z.enum([
        "NIFTY",
        "BANKNIFTY",
      ]),

      expiry: z
        .string()
        .optional(),

      strikes_each_side: z
        .number()
        .int()
        .min(5)
        .max(50)
        .optional(),
    },
    async ({
      underlying,
      expiry,
      strikes_each_side = 10,
    }) => {
      const instruments =
        await getNfoInstrumentMaster(
          env
        );

      const spotSymbol =
        getSpotSymbol(underlying);

      const spotResponse =
        await zerodhaGet(
          env,
          "/quote",
          {
            i: spotSymbol,
          }
        );

      const spot =
        spotResponse?.data?.[
          spotSymbol
        ]?.last_price;

      if (
        typeof spot !== "number"
      ) {
        throw new Error(
          `Unable to obtain spot price for ${underlying}.`
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

      const selectedExpiry =
        selectExpiry(
          contracts,
          expiry
        );

      const dte =
        getDte(
          selectedExpiry
        );

      const expiryContracts =
        contracts.filter(
          (x) =>
            x.expiry ===
            selectedExpiry
        );

      const strikes = Array.from(
        new Set(
          expiryContracts
            .map((x) =>
              Number(x.strike)
            )
            .filter(Number.isFinite)
        )
      ).sort(
        (a, b) => a - b
      );

      const atm =
        strikes.reduce(
          (
            closest,
            strike
          ) =>
            Math.abs(
              strike - spot
            ) <
            Math.abs(
              closest - spot
            )
              ? strike
              : closest,
          strikes[0]
        );

      const atmIndex =
        strikes.indexOf(atm);

      const selectedStrikes =
        strikes.slice(
          Math.max(
            0,
            atmIndex -
              strikes_each_side
          ),
          Math.min(
            strikes.length,
            atmIndex +
              strikes_each_side +
              1
          )
        );

      const selectedContracts =
        expiryContracts.filter(
          (x) =>
            selectedStrikes.includes(
              Number(x.strike)
            )
        );

      const query =
        new URLSearchParams();

      selectedContracts.forEach(
        (contract) => {
          query.append(
            "i",
            `NFO:${contract.tradingsymbol}`
          );
        }
      );

      const accessToken =
        await getZerodhaAccessToken(
          env
        );

      const quoteResponse =
        await fetch(
          "https://api.kite.trade/quote?" +
            query.toString(),
          {
            method: "GET",
            headers: {
              "X-Kite-Version": "3",
              Authorization:
                "token " +
                env.ZERODHA_API_KEY +
                ":" +
                accessToken,
            },
          }
        );

      const quoteData =
        await quoteResponse.json();

      if (!quoteResponse.ok) {
        throw new Error(
          "Zerodha option quote API error " +
            quoteResponse.status +
            ": " +
            JSON.stringify(
              quoteData
            )
        );
      }

      const analysis =
        selectedContracts.map(
          (contract) => {
            const symbol =
              `NFO:${contract.tradingsymbol}`;

            return analyseOption(
              quoteData?.data?.[
                symbol
              ],
              contract,
              spot,
              atm
            );
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                underlying,
                spot,
                expiry:
                  selectedExpiry,
                dte,
                atm,
                strikes_each_side,
                contracts:
                  selectedContracts.length,
                options:
                  analysis,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 9. ZERODHA CREDIT SPREAD
  // --------------------------------------------------

  server.tool(
    "zerodha_credit_spread",
    "Analyse a defined-risk NIFTY or BANKNIFTY bull put spread or bear call spread using executable bid/ask prices. Read-only: does not place orders.",
    {
      underlying: z.enum([
        "NIFTY",
        "BANKNIFTY",
      ]),

      expiry: z
        .string()
        .optional(),

      strategy: z.enum([
        "BPS",
        "BCS",
      ]),

      short_strike: z
        .number()
        .positive(),

      spread_width: z
        .number()
        .positive(),

      lots: z
        .number()
        .int()
        .positive(),
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
        getSpotSymbol(underlying);

      const spotResponse =
        await zerodhaGet(
          env,
          "/quote",
          {
            i: spotSymbol,
          }
        );

      const spot =
        spotResponse?.data?.[
          spotSymbol
        ]?.last_price;

      if (
        typeof spot !== "number"
      ) {
        throw new Error(
          `Unable to obtain spot price for ${underlying}.`
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

      const selectedExpiry =
        selectExpiry(
          contracts,
          expiry
        );

      const dte =
        getDte(
          selectedExpiry
        );

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
                  Number.isFinite(x) &&
                  x > 0
              )
          )
        );

      if (
        lotSizes.length === 0
      ) {
        throw new Error(
          "Unable to determine lot size from the Zerodha instrument master."
        );
      }

      if (
        lotSizes.length > 1
      ) {
        throw new Error(
          `Multiple lot sizes found for ${underlying}: ${lotSizes.join(", ")}`
        );
      }

      const lotSize =
        lotSizes[0];

      const quantity =
        lots * lotSize;

      let longStrike: number;
      let optionType:
        | "CE"
        | "PE";

      if (strategy === "BPS") {
        optionType = "PE";
        longStrike =
          short_strike -
          spread_width;
      } else {
        optionType = "CE";
        longStrike =
          short_strike +
          spread_width;
      }

      const shortContract =
        expiryContracts.find(
          (x) =>
            Number(x.strike) ===
              short_strike &&
            x.instrument_type ===
              optionType
        );

      const longContract =
        expiryContracts.find(
          (x) =>
            Number(x.strike) ===
              longStrike &&
            x.instrument_type ===
              optionType
        );

      if (!shortContract) {
        throw new Error(
          `Short ${optionType} contract not found at strike ${short_strike} for expiry ${selectedExpiry}.`
        );
      }

      if (!longContract) {
        throw new Error(
          `Long ${optionType} contract not found at strike ${longStrike} for expiry ${selectedExpiry}.`
        );
      }

      const query =
        new URLSearchParams();

      query.append(
        "i",
        `NFO:${shortContract.tradingsymbol}`
      );

      query.append(
        "i",
        `NFO:${longContract.tradingsymbol}`
      );

      if (!env.ZERODHA_API_KEY) {
        throw new Error(
          "ZERODHA_API_KEY secret is not configured."
        );
      }

      const accessToken =
        await getZerodhaAccessToken(
          env
        );

      const quoteResponse =
        await fetch(
          "https://api.kite.trade/quote?" +
            query.toString(),
          {
            method: "GET",
            headers: {
              "X-Kite-Version": "3",
              Authorization:
                "token " +
                env.ZERODHA_API_KEY +
                ":" +
                accessToken,
            },
          }
        );

      const quoteData =
        await quoteResponse.json();

      if (!quoteResponse.ok) {
        throw new Error(
          "Zerodha credit spread quote API error " +
            quoteResponse.status +
            ": " +
            JSON.stringify(
              quoteData
            )
        );
      }

      const shortSymbol =
        `NFO:${shortContract.tradingsymbol}`;

      const longSymbol =
        `NFO:${longContract.tradingsymbol}`;

      const shortQuote =
        quoteData?.data?.[
          shortSymbol
        ];

      const longQuote =
        quoteData?.data?.[
          longSymbol
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

      // ------------------------------------------------
      // Executable credit
      //
      // Short leg is sold at bid.
      // Long leg is bought at ask.
      // ------------------------------------------------

      const executableCredit =
        shortBid !== null &&
        longAsk !== null &&
        shortBid > 0 &&
        longAsk > 0
          ? shortBid - longAsk
          : null;

      // LTP-based indicative credit is shown
      // separately and is NOT treated as executable.
      const indicativeCredit =
        shortLtp !== null &&
        longLtp !== null
          ? shortLtp - longLtp
          : null;

      const maxProfitPerUnit =
        executableCredit !== null &&
        executableCredit > 0
          ? executableCredit
          : null;

      const maxLossPerUnit =
        maxProfitPerUnit !== null
          ? spread_width -
            maxProfitPerUnit
          : null;

      let breakeven: number | null =
        null;

      let beDistance: number | null =
        null;

      let beDistancePct:
        | number
        | null = null;

      if (
        maxProfitPerUnit !== null
      ) {
        if (strategy === "BPS") {
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
          (beDistance / spot) *
          100;
      }

      const maxProfitTotal =
        maxProfitPerUnit !== null
          ? maxProfitPerUnit *
            quantity
          : null;

      const maxLossTotal =
        maxLossPerUnit !== null
          ? maxLossPerUnit *
            quantity
          : null;

      const roiPct =
        maxLossPerUnit !== null &&
        maxLossPerUnit > 0 &&
        maxProfitPerUnit !== null
          ? (maxProfitPerUnit /
              maxLossPerUnit) *
            100
          : null;

      const shortStrikeDistance =
        strategy === "BPS"
          ? spot -
            short_strike
          : short_strike -
            spot;

      const shortStrikeDistancePct =
        (shortStrikeDistance /
          spot) *
        100;

      const shortBidQuantity =
        shortQuote?.depth?.buy?.[0]
          ?.quantity ??
        null;

      const shortAskQuantity =
        shortQuote?.depth?.sell?.[0]
          ?.quantity ??
        null;

      const longBidQuantity =
        longQuote?.depth?.buy?.[0]
          ?.quantity ??
        null;

      const longAskQuantity =
        longQuote?.depth?.sell?.[0]
          ?.quantity ??
        null;

      const shortSpread =
        shortBid !== null &&
        shortAsk !== null &&
        shortBid > 0 &&
        shortAsk > 0
          ? shortAsk -
            shortBid
          : null;

      const longSpread =
        longBid !== null &&
        longAsk !== null &&
        longBid > 0 &&
        longAsk > 0
          ? longAsk -
            longBid
          : null;

      const validExecutableCredit =
        executableCredit !== null &&
        executableCredit > 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",

                underlying,

                spot:
                  round2(spot),

                expiry:
                  selectedExpiry,

                dte,

                strategy,

                option_type:
                  optionType,

                short_strike,

                long_strike:
                  longStrike,

                spread_width,

                lot_size:
                  lotSize,

                lots,

                quantity,

                short_leg: {
                  symbol:
                    shortContract.tradingsymbol,

                  strike:
                    short_strike,

                  side: "SELL",

                  ltp:
                    round2(
                      shortLtp
                    ),

                  bid:
                    round2(
                      shortBid
                    ),

                  bid_quantity:
                    shortBidQuantity,

                  ask:
                    round2(
                      shortAsk
                    ),

                  ask_quantity:
                    shortAskQuantity,

                  bid_ask_spread:
                    round2(
                      shortSpread
                    ),

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

                  strike:
                    longStrike,

                  side: "BUY",

                  ltp:
                    round2(
                      longLtp
                    ),

                  bid:
                    round2(
                      longBid
                    ),

                  bid_quantity:
                    longBidQuantity,

                  ask:
                    round2(
                      longAsk
                    ),

                  ask_quantity:
                    longAskQuantity,

                  bid_ask_spread:
                    round2(
                      longSpread
                    ),

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
                    validExecutableCredit,

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
                      roiPct
                    ),
                },

                liquidity: {
                  short_leg_bid_quantity:
                    shortBidQuantity,

                  short_leg_ask_quantity:
                    shortAskQuantity,

                  long_leg_bid_quantity:
                    longBidQuantity,

                  long_leg_ask_quantity:
                    longAskQuantity,

                  sufficient_live_depth:
                    shortBid !== null &&
                    longAsk !== null &&
                    shortBid > 0 &&
                    longAsk > 0,
                },

                read_only: true,

                note:
                  "This tool analyses the spread only. It does not place, modify or cancel any Zerodha order.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 10. ZERODHA POSITIONS
  // --------------------------------------------------

  server.tool(
    "zerodha_positions",
    "Read current Zerodha positions.",
    {},
    async () => {
      const data =
        await zerodhaGet(
          env,
          "/portfolio/positions"
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 11. ZERODHA HOLDINGS
  // --------------------------------------------------

  server.tool(
    "zerodha_holdings",
    "Read current Zerodha holdings.",
    {},
    async () => {
      const data =
        await zerodhaGet(
          env,
          "/portfolio/holdings"
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 12. ZERODHA ORDERS
  // --------------------------------------------------

  server.tool(
    "zerodha_orders",
    "Read all current Zerodha orders for today.",
    {},
    async () => {
      const data =
        await zerodhaGet(
          env,
          "/orders"
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 13. ZERODHA TRADES
  // --------------------------------------------------

  server.tool(
    "zerodha_trades",
    "Read all executed Zerodha trades for today.",
    {},
    async () => {
      const data =
        await zerodhaGet(
          env,
          "/trades"
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --------------------------------------------------
  // 14. ZERODHA ORDER HISTORY
  // --------------------------------------------------

  server.tool(
    "zerodha_order_history",
    "Read the order history for a specific Zerodha order.",
    {
      order_id: z
        .string()
        .min(1),
    },
    async ({
      order_id,
    }) => {
      const data =
        await zerodhaGet(
          env,
          `/orders/${encodeURIComponent(
            order_id
          )}`
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data,
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

// --------------------------------------------------
// WORKER ENTRY POINT
// --------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url =
      new URL(request.url);

    if (
      url.pathname ===
      "/login"
    ) {
      return handleZerodhaLogin(
        request,
        env
      );
    }

    if (
      url.pathname ===
      "/callback"
    ) {
      return handleZerodhaCallback(
        request,
        env
      );
    }

    const server =
      createServer(env);

    const handler =
      createMcpHandler(
        server
      );

    return handler(
      request
    );
  },
};

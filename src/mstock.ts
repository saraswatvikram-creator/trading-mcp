import { z } from "zod";

type MStockEnv = {
  MSTOCK_API_KEY?: string;
  MSTOCK_USERNAME?: string;
  MSTOCK_PASSWORD?: string;
  MSTOCK_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
};

const MSTOCK_BASE_URL = "https://api.mstock.trade";
const MSTOCK_VERSION = "1";

function requireMStockConfig(env: MStockEnv): {
  apiKey: string;
  username: string;
  password: string;
} {
  const apiKey = env.MSTOCK_API_KEY?.trim();
  const username = env.MSTOCK_USERNAME?.trim();
  const password = env.MSTOCK_PASSWORD ?? "";

  if (!apiKey || !username || !password) {
    throw new Error(
      "m.Stock configuration is incomplete. Required Cloudflare secrets: " +
      "MSTOCK_API_KEY, MSTOCK_USERNAME, MSTOCK_PASSWORD. " +
      "This integration uses m.Stock Type A with normal OTP authentication; TOTP is not used."
    );
  }

  return { apiKey, username, password };
}

function tokenStore(env: MStockEnv): KVNamespace | null {
  return env.ZERODHA_TOKEN_STORE ?? null;
}

async function getStoredAccessToken(env: MStockEnv): Promise<string | null> {
  const stored = await tokenStore(env)?.get("mstock_access_token");
  if (stored?.trim()) return stored.trim();

  return env.MSTOCK_ACCESS_TOKEN?.trim() || null;
}

async function getStoredLoginTime(env: MStockEnv): Promise<string | null> {
  return (await tokenStore(env)?.get("mstock_login_time")) ?? null;
}

async function storeMStockSession(
  env: MStockEnv,
  accessToken: string,
  loginTime: string
): Promise<void> {
  const store = tokenStore(env);

  if (store) {
    await store.put("mstock_access_token", accessToken);
    await store.put("mstock_login_time", loginTime);
  }
}

function decodeJwtExpiry(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;

    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));

    return typeof payload.exp === "number"
      ? new Date(payload.exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

function inferredMidnightExpiry(loginTime: string | null): string | null {
  if (!loginTime) return null;

  // m.Stock login_time is documented as an IST clock value such as
  // "2024-09-26 03:34:48". Parse it explicitly as Asia/Kolkata.
  const match = loginTime.match(
    /^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})$/
  );

  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}+05:30`
  );

  if (Number.isNaN(parsed.getTime())) return null;

  // Type A access tokens are documented as valid until midnight
  // of the generated day. The next midnight in IST is 18:30 UTC.
  const expiry = new Date(parsed);
  expiry.setUTCHours(18, 30, 0, 0);

  if (expiry.getTime() <= parsed.getTime()) {
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }

  return expiry.toISOString();
}

function tokenExpiry(token: string | null, loginTime: string | null): string | null {
  if (!token) return null;
  return decodeJwtExpiry(token) ?? inferredMidnightExpiry(loginTime);
}

async function mStockPostForm(
  path: string,
  body: Record<string, string>
): Promise<any> {
  const response = await fetch(MSTOCK_BASE_URL + path, {
    method: "POST",
    headers: {
      "X-Mirae-Version": MSTOCK_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "m.Stock API returned non-JSON response (" +
        response.status +
        "): " +
        text.slice(0, 500)
    );
  }

  if (!response.ok || String(data?.status ?? "").toLowerCase() === "error") {
    throw new Error(
      "m.Stock API error " +
        response.status +
        ": " +
        JSON.stringify(data)
    );
  }

  return data;
}

async function mStockGet(
  path: string,
  apiKey: string,
  accessToken: string
): Promise<any> {
  const response = await fetch(MSTOCK_BASE_URL + path, {
    method: "GET",
    headers: {
      "X-Mirae-Version": MSTOCK_VERSION,
      Authorization: "token " + apiKey + ":" + accessToken,
    },
  });

  const text = await response.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "m.Stock API returned non-JSON response (" +
        response.status +
        "): " +
        text.slice(0, 500)
    );
  }

  if (!response.ok || String(data?.status ?? "").toLowerCase() === "error") {
    const message = String(data?.message ?? "Unknown m.Stock API error");

    if (response.status === 401 || /token|session|authentication/i.test(message)) {
      throw new Error("MSTOCK_AUTH_EXPIRED: " + message);
    }

    throw new Error(
      "m.Stock API error " +
        response.status +
        ": " +
        JSON.stringify(data)
    );
  }

  return data;
}

async function sendMStockOtp(env: MStockEnv): Promise<any> {
  const { username, password } = requireMStockConfig(env);

  const data = await mStockPostForm(
    "/openapi/typea/connect/login",
    {
      username,
      password,
    }
  );

  return {
    status: "OTP_SENT",
    auth_mode: "TYPE_A_NORMAL_OTP",
    message:
      "m.Stock accepted the credentials and sent a normal OTP to the registered mobile number. TOTP is not used.",
    broker_response: {
      status: data?.status ?? null,
      client_id: data?.data?.cid ?? null,
      name: data?.data?.nm ?? null,
    },
    read_only: true,
  };
}

async function completeMStockOtpLogin(
  env: MStockEnv,
  otp: string
): Promise<any> {
  const { apiKey } = requireMStockConfig(env);

  const cleanOtp = otp.trim();

  if (!/^\d{6}$/.test(cleanOtp)) {
    throw new Error("m.Stock OTP must be exactly 6 digits.");
  }

  const data = await mStockPostForm(
    "/openapi/typea/session/token",
    {
      api_key: apiKey,
      request_token: cleanOtp,
      checksum: "L",
    }
  );

  const accessToken = String(data?.data?.access_token ?? "").trim();

  if (!accessToken) {
    throw new Error(
      "m.Stock OTP was accepted but no access_token was returned."
    );
  }

  const loginTime =
    String(data?.data?.login_time ?? new Date().toISOString());

  await storeMStockSession(env, accessToken, loginTime);

  return {
    status: "CONNECTED",
    auth_mode: "TYPE_A_NORMAL_OTP",
    login_time: loginTime,
    token_expiry: tokenExpiry(accessToken, loginTime),
    client_id: data?.data?.user_id ?? null,
    user_name: data?.data?.user_name ?? null,
    read_only: true,
  };
}

function normalizePosition(row: any): any {
  const quantity = Number(row?.quantity ?? 0);
  const averagePrice = Number(row?.average_price ?? 0);
  const lastPrice = Number(row?.last_price ?? 0);
  const brokerUnrealised = Number(row?.unrealised);
  const brokerRealised = Number(row?.realised);

  let calculatedUnrealised: number | null = null;

  if (
    Number.isFinite(quantity) &&
    Number.isFinite(averagePrice) &&
    Number.isFinite(lastPrice)
  ) {
    calculatedUnrealised =
      quantity >= 0
        ? (lastPrice - averagePrice) * quantity
        : (averagePrice - lastPrice) * Math.abs(quantity);
  }

  const unrealised = Number.isFinite(brokerUnrealised)
    ? brokerUnrealised
    : calculatedUnrealised;

  return {
    trading_symbol: row?.tradingsymbol ?? null,
    exchange: row?.exchange ?? null,
    instrument_token: row?.instrument_token ?? null,
    product: row?.product ?? null,
    instrument_type: row?.instrument_type ?? null,
    expiry: row?.expiry ?? null,
    strike: row?.strike ?? null,
    option_type: row?.option_type ?? null,
    quantity,
    average_price: Number.isFinite(averagePrice) ? averagePrice : null,
    last_price: Number.isFinite(lastPrice) ? lastPrice : null,
    unrealised_pnl: unrealised,
    realised_pnl: Number.isFinite(brokerRealised) ? brokerRealised : null,
    m2m: Number.isFinite(Number(row?.m2m)) ? Number(row.m2m) : null,
    day_buy_quantity: Number(row?.day_buy_quantity ?? 0),
    day_sell_quantity: Number(row?.day_sell_quantity ?? 0),
    source: "m.Stock Type A live positions API",
  };
}

async function getMStockPositions(env: MStockEnv): Promise<{
  accessToken: string;
  tokenExpiry: string | null;
  allPositions: any[];
  openPositions: any[];
  raw: any;
}> {
  const { apiKey } = requireMStockConfig(env);
  const accessToken = await getStoredAccessToken(env);

  if (!accessToken) {
    throw new Error(
      "MSTOCK_AUTH_REQUIRED: No m.Stock access token is stored. " +
      "Run mstock_login without an OTP to send the normal OTP, then run mstock_login with the 6-digit OTP."
    );
  }

  const loginTime = await getStoredLoginTime(env);
  const response = await mStockGet(
    "/openapi/typea/portfolio/positions",
    apiKey,
    accessToken
  );

  const net = Array.isArray(response?.data?.net)
    ? response.data.net
    : [];

  const allPositions = net.map(normalizePosition);
  const openPositions = allPositions.filter(
    (row: any) => Number(row.quantity) !== 0
  );

  return {
    accessToken,
    tokenExpiry: tokenExpiry(accessToken, loginTime),
    allPositions,
    openPositions,
    raw: response,
  };
}

function dashboardText(
  openPositions: any[],
  totalUnrealised: number,
  totalRealised: number,
  tokenExpiry: string | null
): string {
  const lines = [
    "## m.Stock Live Positions",
    "",
    "| Metric | Value |",
    "|---|---:|",
    "| Connection | LIVE |",
    "| Auth | Type A / normal OTP |",
    "| Open positions | " + openPositions.length + " |",
    "| Live unrealised P&L | ₹" + totalUnrealised.toFixed(2) + " |",
    "| Realised P&L returned by broker | ₹" + totalRealised.toFixed(2) + " |",
    "| Access-token expiry | " + (tokenExpiry ?? "unknown") + " |",
    "",
    "| Symbol | Qty | Avg | LTP | Unrealised |",
    "|---|---:|---:|---:|---:|",
  ];

  if (openPositions.length === 0) {
    lines.push("| — | 0 | — | — | ₹0.00 |");
  } else {
    for (const row of openPositions) {
      lines.push(
        "| " +
          String(row.trading_symbol ?? "—") +
          " | " +
          String(row.quantity) +
          " | " +
          (row.average_price == null ? "—" : "₹" + Number(row.average_price).toFixed(2)) +
          " | " +
          (row.last_price == null ? "—" : "₹" + Number(row.last_price).toFixed(2)) +
          " | " +
          (row.unrealised_pnl == null ? "—" : "₹" + Number(row.unrealised_pnl).toFixed(2)) +
          " |"
      );
    }
  }

  return lines.join("\n");
}

export function registerMStockTools(server: any, env: MStockEnv): void {
  server.registerTool(
    "mstock_auth_status",
    {
      description:
        "Check m.Stock Type A configuration and stored session state. Read-only. TOTP is not used.",
    },
    async () => {
      const configured = Boolean(
        env.MSTOCK_API_KEY?.trim() &&
        env.MSTOCK_USERNAME?.trim() &&
        env.MSTOCK_PASSWORD
      );

      const accessToken = await getStoredAccessToken(env);
      const loginTime = await getStoredLoginTime(env);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: configured ? "CONFIGURED" : "CONFIG_REQUIRED",
                auth_mode: "TYPE_A_NORMAL_OTP",
                totp: false,
                credentials_configured: configured,
                access_token_stored: Boolean(accessToken),
                token_expiry: tokenExpiry(accessToken, loginTime),
                read_only: true,
                note:
                  "m.Stock Type A uses the normal OTP session endpoint. " +
                  "The TOTP endpoint is intentionally not used.",
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

  server.registerTool(
    "mstock_login",
    {
      description:
        "Authenticate m.Stock Type A without TOTP. Call with no OTP to send the normal SMS/email OTP; call again with the 6-digit OTP to create and persist the access token. Read-only.",
      inputSchema: {
        otp: z.string().regex(/^\d{6}$/).optional(),
      },
    },
    async ({ otp }) => {
      if (!otp) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await sendMStockOtp(env), null, 2),
              type: "text",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await completeMStockOtpLogin(env, otp),
              null,
              2
            ),
            type: "text",
          },
        ],
      };
    }
  );

  server.registerTool(
    "mstock_positions",
    {
      description:
        "Return current live m.Stock Type A F&O/net positions using the stored access token. If the token is missing or expired, return a clear authentication-required state. Read-only; never places or modifies orders.",
    },
    async () => {
      try {
        const result = await getMStockPositions(env);

        const totalUnrealised = result.openPositions.reduce(
          (sum: number, row: any) =>
            sum +
            (Number.isFinite(Number(row.unrealised_pnl))
              ? Number(row.unrealised_pnl)
              : 0),
          0
        );

        const totalRealised = result.allPositions.reduce(
          (sum: number, row: any) =>
            sum +
            (Number.isFinite(Number(row.realised_pnl))
              ? Number(row.realised_pnl)
              : 0),
          0
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "LIVE",
                  broker: "m.Stock",
                  auth_mode: "TYPE_A_NORMAL_OTP",
                  open_positions: result.openPositions,
                  all_net_positions: result.allPositions,
                  live_unrealised_pnl: Number(totalUnrealised.toFixed(2)),
                  realised_pnl: Number(totalRealised.toFixed(2)),
                  token_expiry: result.tokenExpiry,
                  source: "m.Stock Type A positions API",
                  read_only: true,
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.startsWith("MSTOCK_AUTH_REQUIRED:")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "AUTH_REQUIRED",
                    broker: "m.Stock",
                    auth_mode: "TYPE_A_NORMAL_OTP",
                    totp: false,
                    message: message.replace("MSTOCK_AUTH_REQUIRED: ", ""),
                    next_step:
                      "Run mstock_login with no OTP to send the normal OTP, then run mstock_login with the 6-digit OTP.",
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

        if (message.startsWith("MSTOCK_AUTH_EXPIRED:")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "AUTH_EXPIRED",
                    broker: "m.Stock",
                    auth_mode: "TYPE_A_NORMAL_OTP",
                    totp: false,
                    message: message.replace("MSTOCK_AUTH_EXPIRED: ", ""),
                    next_step:
                      "Run mstock_login with no OTP to request a fresh normal OTP, then run mstock_login with the 6-digit OTP.",
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

        throw error;
      }
    }
  );

  server.registerTool(
    "mstock_dashboard",
    {
      description:
        "Return a concise live m.Stock dashboard with open positions, live unrealised P&L, realised P&L and session status. Read-only; no order placement or broker control.",
    },
    async () => {
      try {
        const result = await getMStockPositions(env);

        const totalUnrealised = result.openPositions.reduce(
        (sum: number, row: any) =>
          sum +
          (Number.isFinite(Number(row.unrealised_pnl))
            ? Number(row.unrealised_pnl)
            : 0),
        0
      );

      const totalRealised = result.allPositions.reduce(
        (sum: number, row: any) =>
          sum +
          (Number.isFinite(Number(row.realised_pnl))
            ? Number(row.realised_pnl)
            : 0),
        0
      );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "LIVE",
                  broker: "m.Stock",
                  dashboard: dashboardText(
                    result.openPositions,
                    Number(totalUnrealised),
                    Number(totalRealised),
                    result.tokenExpiry
                  ),
                  positions: result.openPositions,
                  live_unrealised_pnl: Number(totalUnrealised.toFixed(2)),
                  realised_pnl: Number(totalRealised.toFixed(2)),
                  token_expiry: result.tokenExpiry,
                  read_only: true,
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status:
                    message.startsWith("MSTOCK_AUTH_")
                      ? "AUTH_REQUIRED"
                      : "ERROR",
                  broker: "m.Stock",
                  auth_mode: "TYPE_A_NORMAL_OTP",
                  totp: false,
                  message: message.replace(/^MSTOCK_AUTH_(REQUIRED|EXPIRED):\\s*/, ""),
                  next_step:
                    "If authentication is required, run mstock_login with no OTP to send a normal OTP, then run mstock_login with the 6-digit OTP.",
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
    }
  );

  server.registerTool(
    "mstock_self_test",
    {
      description:
        "Run a read-only m.Stock Type A integration self-test: configuration, authentication and live positions. TOTP is never used.",
    },
    async () => {
      const configured = Boolean(
        env.MSTOCK_API_KEY?.trim() &&
        env.MSTOCK_USERNAME?.trim() &&
        env.MSTOCK_PASSWORD
      );

      const checks: Record<string, string> = {
        configuration: configured ? "PASS" : "FAIL",
      };
      const errors: Record<string, string> = {};

      if (!configured) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "FAIL",
                  auth_mode: "TYPE_A_NORMAL_OTP",
                  checks,
                  errors: {
                    configuration:
                      "Missing MSTOCK_API_KEY, MSTOCK_USERNAME or MSTOCK_PASSWORD.",
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

      const accessToken = await getStoredAccessToken(env);
      checks.access_token = accessToken ? "PASS" : "FAIL";

      if (!accessToken) {
        errors.access_token =
          "No stored m.Stock access token. Run mstock_login without OTP, then with the 6-digit OTP.";
      } else {
        try {
          const result = await getMStockPositions(env);
          checks.positions = "PASS";
          checks.live_data = result.openPositions.length >= 0 ? "PASS" : "FAIL";
        } catch (error) {
          checks.positions = "FAIL";
          errors.positions =
            error instanceof Error ? error.message : String(error);
        }
      }

      const passed = Object.values(checks).filter((value) => value === "PASS").length;
      const total = Object.keys(checks).length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: passed === total ? "PASS" : "FAIL",
                auth_mode: "TYPE_A_NORMAL_OTP",
                totp: false,
                checks,
                passed,
                total,
                errors,
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
}

type FivePaisaEnv = {
  FIVEPAISA_API_KEY?: string;
  FIVEPAISA_ENCRYPTION_KEY?: string;
  FIVEPAISA_USER_ID?: string;
  FIVEPAISA_CLIENT_CODE?: string;
  FIVEPAISA_PIN?: string;
  FIVEPAISA_TOTP_SECRET?: string;
  FIVEPAISA_REDIRECT_URL?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
  FIVEPAISA_TOKEN_STORE?: KVNamespace;
};

const FIVEPAISA_OAUTH_URL =
  "https://dev-openapi.5paisa.com/WebVendorLogin/VLogin/Index";
const FIVEPAISA_ACCESS_TOKEN_URL =
  "https://Openapi.5paisa.com/VendorsAPI/Service1.svc/GetAccessToken";
const FIVEPAISA_TOTP_REQUEST_TOKEN_URL =
  "https://Openapi.5paisa.com/VendorsAPI/Service1.svc/TOTPLogin";
const FIVEPAISA_API_BASE =
  "https://Openapi.5paisa.com/VendorsAPI/Service1.svc";

// Public 5Paisa Xstream API gateway identifier used by the official SDK.
const FIVEPAISA_API_UID = "ka7SFqAU6SC";

const STORE_PREFIX = "fivepaisa:";
const ACCESS_TOKEN_KEY = STORE_PREFIX + "access_token";
const CLIENT_CODE_KEY = STORE_PREFIX + "client_code";
const LOGIN_TIME_KEY = STORE_PREFIX + "login_time";
const TOKEN_EXPIRY_KEY = STORE_PREFIX + "token_expiry";
const STATE_PREFIX = STORE_PREFIX + "oauth_state:";

function getStore(env: FivePaisaEnv): KVNamespace {
  const store = env.FIVEPAISA_TOKEN_STORE ?? env.ZERODHA_TOKEN_STORE;
  if (!store) {
    throw new Error(
      "No KV token store is configured. Reuse ZERODHA_TOKEN_STORE or configure FIVEPAISA_TOKEN_STORE."
    );
  }
  return store;
}

function requireFivePaisaConfig(env: FivePaisaEnv): void {
  const missing: string[] = [];
  if (!env.FIVEPAISA_API_KEY) missing.push("FIVEPAISA_API_KEY");
  if (!env.FIVEPAISA_ENCRYPTION_KEY) missing.push("FIVEPAISA_ENCRYPTION_KEY");
  if (!env.FIVEPAISA_USER_ID) missing.push("FIVEPAISA_USER_ID");
  if (missing.length > 0) {
    throw new Error(
      "5Paisa configuration is incomplete. Missing Cloudflare secrets: " +
        missing.join(", ")
    );
  }
}

function hasFivePaisaTotpConfig(env: FivePaisaEnv): boolean {
  return Boolean(
    env.FIVEPAISA_TOTP_SECRET &&
      env.FIVEPAISA_PIN &&
      (env.FIVEPAISA_CLIENT_CODE)
  );
}

function base32Decode(value: string): Uint8Array {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

async function generateTotp(secret: string, timestampMs = Date.now()): Promise<string> {
  const keyBytes = base32Decode(secret);
  if (keyBytes.length === 0) {
    throw new Error("FIVEPAISA_TOTP_SECRET is empty or invalid.");
  }

  const counter = Math.floor(timestampMs / 1000 / 30);
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterBytes)
  );
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, "0");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function getJwtExpiry(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}

async function getStoredFivePaisaSession(
  env: FivePaisaEnv
): Promise<{
  accessToken: string | null;
  clientCode: string | null;
  loginTime: string | null;
  tokenExpiry: string | null;
}> {
  const store = getStore(env);
  let accessToken = await store.get(ACCESS_TOKEN_KEY);
  let clientCode = await store.get(CLIENT_CODE_KEY);
  if (!accessToken || !clientCode) {
    // KV can briefly lag immediately after the OAuth callback writes the session.
    await new Promise((resolve) => setTimeout(resolve, 750));
    accessToken = await store.get(ACCESS_TOKEN_KEY);
    clientCode = await store.get(CLIENT_CODE_KEY);
  }
  const loginTime = await store.get(LOGIN_TIME_KEY);
  const tokenExpiry = await store.get(TOKEN_EXPIRY_KEY);

  if (
    accessToken &&
    tokenExpiry &&
    Date.now() >= new Date(tokenExpiry).getTime()
  ) {
    await clearFivePaisaSession(env);
    return {
      accessToken: null,
      clientCode: null,
      loginTime: null,
      tokenExpiry: null,
    };
  }

  return { accessToken, clientCode, loginTime, tokenExpiry };
}

async function clearFivePaisaSession(env: FivePaisaEnv): Promise<void> {
  const store = getStore(env);
  await Promise.all([
    store.delete(ACCESS_TOKEN_KEY),
    store.delete(LOGIN_TIME_KEY),
    store.delete(TOKEN_EXPIRY_KEY),
  ]);
}

async function createFivePaisaLoginUrl(
  env: FivePaisaEnv,
  baseUrl: string
): Promise<string> {
  requireFivePaisaConfig(env);

  const redirectUrl =
    env.FIVEPAISA_REDIRECT_URL ??
    new URL("/fivepaisa/callback", baseUrl).toString();

  const state = crypto.randomUUID();
  const store = getStore(env);

  await store.put(STATE_PREFIX + state, "pending", {
    expirationTtl: 600,
  });

  const url = new URL(FIVEPAISA_OAUTH_URL);
  url.searchParams.set("VendorKey", env.FIVEPAISA_API_KEY!);
  url.searchParams.set("ResponseURL", redirectUrl);
  url.searchParams.set("State", state);

  return url.toString();
}

async function authenticateFivePaisaWithTotp(
  env: FivePaisaEnv
): Promise<{
  accessToken: string;
  clientCode: string;
  tokenExpiry: string | null;
}> {
  requireFivePaisaConfig(env);

  if (!env.FIVEPAISA_TOTP_SECRET || !env.FIVEPAISA_PIN) {
    throw new Error(
      "5Paisa automatic TOTP authentication is not configured. Missing FIVEPAISA_TOTP_SECRET or FIVEPAISA_PIN."
    );
  }

  const store = getStore(env);
  const storedClientCode = await store.get(CLIENT_CODE_KEY);
  const clientCode = storedClientCode ?? env.FIVEPAISA_CLIENT_CODE;

  if (!clientCode) {
    throw new Error(
      "5Paisa automatic TOTP authentication is not configured. Set FIVEPAISA_CLIENT_CODE or complete one OAuth login first."
    );
  }

  const totp = await generateTotp(env.FIVEPAISA_TOTP_SECRET);
  const response = await fetch(FIVEPAISA_TOTP_REQUEST_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      head: {
        Key: env.FIVEPAISA_API_KEY,
      },
      body: {
        Email_ID: clientCode,
        TOTP: totp,
        PIN: env.FIVEPAISA_PIN,
      },
    }),
  });

  const data = await response.json();
  const status = data?.body?.Status;
  const requestToken = data?.body?.RequestToken;
  const message =
    data?.body?.Message ??
    data?.body?.StatusDescription ??
    data?.head?.StatusDescription ??
    "Unknown 5Paisa TOTP authentication response";

  if (!response.ok || status !== 0 || !requestToken) {
    throw new Error(
      "5Paisa TOTP request-token authentication failed: " +
        JSON.stringify({
          http_status: response.status,
          status,
          message,
        })
    );
  }

  const session = await exchangeFivePaisaRequestToken(env, requestToken);
  return {
    accessToken: session.accessToken,
    clientCode: session.clientCode,
    tokenExpiry: session.tokenExpiry,
  };
}

async function ensureFivePaisaSession(
  env: FivePaisaEnv,
  baseUrl: string
): Promise<{
  accessToken: string | null;
  clientCode: string | null;
  loginTime: string | null;
  tokenExpiry: string | null;
  authMode: "ACTIVE" | "AUTO_TOTP" | "OAUTH_REQUIRED";
}> {
  let session = await getStoredFivePaisaSession(env);

  if (session.accessToken && session.clientCode) {
    return {
      ...session,
      authMode: "ACTIVE",
    };
  }

  if (hasFivePaisaTotpConfig(env)) {
    const authenticated = await authenticateFivePaisaWithTotp(env);
    session = await getStoredFivePaisaSession(env);
    return {
      ...session,
      accessToken: authenticated.accessToken,
      clientCode: authenticated.clientCode,
      tokenExpiry: authenticated.tokenExpiry,
      authMode: "AUTO_TOTP",
    };
  }

  return {
    ...session,
    authMode: "OAUTH_REQUIRED",
  };
}

async function exchangeFivePaisaRequestToken(
  env: FivePaisaEnv,
  requestToken: string
): Promise<{
  accessToken: string;
  clientCode: string;
  tokenExpiry: string | null;
  response: unknown;
}> {
  requireFivePaisaConfig(env);

  const response = await fetch(FIVEPAISA_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      head: {
        Key: env.FIVEPAISA_API_KEY,
      },
      body: {
        RequestToken: requestToken,
        EncryKey: env.FIVEPAISA_ENCRYPTION_KEY,
        UserId: env.FIVEPAISA_USER_ID,
      },
    }),
  });

  const data = await response.json();

  const accessToken = data?.body?.AccessToken;
  const clientCode = data?.body?.ClientCode;
  const message =
    data?.body?.Message ??
    data?.head?.StatusDescription ??
    "Unknown 5Paisa authentication response";

  if (!response.ok || !accessToken || !clientCode || message !== "Success") {
    throw new Error(
      "5Paisa access-token exchange failed: " +
        JSON.stringify({
          http_status: response.status,
          message,
          status: data?.body?.Status ?? data?.head?.Status,
        })
    );
  }

  const jwtExpiry = getJwtExpiry(accessToken);
  const now = new Date();
  const tokenExpiry = jwtExpiry ?? new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const store = getStore(env);

  // Keep the session in KV with an explicit TTL even when 5Paisa returns
  // a token that is not a JWT (and therefore has no readable exp claim).
  await Promise.all([
    store.put(ACCESS_TOKEN_KEY, accessToken, { expirationTtl: 12 * 60 * 60 }),
    store.put(CLIENT_CODE_KEY, String(clientCode)),
    store.put(LOGIN_TIME_KEY, now.toISOString(), { expirationTtl: 12 * 60 * 60 }),
    store.put(TOKEN_EXPIRY_KEY, tokenExpiry, { expirationTtl: 12 * 60 * 60 }),
  ]);

  return {
    accessToken,
    clientCode: String(clientCode),
    tokenExpiry,
    response: data,
  };
}

async function fivePaisaPost(
  env: FivePaisaEnv,
  endpoint: string,
  body: Record<string, unknown>
): Promise<any> {
  requireFivePaisaConfig(env);

  const session = await getStoredFivePaisaSession(env);
  if (!session.accessToken || !session.clientCode) {
    throw new Error("5Paisa session is not connected. Start 5Paisa login first.");
  }

  const response = await fetch(FIVEPAISA_API_BASE + endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + session.accessToken,
      "5Paisa-API-Uid": FIVEPAISA_API_UID,
    },
    body: JSON.stringify({
      head: {
        key: env.FIVEPAISA_API_KEY,
      },
      body: {
        ClientCode: session.clientCode,
        ...body,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      "5Paisa API HTTP error " +
        response.status +
        ": " +
        JSON.stringify(data)
    );
  }

  const status =
    data?.body?.Status ??
    data?.head?.status ??
    data?.head?.Status;

  const message =
    data?.body?.Message ??
    data?.head?.statusDescription ??
    data?.head?.StatusDescription;

  if (status === 9 || /invalid session|token expired/i.test(String(message ?? ""))) {
    await clearFivePaisaSession(env);
    throw new Error("5Paisa session has expired. Start 5Paisa login again.");
  }

  // 5Paisa returns status=1 with "No Order found for this Client." when
  // the order book is legitimately empty. Treat that as an empty dataset.
  if (
    status !== undefined &&
    status !== 0 &&
    status !== "0" &&
    !(status === 1 && /no order found/i.test(String(message ?? "")))
  ) {
    throw new Error(
      "5Paisa API returned an error: " +
        JSON.stringify({
          status,
          message,
        })
    );
  }

  if (status === 1 && /no order found/i.test(String(message ?? ""))) {
    if (data?.body && !data.body.OrderBookDetail) {
      data.body.OrderBookDetail = [];
    }
  }

  return data;
}

function dashboardTable(
  positions: any[],
  margin: any,
  orders: any[],
  trades: any[]
): string {
  const equity = Array.isArray(margin?.EquityMargin)
    ? margin.EquityMargin[0] ?? {}
    : {};

  const positionCount = Array.isArray(positions)
    ? positions.filter((row) => Number(row?.NetQty ?? 0) !== 0).length
    : 0;
  const orderCount = Array.isArray(orders) ? orders.length : 0;
  const tradeCount = Array.isArray(trades) ? trades.length : 0;

  const mtm = positions.reduce((sum, row) => {
    const value =
      Number(row?.MTOM) ||
      Number(row?.MTM) ||
      Number(row?.MtoM) ||
      Number(row?.Mtm) ||
      0;
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const rows = [
    ["Net Available Margin", equity?.NetAvailableMargin],
    ["Margin Utilized", equity?.MarginUtilized],
    ["Options Premium", equity?.OptionsPremium],
    ["Today's Loss", equity?.TodaysLoss],
    ["Open Positions", positionCount],
    ["Today's Orders", orderCount],
    ["Today's Trades", tradeCount],
    ["Position MTM", mtm],
  ];

  return [
    "## 5Paisa Dashboard",
    "",
    "| Metric | Value |",
    "|---|---:|",
    ...rows.map(([label, value]) => `| ${label} | ${value ?? "—"} |`),
    "",
    "Read-only: positions, margin, orders and trades. No order placement, modification, cancellation or square-off is exposed.",
  ].join("\n");
}

export async function getFivePaisaHoldings(env: FivePaisaEnv, baseUrl: string): Promise<any> {
  requireFivePaisaConfig(env);
  const session = await ensureFivePaisaSession(env, baseUrl);
  if (!session.accessToken || !session.clientCode) {
    throw new Error("5Paisa authentication is required before holdings can be read.");
  }

  const response = await fivePaisaPost(env, "/V3/Holding", {});
  const rows = Array.isArray(response?.body?.Data) ? response.body.Data : [];
  const normalized = rows.map((row: any) => {
    const quantity = Number(row?.Quantity ?? 0);
    const average = Number(row?.AvgRate);
    const ltp = Number(row?.CurrentPrice);
    const investmentValue = Number.isFinite(average) ? average * quantity : null;
    const currentValue = Number.isFinite(ltp) ? ltp * quantity : null;
    const pnl = investmentValue !== null && currentValue !== null
      ? currentValue - investmentValue : null;
    const pnlPercent = pnl !== null && investmentValue
      ? (pnl / investmentValue) * 100 : null;

    return {
      symbol: row?.Symbol ?? null,
      exchange: row?.Exch === "N" ? "NSE" : row?.Exch ?? null,
      isin: row?.ISIN ?? null,
      quantity,
      average_price: Number.isFinite(average) ? average : null,
      ltp: Number.isFinite(ltp) ? ltp : null,
      investment_value: investmentValue,
      current_value: currentValue,
      pnl,
      pnl_percent: pnlPercent,
      dp_quantity: Number(row?.DPQty ?? 0),
      mtf_quantity: Number(row?.MTFQty ?? 0),
      mtf_pledge: Number(row?.MTFPledge ?? 0),
      pool_quantity: Number(row?.PoolQty ?? 0),
      e_dis_authorized: row?.POASigned ?? null,
    };
  });

  const summary = normalized.reduce(
    (s: any, row: any) => {
      if (Number.isFinite(row.investment_value)) s.investment_value += row.investment_value;
      if (Number.isFinite(row.current_value)) s.current_value += row.current_value;
      return s;
    },
    { investment_value: 0, current_value: 0 }
  );
  summary.pnl = summary.current_value - summary.investment_value;
  summary.pnl_percent = summary.investment_value
    ? (summary.pnl / summary.investment_value) * 100
    : null;

  return {
    authenticated: true,
    broker: "5Paisa",
    holdings: normalized,
    summary,
    auth_mode: session.authMode,
    token_expiry: session.tokenExpiry,
    source: "5Paisa Xstream V3 Holding API",
    read_only: true,
  };
}


export function registerFivePaisaTools(
  server: any,
  env: FivePaisaEnv,
  baseUrl: string
): void {
  server.registerTool(
    "fivepaisa_auth_status",
    {
      description:
        "Check 5Paisa Xstream API configuration and current session state. Read-only; never exposes credentials or access tokens.",
    },
    async () => {
      const configured =
        Boolean(env.FIVEPAISA_API_KEY) &&
        Boolean(env.FIVEPAISA_ENCRYPTION_KEY) &&
        Boolean(env.FIVEPAISA_USER_ID);

      let session = {
        accessToken: null as string | null,
        clientCode: null as string | null,
        loginTime: null as string | null,
        tokenExpiry: null as string | null,
      };

      if (configured) {
        session = await getStoredFivePaisaSession(env);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                configured,
                authenticated: Boolean(session.accessToken),
                client_code: session.clientCode,
                login_time: session.loginTime,
                token_expiry: session.tokenExpiry,
                auto_totp_ready: hasFivePaisaTotpConfig(env),
                auth_mode: session.accessToken
                  ? "ACTIVE"
                  : hasFivePaisaTotpConfig(env)
                    ? "AUTO_TOTP_READY"
                    : "OAUTH_REQUIRED",
                read_only: true,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "fivepaisa_holdings",
    {
      description:
        "Return current 5Paisa long-term equity holdings with quantity, average rate, current price, investment value, current value and P&L. Automatically uses the active 5Paisa session. Read-only.",
    },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify(await getFivePaisaHoldings(env, baseUrl), null, 2)
      }]
    })
  );

  server.registerTool(
    "fivepaisa_dashboard",
    {
      description:
        "Return a consolidated, read-only 5Paisa dashboard with authentication status, margin, current positions, today's orders and today's trades. If the session is not connected, return a secure 5Paisa login URL instead. Never place, modify, cancel or square off orders.",
    },
    async () => {
      requireFivePaisaConfig(env);

      const session = await ensureFivePaisaSession(env, baseUrl);

      if (!session.accessToken || !session.clientCode) {
        const loginUrl = await createFivePaisaLoginUrl(env, baseUrl);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "AUTH_REQUIRED",
                  message:
                    "5Paisa is configured but not connected. Automatic TOTP is not configured; open the login URL, complete the normal 5Paisa login/TOTP flow, then run fivepaisa_dashboard again.",
                  login_url: loginUrl,
                  read_only: true,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const [marginResponse, positionResponse, orderResponse] =
        await Promise.all([
          fivePaisaPost(env, "/V4/Margin", {}),
          fivePaisaPost(env, "/V2/NetPositionNetWise", {}),
          fivePaisaPost(env, "/V3/OrderBook", {}),
        ]);

      let tradeResponse: any = { body: { TradeBookDetail: [] } };
      try {
        tradeResponse = await fivePaisaPost(env, "/V1/TradeBook", {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/No Trades found for this Client/i.test(message)) throw error;
      }

      const positions = positionResponse?.body?.NetPositionDetail ?? [];
      const orders = orderResponse?.body?.OrderBookDetail ?? [];
      const trades = tradeResponse?.body?.TradeBookDetail ?? [];
      const margin = marginResponse?.body ?? {};

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "CONNECTED",
                dashboard: dashboardTable(
                  positions,
                  margin,
                  orders,
                  trades
                ),
                session: {
                  authenticated: true,
                  client_code: session.clientCode,
                  login_time: session.loginTime,
                  token_expiry: session.tokenExpiry,
                },
                margin,
                positions,
                orders,
                trades,
                read_only: true,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "fivepaisa_totp_self_test",
    {
      description:
        "Force a direct 5Paisa TOTP authentication test using the configured Cloudflare TOTP secret and PIN. Refreshes the read-only API session and never places, modifies, cancels or squares off orders.",
    },
    async () => {
      requireFivePaisaConfig(env);

      if (!hasFivePaisaTotpConfig(env)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "NOT_CONFIGURED",
                  message:
                    "Set FIVEPAISA_TOTP_SECRET and FIVEPAISA_PIN, and either FIVEPAISA_CLIENT_CODE or complete one OAuth login first.",
                  read_only: true,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      try {
        const session = await authenticateFivePaisaWithTotp(env);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "PASS",
                  authenticated: true,
                  client_code: session.clientCode,
                  token_expiry: session.tokenExpiry,
                  auth_mode: "AUTO_TOTP",
                  read_only: true,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "FAIL",
                  authenticated: false,
                  message:
                    error instanceof Error ? error.message : String(error),
                  read_only: true,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "fivepaisa_self_test",
    {
      description:
        "Run an automated read-only 5Paisa integration self-test: session, margin, positions, order book and trade book. Returns PASS/FAIL diagnostics and never performs a trading action.",
    },
    async () => {
      requireFivePaisaConfig(env);
      const session = await ensureFivePaisaSession(env, baseUrl);

      if (!session.accessToken || !session.clientCode) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "AUTH_REQUIRED",
                  message:
                    "No active 5Paisa session and automatic TOTP is not configured. Connect via fivepaisa_dashboard first.",
                  checks: {
                    configuration: "PASS",
                    automatic_totp: hasFivePaisaTotpConfig(env)
                      ? "PASS"
                      : "NOT_CONFIGURED",
                    session: "FAIL",
                  },
                  read_only: true,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const checks: Record<string, string> = {
        configuration: "PASS",
        session: "PASS",
      };
      const errors: Record<string, string> = {};

      const tests: Array<[string, string, Record<string, unknown>]> = [
        ["margin", "/V4/Margin", {}],
        ["positions", "/V2/NetPositionNetWise", {}],
        ["orders", "/V3/OrderBook", {}],
        ["trades", "/V1/TradeBook", {}],
      ];

      for (const [name, endpoint, body] of tests) {
        try {
          await fivePaisaPost(env, endpoint, body);
          checks[name] = "PASS";
        } catch (error) {
          checks[name] = "FAIL";
          errors[name] =
            error instanceof Error ? error.message : String(error);
        }
      }

      const passed =
        Object.values(checks).filter((value) => value === "PASS").length;
      const total = Object.keys(checks).length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: passed === total ? "PASS" : "FAIL",
                checks,
                auth_mode: session.authMode,
                passed,
                total,
                errors,
                read_only: true,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "fivepaisa_login_url",
    {
      description:
        "Generate a fresh secure 5Paisa OAuth login URL for the configured app. Does not expose credentials or place orders.",
    },
    async () => {
      const loginUrl = await createFivePaisaLoginUrl(env, baseUrl);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                login_url: loginUrl,
                expires_in_seconds: 600,
                read_only: true,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

export async function handleFivePaisaCallback(
  request: Request,
  env: FivePaisaEnv
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const requestToken =
      url.searchParams.get("RequestToken") ??
      url.searchParams.get("requestToken");
    const state =
      url.searchParams.get("state") ??
      url.searchParams.get("State");

    if (!requestToken) {
      return new Response(
        "5Paisa login callback did not contain RequestToken.",
        { status: 400 }
      );
    }

    const store = getStore(env);

    if (state) {
      const stateValue = await store.get(STATE_PREFIX + state);
      if (stateValue !== "pending") {
        return new Response(
          "5Paisa login state is invalid or expired. Start again from ChatGPT.",
          { status: 400 }
        );
      }
      await store.delete(STATE_PREFIX + state);
    }

    await exchangeFivePaisaRequestToken(env, requestToken);

    return new Response(
      "5Paisa authentication successful. Return to ChatGPT and run the 5Paisa dashboard again.",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      }
    );
  } catch (error) {
    return new Response(
      "5Paisa authentication failed: " +
        (error instanceof Error ? error.message : String(error)),
      { status: 502 }
    );
  }
}
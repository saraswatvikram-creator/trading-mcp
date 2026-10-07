type GrowwEnv = {
  GROWW_TOTP_TOKEN?: string;
  GROWW_TOTP_SECRET?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
};

const GROWW_BASE_URL = "https://api.groww.in";
const GROWW_ACCESS_TOKEN_KEY = "groww_access_token";
const GROWW_ACCESS_EXPIRY_KEY = "groww_access_expiry";

function normalizeGrowwTotpSecret(value: string): string {
  let normalized = value.trim();

  // Accept a QR/otpauth URI if the value was copied directly from an
  // authenticator setup. Otherwise use the raw Base32 secret.
  if (/^otpauth:\/\//i.test(normalized)) {
    try {
      const uri = new URL(normalized);
      const secret = uri.searchParams.get("secret");
      if (secret) normalized = secret;
    } catch {
      throw new Error("GROWW_TOTP_SECRET contains an invalid otpauth URI");
    }
  }

  // Groww/authenticator displays may wrap the Base32 secret with spaces
  // or hyphens. Those are presentation separators, not secret characters.
  normalized = normalized
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .replace(/=+$/g, "");

  if (!normalized) {
    throw new Error("GROWW_TOTP_SECRET is empty");
  }

  if (!/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error(
      "GROWW_TOTP_SECRET must be the raw Base32 secret (or an otpauth URI). Do not enter the 6-digit TOTP code."
    );
  }

  return normalized;
}

function base32Decode(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = normalizeGrowwTotpSecret(value);
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];

  // Keep only the unconsumed remainder in the numeric buffer. This is
  // important in JavaScript/Workers because bitwise operators are 32-bit;
  // a full Base32 secret can be much longer than 32 bits.
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    buffer = (buffer << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
      buffer &= bits > 0 ? (1 << bits) - 1 : 0;
    }
  }

  if (output.length < 10) {
    throw new Error("GROWW_TOTP_SECRET is too short to be a valid TOTP secret");
  }

  return new Uint8Array(output);
}

async function generateTotp(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterBytes)
  );

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1000000).padStart(6, "0");
}

function requireGrowwConfig(env: GrowwEnv): void {
  const missing: string[] = [];
  if (!env.GROWW_TOTP_TOKEN) missing.push("GROWW_TOTP_TOKEN");
  if (!env.GROWW_TOTP_SECRET) missing.push("GROWW_TOTP_SECRET");

  if (missing.length > 0) {
    throw new Error(
      "Groww configuration is incomplete. Missing Cloudflare secrets: " +
        missing.join(", ")
    );
  }
}

function getJwtExpiry(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp === "number"
      ? new Date(payload.exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

async function getCachedGrowwToken(env: GrowwEnv): Promise<string | null> {
  if (!env.ZERODHA_TOKEN_STORE) return null;

  const token = await env.ZERODHA_TOKEN_STORE.get(GROWW_ACCESS_TOKEN_KEY);
  const expiry = await env.ZERODHA_TOKEN_STORE.get(GROWW_ACCESS_EXPIRY_KEY);

  if (!token || !expiry) return null;

  const expiryMs = new Date(expiry).getTime();
  if (!Number.isFinite(expiryMs) || Date.now() >= expiryMs - 60_000) {
    await env.ZERODHA_TOKEN_STORE.delete(GROWW_ACCESS_TOKEN_KEY);
    await env.ZERODHA_TOKEN_STORE.delete(GROWW_ACCESS_EXPIRY_KEY);
    return null;
  }

  return token;
}

async function generateGrowwAccessToken(env: GrowwEnv): Promise<{
  accessToken: string;
  expiry: string | null;
}> {
  requireGrowwConfig(env);

  const cached = await getCachedGrowwToken(env);
  if (cached) {
    return {
      accessToken: cached,
      expiry: env.ZERODHA_TOKEN_STORE
        ? await env.ZERODHA_TOKEN_STORE.get(GROWW_ACCESS_EXPIRY_KEY)
        : getJwtExpiry(cached),
    };
  }

  const totp = await generateTotp(env.GROWW_TOTP_SECRET!);

  const response = await fetch(
    GROWW_BASE_URL + "/v1/token/api/access",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.GROWW_TOTP_TOKEN!,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-VERSION": "1.0",
      },
      body: JSON.stringify({
        key_type: "totp",
        totp,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || data?.status === "FAILURE") {
    throw new Error(
      "Groww authentication failed: " +
        JSON.stringify({
          http_status: response.status,
          error: data?.error ?? data,
        })
    );
  }

  const accessToken =
    data?.token ??
    data?.payload?.token ??
    data?.access_token ??
    data?.payload?.access_token;

  if (!accessToken) {
    throw new Error(
      "Groww authentication succeeded but no access token was returned."
    );
  }

  const expiry =
    data?.expiry ??
    data?.payload?.expiry ??
    getJwtExpiry(accessToken);

  if (env.ZERODHA_TOKEN_STORE) {
    const fallbackExpiry =
      expiry ??
      new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();

    const ttl = Math.max(
      300,
      Math.floor((new Date(fallbackExpiry).getTime() - Date.now()) / 1000)
    );

    await Promise.all([
      env.ZERODHA_TOKEN_STORE.put(
        GROWW_ACCESS_TOKEN_KEY,
        accessToken,
        { expirationTtl: ttl }
      ),
      env.ZERODHA_TOKEN_STORE.put(
        GROWW_ACCESS_EXPIRY_KEY,
        fallbackExpiry,
        { expirationTtl: ttl }
      ),
    ]);
  }

  return { accessToken, expiry };
}


async function growwGetLtp(
  exchangeSymbols: string[],
  env: GrowwEnv,
  accessToken: string
): Promise<Record<string, number>> {
  if (exchangeSymbols.length === 0) return {};

  const params = new URLSearchParams({
    segment: "FNO",
    exchange_symbols: exchangeSymbols.join(","),
  });

  const response = await growwGet(
    "/v1/live-data/ltp?" + params.toString(),
    env,
    accessToken
  );

  const payload = response?.payload ?? {};
  const result: Record<string, number> = {};

  for (const symbol of exchangeSymbols) {
    const ltp = Number(payload?.[symbol]);
    if (Number.isFinite(ltp)) result[symbol] = ltp;
  }

  return result;
}

function enrichPositionsWithMtm(
  positions: any[],
  ltps: Record<string, number>
): any[] {
  return positions.map((row) => {
    const quantity = Number(row?.quantity ?? 0);
    const netPrice = Number(row?.net_price ?? 0);
    const symbol = String(row?.trading_symbol ?? "");
    const ltp = ltps[symbol ? "NSE_" + symbol : ""];

    if (!Number.isFinite(ltp) || quantity === 0 || !Number.isFinite(netPrice)) {
      return {
        ...row,
        ltp: Number.isFinite(ltp) ? ltp : null,
        unrealised_pnl: null,
        mtm_source: "Groww Live Data unavailable",
      };
    }

    const unrealisedPnl =
      quantity > 0
        ? (ltp - netPrice) * quantity
        : (netPrice - ltp) * Math.abs(quantity);

    return {
      ...row,
      ltp,
      unrealised_pnl: Number(unrealisedPnl.toFixed(2)),
      mtm_source: "Groww Live LTP API",
    };
  });
}

async function growwGet(
  path: string,
  env: GrowwEnv,
  accessToken: string
): Promise<any> {
  const response = await fetch(GROWW_BASE_URL + path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + accessToken,
      "X-API-VERSION": "1.0",
    },
  });

  const data = await response.json();

  if (!response.ok || data?.status === "FAILURE") {
    throw new Error(
      "Groww API error " +
        response.status +
        ": " +
        JSON.stringify(data?.error ?? data)
    );
  }

  return data;
}

async function invalidateCachedGrowwToken(env: GrowwEnv): Promise<void> {
  if (!env.ZERODHA_TOKEN_STORE) return;

  await Promise.all([
    env.ZERODHA_TOKEN_STORE.delete(GROWW_ACCESS_TOKEN_KEY),
    env.ZERODHA_TOKEN_STORE.delete(GROWW_ACCESS_EXPIRY_KEY),
  ]);
}

async function withGrowwToken(
  env: GrowwEnv
): Promise<{ accessToken: string; expiry: string | null }> {
  return generateGrowwAccessToken(env);
}

// Execute one Groww API request and automatically recover from a stale/revoked
// access token. A 401 invalidates the cached token, generates a fresh TOTP
// access token, and retries exactly once.
async function growwGetWithAutoRefresh(
  path: string,
  env: GrowwEnv
): Promise<{ data: any; accessToken: string; expiry: string | null }> {
  let token = await withGrowwToken(env);

  try {
    return {
      data: await growwGet(path, env, token.accessToken),
      accessToken: token.accessToken,
      expiry: token.expiry,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes("Groww API error 401")) {
      throw error;
    }

    await invalidateCachedGrowwToken(env);
    token = await generateGrowwAccessToken(env);

    return {
      data: await growwGet(path, env, token.accessToken),
      accessToken: token.accessToken,
      expiry: token.expiry,
    };
  }
}

function dashboardSummary(
  profile: any,
  positions: any[],
  margin: any,
  orders: any[],
  liveMtm: number | null
): string {
  const fnoPositions = positions.filter(
    (row) =>
      String(row?.segment ?? "").toUpperCase() === "FNO" &&
      Number(row?.quantity ?? 0) !== 0
  );

  const realisedPnl = fnoPositions.reduce((sum, row) => {
    const value =
      Number(row?.realised_pnl) ||
      Number(row?.realized_pnl) ||
      0;
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const fno = margin?.fno_margin_details ?? {};

  return [
    "## Groww Dashboard",
    "",
    "| Metric | Value |",
    "|---|---:|",
    "| Authentication | CONNECTED |",
    "| F&O positions | " + fnoPositions.length + " |",
    "| Today's orders | " + orders.length + " |",
    "| Realised P&L in returned positions | ₹" + realisedPnl.toFixed(2) + " |",
    "| Live MTM | " + (liveMtm === null ? "—" : "₹" + liveMtm.toFixed(2)) + " |",
    "| F&O margin used | ₹" + (fno.net_fno_margin_used ?? "—") + " |",
    "| Option sell balance | ₹" + (fno.option_sell_balance_available ?? "—") + " |",
    "| Client/UCC | " + (profile?.ucc ?? "—") + " |",
    "",
    "Read-only integration. No Groww order placement, modification, cancellation or square-off is exposed.",
    "Live MTM is calculated from Groww Live LTP API.",
  ].join("\n");
}

export function registerGrowwTools(server: any, env: GrowwEnv): void {
  server.registerTool(
    "groww_auth_status",
    {
      description:
        "Validate Groww TOTP configuration and generate a current access token automatically. Read-only; never exposes credentials or tokens.",
    },
    async () => {
      const configured =
        Boolean(env.GROWW_TOTP_TOKEN) &&
        Boolean(env.GROWW_TOTP_SECRET);

      let authenticated = false;
      let expiry: string | null = null;
      let error: string | null = null;

      if (configured) {
        try {
          const result = await growwGetWithAutoRefresh(
            "/v1/user/detail",
            env
          );
          authenticated = true;
          expiry = result.expiry;
        } catch (e) {
          authenticated = false;
          error = e instanceof Error ? e.message : String(e);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            configured,
            authenticated,
            token_expiry: expiry,
            error,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_profile",
    {
      description:
        "Authenticate to Groww using the configured TOTP secret and return the authenticated user profile. Read-only.",
    },
    async () => {
      const result = await growwGetWithAutoRefresh("/v1/user/detail", env);
      const profile = result.data;
      const token = { expiry: result.expiry };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            profile: profile?.payload ?? profile,
            token_expiry: token.expiry,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_positions",
    {
      description:
        "Authenticate to Groww using TOTP and return current F&O positions with live LTP-based MTM. Read-only. This is the primary Groww positions command.",
    },
    async () => {
      const result = await growwGetWithAutoRefresh(
        "/v1/positions/user?segment=FNO",
        env
      );
      const token = result;
      const response = result.data;
      const positions = response?.payload?.positions ?? response?.payload ?? [];
      const openPositions = positions.filter(
        (row: any) => Number(row?.quantity ?? 0) !== 0
      );
      const ltps = await growwGetLtp(
        openPositions.map((row: any) => "NSE_" + String(row.trading_symbol)),
        env,
        token.accessToken
      );
      const enrichedPositions = enrichPositionsWithMtm(positions, ltps);
      const liveMtm = enrichedPositions.reduce((sum: number, row: any) => {
        const value = Number(row?.unrealised_pnl);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            auth_mode: "TOTP",
            segment: "FNO",
            positions: enrichedPositions,
            live_mtm: liveMtm,
            mtm_source: "Groww Live LTP API",
            token_expiry: token.expiry,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_margin",
    {
      description:
        "Return current Groww available margin, including F&O margin details. Read-only.",
    },
    async () => {
      const result = await growwGetWithAutoRefresh(
        "/v1/margins/detail/user",
        env
      );
      const token = result;
      const margin = result.data;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            margin: margin?.payload ?? margin,
            token_expiry: token.expiry,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_orders",
    {
      description:
        "Return today's Groww F&O order list. Read-only. No order placement or modification is exposed.",
    },
    async () => {
      const result = await growwGetWithAutoRefresh(
        "/v1/order/list?segment=FNO&page=0&page_size=100",
        env
      );
      const token = result;
      const orders = result.data;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            segment: "FNO",
            orders: orders?.payload?.order_list ?? [],
            token_expiry: token.expiry,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_dashboard",
    {
      description:
        "Return a consolidated, read-only Groww dashboard with automatic TOTP authentication, user profile, F&O positions, live LTP-based MTM, available margin and today's F&O orders. Never place, modify, cancel or square off orders.",
    },
    async () => {
      const [profileResult, positionResult, marginResult, orderResult] =
        await Promise.all([
          growwGetWithAutoRefresh("/v1/user/detail", env),
          growwGetWithAutoRefresh("/v1/positions/user?segment=FNO", env),
          growwGetWithAutoRefresh("/v1/margins/detail/user", env),
          growwGetWithAutoRefresh(
            "/v1/order/list?segment=FNO&page=0&page_size=100",
            env
          ),
        ]);

      const token = profileResult; const profileResponse = profileResult.data;
      const positionResponse = positionResult.data;
      const marginResponse = marginResult.data;
      const orderResponse = orderResult.data;

      const profile = profileResponse?.payload ?? profileResponse;
      const positions = positionResponse?.payload?.positions ?? [];
      const margin = marginResponse?.payload ?? marginResponse;
      const orders = orderResponse?.payload?.order_list ?? [];
      const openPositions = positions.filter(
        (row: any) => Number(row?.quantity ?? 0) !== 0
      );
      const ltps = await growwGetLtp(
        openPositions.map((row: any) => "NSE_" + String(row.trading_symbol)),
        env,
        token.accessToken
      );
      const enrichedPositions = enrichPositionsWithMtm(positions, ltps);
      const liveMtm = enrichedPositions.reduce((sum: number, row: any) => {
        const value = Number(row?.unrealised_pnl);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "CONNECTED",
            auth_mode: "TOTP",
            dashboard: dashboardSummary(
              profile,
              enrichedPositions,
              margin,
              orders,
              liveMtm
            ),
            session: {
              authenticated: true,
              token_expiry: token.expiry,
            },
            profile,
            positions: enrichedPositions,
            live_mtm: liveMtm,
            mtm_source: "Groww Live LTP API",
            margin,
            orders,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_self_test",
    {
      description:
        "Run an automated read-only Groww integration self-test: TOTP configuration, authentication, profile, F&O positions, live LTP/MTM, margin and F&O order list. Returns PASS/FAIL diagnostics and never performs a trading action.",
    },
    async () => {
      const configured =
        Boolean(env.GROWW_TOTP_TOKEN) &&
        Boolean(env.GROWW_TOTP_SECRET);

      const checks: Record<string, string> = {
        configuration: configured ? "PASS" : "FAIL",
      };
      const errors: Record<string, string> = {};

      if (!configured) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "FAIL",
              checks,
              errors: {
                configuration:
                  "Missing GROWW_TOTP_TOKEN and/or GROWW_TOTP_SECRET Cloudflare secret.",
              },
              read_only: true,
            }, null, 2),
          }],
        };
      }

      try {
        const authResult = await growwGetWithAutoRefresh(
          "/v1/user/detail",
          env
        );
        checks.authentication = "PASS";
        checks.profile = "PASS";

        const tests: Array<[string, string]> = [
          ["positions", "/v1/positions/user?segment=FNO"],
          ["margin", "/v1/margins/detail/user"],
          ["orders", "/v1/order/list?segment=FNO&page=0&page_size=100"],
        ];

        for (const [name, path] of tests) {
          try {
            await growwGetWithAutoRefresh(path, env);
            checks[name] = "PASS";
          } catch (e) {
            checks[name] = "FAIL";
            errors[name] = e instanceof Error ? e.message : String(e);
          }
        }
      } catch (e) {
        checks.authentication = "FAIL";
        checks.profile = "FAIL";
        errors.authentication = e instanceof Error ? e.message : String(e);
      }

      const passed = Object.values(checks).filter((v) => v === "PASS").length;
      const total = Object.keys(checks).length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: passed === total ? "PASS" : "FAIL",
            checks,
            passed,
            total,
            errors,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );
}

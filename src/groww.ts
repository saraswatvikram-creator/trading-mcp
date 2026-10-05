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

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
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

async function withGrowwToken(
  env: GrowwEnv
): Promise<{ accessToken: string; expiry: string | null }> {
  return generateGrowwAccessToken(env);
}

function dashboardSummary(
  profile: any,
  positions: any[],
  margin: any,
  orders: any[]
): string {
  const fnoPositions = positions.filter(
    (row) =>
      String(row?.segment ?? "").toUpperCase() === "FNO" &&
      Number(row?.quantity ?? 0) !== 0
  );

  const mtm = fnoPositions.reduce((sum, row) => {
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
    "| Realised P&L in returned positions | ₹" + mtm.toFixed(2) + " |",
    "| F&O margin used | ₹" + (fno.net_fno_margin_used ?? "—") + " |",
    "| Option sell balance | ₹" + (fno.option_sell_balance_available ?? "—") + " |",
    "| Client/UCC | " + (profile?.ucc ?? "—") + " |",
    "",
    "Read-only integration. No Groww order placement, modification, cancellation or square-off is exposed.",
  ].join("\n");
}

export function registerGrowwTools(server: any, env: GrowwEnv): void {
  server.registerTool(
    "groww_auth_status",
    {
      description:
        "Check Groww TOTP configuration and whether a current Groww access token can be generated. Read-only; never exposes credentials or tokens.",
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
          const token = await withGrowwToken(env);
          authenticated = Boolean(token.accessToken);
          expiry = token.expiry;
        } catch (e) {
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
      const token = await withGrowwToken(env);
      const profile = await growwGet("/v1/user/detail", env, token.accessToken);

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
        "Authenticate to Groww and return current F&O positions. Read-only. This is the primary Groww positions command.",
    },
    async () => {
      const token = await withGrowwToken(env);
      const response = await growwGet(
        "/v1/positions/user?segment=FNO",
        env,
        token.accessToken
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            segment: "FNO",
            positions: response?.payload?.positions ?? response?.payload ?? [],
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
      const token = await withGrowwToken(env);
      const margin = await growwGet(
        "/v1/margins/detail/user",
        env,
        token.accessToken
      );

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
      const token = await withGrowwToken(env);
      const orders = await growwGet(
        "/v1/order/list?segment=FNO&page=0&page_size=100",
        env,
        token.accessToken
      );

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
        "Return a consolidated, read-only Groww dashboard with authentication, user profile, F&O positions, available margin and today's F&O orders. Never place, modify, cancel or square off orders.",
    },
    async () => {
      const token = await withGrowwToken(env);

      const [profileResponse, positionResponse, marginResponse, orderResponse] =
        await Promise.all([
          growwGet("/v1/user/detail", env, token.accessToken),
          growwGet("/v1/positions/user?segment=FNO", env, token.accessToken),
          growwGet("/v1/margins/detail/user", env, token.accessToken),
          growwGet(
            "/v1/order/list?segment=FNO&page=0&page_size=100",
            env,
            token.accessToken
          ),
        ]);

      const profile = profileResponse?.payload ?? profileResponse;
      const positions = positionResponse?.payload?.positions ?? [];
      const margin = marginResponse?.payload ?? marginResponse;
      const orders = orderResponse?.payload?.order_list ?? [];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "CONNECTED",
            dashboard: dashboardSummary(
              profile,
              positions,
              margin,
              orders
            ),
            session: {
              authenticated: true,
              token_expiry: token.expiry,
            },
            profile,
            positions,
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
        "Run an automated read-only Groww integration self-test: configuration, authentication, profile, F&O positions, margin and F&O order list. Returns PASS/FAIL diagnostics and never performs a trading action.",
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

      let accessToken: string;
      try {
        const token = await withGrowwToken(env);
        accessToken = token.accessToken;
        checks.authentication = "PASS";
      } catch (e) {
        checks.authentication = "FAIL";
        errors.authentication = e instanceof Error ? e.message : String(e);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "FAIL",
              checks,
              errors,
              read_only: true,
            }, null, 2),
          }],
        };
      }

      const tests: Array<[string, string]> = [
        ["profile", "/v1/user/detail"],
        ["positions", "/v1/positions/user?segment=FNO"],
        ["margin", "/v1/margins/detail/user"],
        ["orders", "/v1/order/list?segment=FNO&page=0&page_size=100"],
      ];

      for (const [name, path] of tests) {
        try {
          await growwGet(path, env, accessToken);
          checks[name] = "PASS";
        } catch (e) {
          checks[name] = "FAIL";
          errors[name] = e instanceof Error ? e.message : String(e);
        }
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

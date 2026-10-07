import { z } from "zod";

type MStockEnv = {
  MSTOCK_API_KEY?: string;
  MSTOCK_USERNAME?: string;
  MSTOCK_PASSWORD?: string;
  MSTOCK_ACCESS_TOKEN?: string;
  MSTOCK_TOTP_SECRET?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
};

const BASE = "https://api.mstock.trade";
const VERSION = "1";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

function config(env: MStockEnv) {
  const apiKey = env.MSTOCK_API_KEY?.trim();
  const totpSecret = env.MSTOCK_TOTP_SECRET?.trim() ?? "";
  const store = env.ZERODHA_TOKEN_STORE;

  if (!apiKey || !totpSecret) {
    throw new Error("MSTOCK_CONFIG_REQUIRED: Missing MSTOCK_API_KEY or MSTOCK_TOTP_SECRET.");
  }
  if (!store) {
    throw new Error("MSTOCK_STORAGE_REQUIRED: ZERODHA_TOKEN_STORE KV binding is required.");
  }
  return { apiKey, totpSecret, store };
}

async function storedToken(env: MStockEnv) {
  return (await env.ZERODHA_TOKEN_STORE?.get("mstock_access_token"))?.trim()
    || env.MSTOCK_ACCESS_TOKEN?.trim()
    || null;
}

async function storedLoginTime(env: MStockEnv) {
  return (await env.ZERODHA_TOKEN_STORE?.get("mstock_login_time")) ?? null;
}

async function clearSession(env: MStockEnv) {
  if (!env.ZERODHA_TOKEN_STORE) return;
  await Promise.all([
    env.ZERODHA_TOKEN_STORE.delete("mstock_access_token"),
    env.ZERODHA_TOKEN_STORE.delete("mstock_login_time"),
  ]);
}

function jwtExpiry(token: string | null) {
  try {
    if (!token) return null;
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

function fallbackExpiry(loginTime: string | null) {
  if (!loginTime) return null;
  const match = loginTime.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const parsed = new Date(loginTime.replace(" ", "T") + (loginTime.includes("+") || loginTime.endsWith("Z") ? "" : "+05:30"));
  if (Number.isNaN(parsed.getTime()) || !match) return null;
  const twelveHours = new Date(parsed.getTime() + 12 * 60 * 60 * 1000);
  const [, y, mo, d] = match;
  const nextMidnight = new Date(`${y}-${mo}-${d}T00:00:00+05:30`);
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
  return new Date(Math.min(twelveHours.getTime(), nextMidnight.getTime())).toISOString();
}

function expiry(token: string | null, loginTime: string | null) {
  return jwtExpiry(token) ?? fallbackExpiry(loginTime);
}

function expired(token: string | null, loginTime: string | null) {
  const e = expiry(token, loginTime);
  return e !== null && new Date(e).getTime() <= Date.now();
}

async function postForm(path: string, body: Record<string, string>) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "X-Mirae-Version": VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`MSTOCK_API_ERROR: Non-JSON response (HTTP ${response.status}).`);
  }

  const status = String(data?.status ?? "").toLowerCase();
  const message = String(data?.message ?? "Unknown m.Stock API error");

  if (!response.ok || status === "error") {
    if (response.status === 401 || response.status === 403 || /token|session|authentication/i.test(message)) {
      throw new Error("MSTOCK_AUTH_EXPIRED: " + message);
    }
    if (/totp|incorrect|expired/i.test(message)) {
      throw new Error("MSTOCK_TOTP_INVALID: " + message);
    }
    throw new Error(`MSTOCK_API_ERROR: HTTP ${response.status}. ${message}`);
  }
  return data;
}

async function get(path: string, apiKey: string, accessToken: string) {
  const response = await fetch(BASE + path, {
    headers: {
      "X-Mirae-Version": VERSION,
      Authorization: `token ${apiKey}:${accessToken}`,
    },
  });

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`MSTOCK_API_ERROR: Non-JSON response (HTTP ${response.status}).`);
  }

  const status = String(data?.status ?? "").toLowerCase();
  const message = String(data?.message ?? "Unknown m.Stock API error");
  if (!response.ok || status === "error") {
    if (response.status === 401 || response.status === 403 || /token|session|authentication/i.test(message)) {
      throw new Error("MSTOCK_AUTH_EXPIRED: " + message);
    }
    throw new Error(`MSTOCK_API_ERROR: HTTP ${response.status}. ${message}`);
  }
  return data;
}

function base32ToBytes(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (const ch of normalized) {
    const index = alphabet.indexOf(ch);
    if (index < 0) throw new Error("MSTOCK_TOTP_CONFIG: MSTOCK_TOTP_SECRET is not valid Base32.");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

async function generateTotp(secret: string, timestampMs = Date.now()) {
  const keyBytes = base32ToBytes(secret);
  const counter = Math.floor(timestampMs / 1000 / TOTP_PERIOD_SECONDS);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

async function loginWithTotp(env: MStockEnv, manualTotp?: string) {
  const { apiKey, totpSecret, store } = config(env);
  const totp = manualTotp?.trim() || await generateTotp(totpSecret);

  if (!/^\d{6}$/.test(totp)) {
    throw new Error("MSTOCK_TOTP_INVALID: TOTP must be exactly 6 digits.");
  }

  const data = await postForm("/openapi/typea/session/verifytotp", {
    api_key: apiKey,
    totp,
  });

  const accessToken = String(data?.data?.access_token ?? "").trim();
  if (!accessToken) throw new Error("MSTOCK_AUTH_ERROR: No access_token was returned by m.Stock.");

  const loginTime = String(data?.data?.login_time ?? new Date().toISOString());
  await store.put("mstock_access_token", accessToken);
  await store.put("mstock_login_time", loginTime);

  return {
    status: "CONNECTED",
    broker: "m.Stock",
    auth_mode: "TYPE_A_TOTP",
    totp: true,
    login_time: loginTime,
    token_expiry: expiry(accessToken, loginTime),
    client_id: data?.data?.user_id ?? null,
    user_name: data?.data?.user_name ?? null,
    session_persisted: true,
    read_only: true,
  };
}

function normalize(row: any) {
  const quantity = Number(row?.quantity ?? 0);
  const average = Number(row?.average_price);
  const last = Number(row?.last_price);
  const brokerUnrealised = Number(row?.unrealised);
  const brokerRealised = Number(row?.realised);

  let calculated: number | null = null;
  if (Number.isFinite(quantity) && Number.isFinite(average) && Number.isFinite(last)) {
    calculated = quantity >= 0 ? (last - average) * quantity : (average - last) * Math.abs(quantity);
  }

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
    average_price: Number.isFinite(average) ? average : null,
    last_price: Number.isFinite(last) ? last : null,
    unrealised_pnl: Number.isFinite(brokerUnrealised) ? brokerUnrealised : calculated,
    realised_pnl: Number.isFinite(brokerRealised) ? brokerRealised : null,
    m2m: Number.isFinite(Number(row?.m2m)) ? Number(row.m2m) : null,
    day_buy_quantity: Number(row?.day_buy_quantity ?? 0),
    day_sell_quantity: Number(row?.day_sell_quantity ?? 0),
    source: "m.Stock Type A live positions API",
  };
}

async function positions(env: MStockEnv) {
  const { apiKey } = config(env);
  const token = await storedToken(env);
  const loginTime = await storedLoginTime(env);

  if (!token) throw new Error("MSTOCK_AUTH_REQUIRED: No m.Stock access token is stored.");
  if (expired(token, loginTime)) {
    await clearSession(env);
    throw new Error("MSTOCK_AUTH_EXPIRED: The stored m.Stock access token has expired.");
  }

  const response = await get("/openapi/typea/portfolio/positions", apiKey, token);
  const net = Array.isArray(response?.data?.net) ? response.data.net : [];
  const all = net.map(normalize);
  const open = all.filter((p: any) => Number(p.quantity) !== 0);
  return { all, open, tokenExpiry: expiry(token, loginTime) };
}

function pnl(open: any[], all: any[]) {
  const unrealised = open.reduce((s, p) => s + (Number.isFinite(Number(p.unrealised_pnl)) ? Number(p.unrealised_pnl) : 0), 0);
  const realised = all.reduce((s, p) => s + (Number.isFinite(Number(p.realised_pnl)) ? Number(p.realised_pnl) : 0), 0);
  return { unrealised: Number(unrealised.toFixed(2)), realised: Number(realised.toFixed(2)) };
}

async function liveOrTotp(env: MStockEnv, manualTotp?: string) {
  try {
    if (manualTotp) await loginWithTotp(env, manualTotp);
    return { live: true as const, data: await positions(env) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("MSTOCK_AUTH_REQUIRED:") || message.startsWith("MSTOCK_AUTH_EXPIRED:")) {
      try {
        await loginWithTotp(env);
        return { live: true as const, data: await positions(env) };
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        return {
          live: false as const,
          auth: {
            status: "TOTP_REQUIRED",
            broker: "m.Stock",
            auth_mode: "TYPE_A_TOTP",
            totp: true,
            reason: retryMessage.replace(/^MSTOCK_[A-Z_]+:\s*/, ""),
            next_step: "Set MSTOCK_TOTP_SECRET in Cloudflare. Then run show mstock positions again.",
            read_only: true,
          },
        };
      }
    }
    throw error;
  }
}

function result(payload: any) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export export async function getMStockHoldings(env: MStockEnv, totp?: string): Promise<any> {
  const r = await liveOrTotp(env, totp);
  if (!r.live) return r.auth;

  const { apiKey } = config(env);
  const token = await storedToken(env);
  if (!token) throw new Error("MSTOCK_AUTH_REQUIRED: No m.Stock access token is stored.");

  const response = await get("/openapi/typea/portfolio/holdings", apiKey, token);
  const rows = Array.isArray(response?.data) ? response.data : [];
  const normalized = rows.map((row: any) => {
    const quantity = Number(row?.quantity ?? 0);
    const average = Number(row?.average_price);
    const ltp = Number(row?.last_price);
    const investmentValue = Number.isFinite(average) ? average * quantity : null;
    const currentValue = Number.isFinite(ltp) ? ltp * quantity : null;
    const brokerPnl = Number(row?.pnl);
    const pnl = Number.isFinite(brokerPnl) && brokerPnl !== 0
      ? brokerPnl
      : investmentValue !== null && currentValue !== null
        ? currentValue - investmentValue : null;
    const pnlPercent = pnl !== null && investmentValue
      ? (pnl / investmentValue) * 100 : null;

    return {
      symbol: row?.tradingsymbol ?? null,
      exchange: row?.exchange ?? null,
      isin: row?.isin ?? null,
      instrument_token: row?.instrument_token ?? null,
      quantity,
      average_price: Number.isFinite(average) ? average : null,
      ltp: Number.isFinite(ltp) ? ltp : null,
      investment_value: investmentValue,
      current_value: currentValue,
      pnl,
      pnl_percent: pnlPercent,
      used_quantity: Number(row?.used_quantity ?? 0),
      t1_quantity: Number(row?.t1_quantity ?? 0),
      collateral_quantity: Number(row?.collateral_quantity ?? 0),
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
    status: "LIVE",
    broker: "m.Stock",
    auth_mode: "TYPE_A_TOTP",
    holdings: normalized,
    summary,
    token_expiry: r.data.tokenExpiry,
    source: "m.Stock Type A /openapi/typea/portfolio/holdings",
    read_only: true,
  };
}


function registerMStockTools(server: any, env: MStockEnv): void {
  server.registerTool(
    "mstock_auth_status",
    {
      description: "Check m.Stock Type A TOTP configuration and stored session state. Read-only.",
    },
    async () => {
      const configured = Boolean(env.MSTOCK_API_KEY?.trim() && env.MSTOCK_TOTP_SECRET?.trim());
      const token = await storedToken(env);
      const loginTime = await storedLoginTime(env);
      return result({
        status: configured && Boolean(env.ZERODHA_TOKEN_STORE) ? "CONFIGURED" : "CONFIG_REQUIRED",
        broker: "m.Stock",
        auth_mode: "TYPE_A_TOTP",
        totp: true,
        totp_secret_configured: Boolean(env.MSTOCK_TOTP_SECRET?.trim()),
        api_key_configured: Boolean(env.MSTOCK_API_KEY?.trim()),
        kv_storage_configured: Boolean(env.ZERODHA_TOKEN_STORE),
        access_token_stored: Boolean(token),
        token_expired: token ? expired(token, loginTime) : null,
        token_expiry: expiry(token, loginTime),
        read_only: true,
      });
    }
  );

  server.registerTool(
    "mstock_login",
    {
      description: "Authenticate m.Stock Type A using the Cloudflare MSTOCK_TOTP_SECRET. The Worker generates the current TOTP automatically. A manual 6-digit TOTP is supported as a fallback. Read-only.",
      inputSchema: { totp: z.string().regex(/^\d{6}$/).optional() },
    },
    async ({ totp }) => {
      try {
        return result(await loginWithTotp(env, totp));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result({
          status: message.startsWith("MSTOCK_TOTP_INVALID:") ? "TOTP_INVALID" : "ERROR",
          broker: "m.Stock",
          auth_mode: "TYPE_A_TOTP",
          totp: true,
          message: message.replace(/^MSTOCK_[A-Z_]+:\s*/, ""),
          read_only: true,
        });
      }
    }
  );

  server.registerTool(
    "mstock_holdings",
    {
      description:
        "Return current m.Stock Type A long-term equity holdings. If the access token is missing or expired, automatically generate TOTP and authenticate. Read-only.",
      inputSchema: { totp: z.string().regex(/^\\d{6}$/).optional() },
    },
    async ({ totp }) => result(await getMStockHoldings(env, totp))
  );

  server.registerTool(
    "mstock_positions",
    {
      description: "Return live m.Stock Type A F&O/net positions. If the access token is missing or expired, automatically generate TOTP from MSTOCK_TOTP_SECRET, authenticate and return live positions. Read-only.",
      inputSchema: { totp: z.string().regex(/^\d{6}$/).optional() },
    },
    async ({ totp }) => {
      try {
        const r = await liveOrTotp(env, totp);
        if (!r.live) return result(r.auth);
        const t = pnl(r.data.open, r.data.all);
        return result({
          status: "LIVE",
          broker: "m.Stock",
          auth_mode: "TYPE_A_TOTP",
          totp: true,
          open_positions: r.data.open,
          all_net_positions: r.data.all,
          live_unrealised_pnl: t.unrealised,
          realised_pnl: t.realised,
          token_expiry: r.data.tokenExpiry,
          source: "m.Stock Type A /openapi/typea/portfolio/positions",
          read_only: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result({ status: "ERROR", broker: "m.Stock", message: message.replace(/^MSTOCK_[A-Z_]+:\s*/, ""), read_only: true });
      }
    }
  );

  server.registerTool(
    "mstock_dashboard",
    {
      description: "Return a concise live m.Stock dashboard with positions and P&L. If authentication is required, automatically generate TOTP from MSTOCK_TOTP_SECRET. Read-only.",
      inputSchema: { totp: z.string().regex(/^\d{6}$/).optional() },
    },
    async ({ totp }) => {
      try {
        const r = await liveOrTotp(env, totp);
        if (!r.live) return result(r.auth);
        const t = pnl(r.data.open, r.data.all);
        return result({
          status: "LIVE",
          broker: "m.Stock",
          dashboard: {
            connection: "LIVE",
            auth: "Type A / TOTP",
            open_positions: r.data.open.length,
            live_unrealised_pnl: t.unrealised,
            realised_pnl: t.realised,
            token_expiry: r.data.tokenExpiry,
            positions: r.data.open,
          },
          read_only: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result({ status: "ERROR", broker: "m.Stock", message: message.replace(/^MSTOCK_[A-Z_]+:\s*/, ""), read_only: true });
      }
    }
  );

  server.registerTool(
    "mstock_self_test",
    {
      description: "Run a read-only m.Stock Type A TOTP self-test for configuration, KV storage, authentication and live positions.",
    },
    async () => {
      const configured = Boolean(env.MSTOCK_API_KEY?.trim() && env.MSTOCK_TOTP_SECRET?.trim());
      const storage = Boolean(env.ZERODHA_TOKEN_STORE);
      const token = await storedToken(env);
      const loginTime = await storedLoginTime(env);

      const checks: Record<string, string> = {
        configuration: configured ? "PASS" : "FAIL",
        kv_storage: storage ? "PASS" : "FAIL",
        authentication: token ? (expired(token, loginTime) ? "EXPIRED" : "PASS") : "REQUIRED",
        live_positions: "NOT_RUN",
      };
      const errors: Record<string, string> = {};

      if (!configured) errors.configuration = "MSTOCK_API_KEY and MSTOCK_TOTP_SECRET are required.";
      if (!storage) errors.kv_storage = "ZERODHA_TOKEN_STORE KV binding is missing.";

      if (configured && storage && token && !expired(token, loginTime)) {
        try {
          const data = await positions(env);
          checks.live_positions = "PASS";
          const t = pnl(data.open, data.all);
          return result({
            status: "PASS",
            broker: "m.Stock",
            auth_mode: "TYPE_A_TOTP",
            totp: true,
            checks,
            passed: Object.values(checks).filter(v => v === "PASS").length,
            total: Object.keys(checks).length,
            live_unrealised_pnl: t.unrealised,
            open_positions: data.open.length,
            token_expiry: data.tokenExpiry,
            errors,
            read_only: true,
          });
        } catch (error) {
          checks.live_positions = "FAIL";
          errors.live_positions = error instanceof Error ? error.message : String(error);
        }
      } else if (checks.authentication === "REQUIRED") {
        errors.authentication = "No access token. The next positions request will automatically generate TOTP.";
      } else if (checks.authentication === "EXPIRED") {
        errors.authentication = "Access token expired. The next positions request will automatically generate TOTP.";
      }

      const hardFailures = Object.values(checks).filter(v => v === "FAIL").length;
      return result({
        status: hardFailures ? "FAIL" : "AUTH_REQUIRED",
        broker: "m.Stock",
        auth_mode: "TYPE_A_TOTP",
        totp: true,
        checks,
        passed: Object.values(checks).filter(v => v === "PASS").length,
        total: Object.keys(checks).length,
        errors,
        read_only: true,
      });
    }
  );
}

// Deployment refresh: ensure latest Cloudflare m.Stock secrets are active in production.

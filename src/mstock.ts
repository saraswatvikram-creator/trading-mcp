import { z } from "zod";

type MStockEnv = {
  MSTOCK_API_KEY?: string;
  MSTOCK_USERNAME?: string;
  MSTOCK_PASSWORD?: string;
  MSTOCK_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
};

const BASE = "https://api.mstock.trade";
const VERSION = "1";
const OTP_COOLDOWN_SECONDS = 90;

function config(env: MStockEnv) {
  const apiKey = env.MSTOCK_API_KEY?.trim();
  const username = env.MSTOCK_USERNAME?.trim();
  const password = env.MSTOCK_PASSWORD ?? "";
  const store = env.ZERODHA_TOKEN_STORE;

  if (!apiKey || !username || !password) {
    throw new Error("MSTOCK_CONFIG_REQUIRED: Missing MSTOCK_API_KEY, MSTOCK_USERNAME or MSTOCK_PASSWORD.");
  }
  if (!store) {
    throw new Error("MSTOCK_STORAGE_REQUIRED: ZERODHA_TOKEN_STORE KV binding is required for the daily m.Stock session.");
  }
  return { apiKey, username, password, store };
}

async function storedToken(env: MStockEnv) {
  const value = await env.ZERODHA_TOKEN_STORE?.get("mstock_access_token");
  return value?.trim() || env.MSTOCK_ACCESS_TOKEN?.trim() || null;
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
    return typeof payload.exp === "number"
      ? new Date(payload.exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

function midnightExpiry(loginTime: string | null) {
  if (!loginTime) return null;
  const m = loginTime.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+05:30`);
  if (Number.isNaN(parsed.getTime())) return null;
  const expiry = new Date(parsed);
  expiry.setUTCHours(18, 30, 0, 0);
  if (expiry <= parsed) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry.toISOString();
}

function expiry(token: string | null, loginTime: string | null) {
  return jwtExpiry(token) ?? midnightExpiry(loginTime);
}

function expired(token: string | null, loginTime: string | null) {
  const e = expiry(token, loginTime);
  return e !== null && new Date(e).getTime() <= Date.now();
}

function cleanError(prefix: string, message: string) {
  return message.startsWith(prefix) ? message.slice(prefix.length).trim() : message;
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
    if (/otp|incorrect|expired/i.test(message)) {
      throw new Error("MSTOCK_OTP_INVALID: " + message);
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

async function requestOtp(env: MStockEnv) {
  const { username, password, store } = config(env);
  const prior = await store.get("mstock_otp_requested_at");

  if (prior) {
    const age = Math.floor((Date.now() - Number(prior)) / 1000);
    if (Number.isFinite(age) && age >= 0 && age < OTP_COOLDOWN_SECONDS) {
      return {
        status: "OTP_ALREADY_SENT",
        auth_mode: "TYPE_A_NORMAL_OTP",
        retry_after_seconds: OTP_COOLDOWN_SECONDS - age,
        message: "A normal m.Stock OTP was already requested recently. Use that OTP.",
        read_only: true,
      };
    }
  }

  const data = await postForm("/openapi/typea/connect/login", { username, password });
  await store.put("mstock_otp_requested_at", String(Date.now()), { expirationTtl: OTP_COOLDOWN_SECONDS });

  return {
    status: "OTP_SENT",
    auth_mode: "TYPE_A_NORMAL_OTP",
    totp: false,
    message: "m.Stock accepted the credentials and sent a normal OTP. TOTP is not used.",
    broker_response: {
      status: data?.status ?? null,
      client_id: data?.data?.cid ?? null,
      name: data?.data?.nm ?? null,
    },
    read_only: true,
  };
}

async function loginWithOtp(env: MStockEnv, otp: string) {
  const { apiKey, store } = config(env);
  const clean = otp.trim();
  if (!/^\d{6}$/.test(clean)) throw new Error("MSTOCK_OTP_INVALID: OTP must be exactly 6 digits.");

  const data = await postForm("/openapi/typea/session/token", {
    api_key: apiKey,
    request_token: clean,
    checksum: "L",
  });

  const accessToken = String(data?.data?.access_token ?? "").trim();
  if (!accessToken) throw new Error("MSTOCK_AUTH_ERROR: No access_token was returned by m.Stock.");

  const loginTime = String(data?.data?.login_time ?? new Date().toISOString());
  await store.put("mstock_access_token", accessToken);
  await store.put("mstock_login_time", loginTime);
  await store.delete("mstock_otp_requested_at");

  return {
    status: "CONNECTED",
    broker: "m.Stock",
    auth_mode: "TYPE_A_NORMAL_OTP",
    totp: false,
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

  if (!token) throw new Error("MSTOCK_AUTH_REQUIRED: No daily m.Stock access token is stored.");
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

async function liveOrOtp(env: MStockEnv, otp?: string) {
  try {
    if (otp) await loginWithOtp(env, otp);
    return { live: true as const, data: await positions(env) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("MSTOCK_AUTH_REQUIRED:") || message.startsWith("MSTOCK_AUTH_EXPIRED:")) {
      return {
        live: false as const,
        auth: {
          status: "OTP_REQUIRED",
          broker: "m.Stock",
          auth_mode: "TYPE_A_NORMAL_OTP",
          totp: false,
          reason: message.replace(/^MSTOCK_AUTH_(REQUIRED|EXPIRED):\s*/, ""),
          otp: await requestOtp(env),
          next_step: "Provide the 6-digit OTP in the same mstock_positions request; the tool will authenticate and return live positions.",
          read_only: true,
        },
      };
    }
    throw error;
  }
}

function result(payload: any) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function registerMStockTools(server: any, env: MStockEnv): void {
  server.registerTool(
    "mstock_auth_status",
    {
      description: "Check m.Stock Type A configuration and stored session state. Read-only. TOTP is not used.",
    },
    async () => {
      const configured = Boolean(env.MSTOCK_API_KEY?.trim() && env.MSTOCK_USERNAME?.trim() && env.MSTOCK_PASSWORD);
      const token = await storedToken(env);
      const loginTime = await storedLoginTime(env);
      return result({
        status: configured && Boolean(env.ZERODHA_TOKEN_STORE) ? "CONFIGURED" : "CONFIG_REQUIRED",
        broker: "m.Stock",
        auth_mode: "TYPE_A_NORMAL_OTP",
        totp: false,
        credentials_configured: configured,
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
      description: "Authenticate m.Stock Type A without TOTP. No otp sends the normal OTP; a 6-digit otp creates and persists the daily access token. Read-only.",
      inputSchema: { otp: z.string().regex(/^\d{6}$/).optional() },
    },
    async ({ otp }) => {
      try {
        return result(otp ? await loginWithOtp(env, otp) : await requestOtp(env));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result({
          status: message.startsWith("MSTOCK_OTP_INVALID:") ? "OTP_INVALID" : "ERROR",
          broker: "m.Stock",
          message: message.replace(/^MSTOCK_[A-Z_]+:\s*/, ""),
          read_only: true,
        });
      }
    }
  );

  server.registerTool(
    "mstock_positions",
    {
      description: "Return live m.Stock Type A F&O/net positions. If the daily token is missing or expired, automatically request the normal OTP. If otp is supplied, authenticate and immediately return live positions. Read-only; never places or modifies orders.",
      inputSchema: { otp: z.string().regex(/^\d{6}$/).optional() },
    },
    async ({ otp }) => {
      try {
        const r = await liveOrOtp(env, otp);
        if (!r.live) return result(r.auth);
        const t = pnl(r.data.open, r.data.all);
        return result({
          status: "LIVE",
          broker: "m.Stock",
          auth_mode: "TYPE_A_NORMAL_OTP",
          totp: false,
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
        return result({
          status: "ERROR",
          broker: "m.Stock",
          message: message.replace(/^MSTOCK_[A-Z_]+:\s*/, ""),
          read_only: true,
        });
      }
    }
  );

  server.registerTool(
    "mstock_dashboard",
    {
      description: "Return a concise live m.Stock dashboard with positions and P&L. If authentication is required, automatically request the normal OTP. Read-only.",
      inputSchema: { otp: z.string().regex(/^\d{6}$/).optional() },
    },
    async ({ otp }) => {
      try {
        const r = await liveOrOtp(env, otp);
        if (!r.live) return result(r.auth);
        const t = pnl(r.data.open, r.data.all);
        return result({
          status: "LIVE",
          broker: "m.Stock",
          dashboard: {
            connection: "LIVE",
            auth: "Type A / normal OTP",
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
        return result({
          status: "ERROR",
          broker: "m.Stock",
          message: message.replace(/^MSTOCK_[A-Z_]+:\s*/, ""),
          read_only: true,
        });
      }
    }
  );

  server.registerTool(
    "mstock_self_test",
    {
      description: "Run a read-only m.Stock Type A self-test for configuration, KV storage, authentication and live positions. TOTP is never used.",
    },
    async () => {
      const configured = Boolean(env.MSTOCK_API_KEY?.trim() && env.MSTOCK_USERNAME?.trim() && env.MSTOCK_PASSWORD);
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

      if (!configured) errors.configuration = "Missing m.Stock secrets.";
      if (!storage) errors.kv_storage = "ZERODHA_TOKEN_STORE KV binding is missing.";

      if (configured && storage && token && !expired(token, loginTime)) {
        try {
          const data = await positions(env);
          checks.live_positions = "PASS";
          const t = pnl(data.open, data.all);
          return result({
            status: "PASS",
            broker: "m.Stock",
            auth_mode: "TYPE_A_NORMAL_OTP",
            totp: false,
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
        errors.authentication = "No daily access token. The next live command will request the normal OTP.";
      } else if (checks.authentication === "EXPIRED") {
        errors.authentication = "Daily access token expired. The next live command will request a fresh normal OTP.";
      }

      const hardFailures = Object.values(checks).filter(v => v === "FAIL").length;
      return result({
        status: hardFailures ? "FAIL" : "AUTH_REQUIRED",
        broker: "m.Stock",
        auth_mode: "TYPE_A_NORMAL_OTP",
        totp: false,
        checks,
        passed: Object.values(checks).filter(v => v === "PASS").length,
        total: Object.keys(checks).length,
        errors,
        read_only: true,
      });
    }
  );
}

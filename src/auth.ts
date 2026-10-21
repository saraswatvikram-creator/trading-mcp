import { getAngelOneHoldings } from "./angelone";
import { getGrowwHoldings } from "./groww";
import { getMStockHoldings } from "./mstock";
import { getFivePaisaHoldings, getFivePaisaLoginUrl } from "./fivepaisa";

type AuthEnv = {
  ZERODHA_API_KEY?: string;
  ZERODHA_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
  ANGELONE_API_KEY?: string;
  ANGELONE_CLIENT_ID?: string;
  ANGELONE_PIN?: string;
  ANGELONE_TOTP_SECRET?: string;
  GROWW_TOTP_TOKEN?: string;
  GROWW_TOTP_SECRET?: string;
  MSTOCK_API_KEY?: string;
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
  ICICIDIRECT_MCP_URL?: string;
  ICICIDIRECT_MCP_ACCESS_TOKEN?: string;
};

type BrokerResult = {
  broker: string;
  status: "VALID" | "AUTHENTICATION_REQUIRED" | "FAILED" | "NOT_CONFIGURED";
  message: string;
  action_url: string;
  auth_mode: string;
  token_expiry?: string | null;
};

async function getZerodhaToken(env: AuthEnv): Promise<string | null> {
  if (env.ZERODHA_TOKEN_STORE) {
    const stored = await env.ZERODHA_TOKEN_STORE.get("access_token");
    if (stored) return stored;
  }
  return env.ZERODHA_ACCESS_TOKEN ?? null;
}

async function validateZerodha(env: AuthEnv): Promise<{valid:boolean; message:string}> {
  if (!env.ZERODHA_API_KEY) {
    return { valid: false, message: "ZERODHA_API_KEY is not configured." };
  }

  const token = await getZerodhaToken(env);
  if (!token) {
    return { valid: false, message: "No Zerodha access token is stored. Complete Zerodha login." };
  }

  const response = await fetch("https://api.kite.trade/user/profile", {
    headers: {
      "X-Kite-Version": "3",
      Authorization: "token " + env.ZERODHA_API_KEY + ":" + token,
    },
  });

  const data = await response.json();
  if (!response.ok || data?.status !== "success") {
    return {
      valid: false,
      message: "Zerodha API rejected the current access token. Complete Zerodha login again.",
    };
  }

  return { valid: true, message: "Zerodha API session validated successfully." };
}

async function validateAngelOne(env: AuthEnv): Promise<{valid:boolean; message:string}> {
  try {
    const result = await getAngelOneHoldings(env);
    if (result?.authenticated === true) {
      return { valid: true, message: "AngelOne SmartAPI authentication and API validation succeeded." };
    }
    return { valid: false, message: "AngelOne authentication did not return a valid authenticated session." };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateGroww(env: AuthEnv): Promise<{valid:boolean; message:string; token_expiry?:string|null}> {
  try {
    const result = await getGrowwHoldings(env);
    if (result?.authenticated === true) {
      return {
        valid: true,
        message: "Groww TOTP authentication, access-token generation and Holdings API validation succeeded.",
        token_expiry: result?.token_expiry ?? null,
      };
    }
    return { valid: false, message: "Groww authentication did not return an authenticated session." };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateMStock(env: AuthEnv): Promise<{valid:boolean; message:string; token_expiry?:string|null}> {
  try {
    const result = await getMStockHoldings(env);
    if (result?.status === "LIVE" || result?.authenticated === true) {
      return {
        valid: true,
        message: "m.Stock Type A TOTP authentication and Holdings API validation succeeded.",
        token_expiry: result?.token_expiry ?? null,
      };
    }
    return {
      valid: false,
      message: result?.reason ?? result?.message ?? "m.Stock authentication did not return a live session.",
    };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateFivePaisa(env: AuthEnv, baseUrl: string): Promise<{valid:boolean; message:string; token_expiry?:string|null; auth_mode?:string}> {
  try {
    const result = await getFivePaisaHoldings(env, baseUrl);
    if (result?.authenticated === true) {
      return {
        valid: true,
        message: "5Paisa session authentication and Holdings API validation succeeded.",
        token_expiry: result?.token_expiry ?? null,
        auth_mode: result?.auth_mode ?? "ACTIVE",
      };
    }
    return { valid: false, message: "5Paisa authentication did not return an authenticated session." };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateICICIDirect(env: AuthEnv): Promise<{valid:boolean; message:string; status:"VALID"|"FAILED"|"NOT_CONFIGURED"; action_url:string}> {
  const configuredUrl = env.ICICIDIRECT_MCP_URL?.trim();
  const token = env.ICICIDIRECT_MCP_ACCESS_TOKEN;
  if (!configuredUrl || !token) {
    return {
      valid: false,
      status: "NOT_CONFIGURED",
      message: "ICICIdirect Breeze verification is not configured. Set ICICIDIRECT_MCP_URL and ICICIDIRECT_MCP_ACCESS_TOKEN as Worker secrets/variables.",
      action_url: configuredUrl || "",
    };
  }

  try {
    // Accept either the Breeze Worker base URL or its /mcp URL, but always
    // call the dedicated live session-verification endpoint.
    const base = new URL(configuredUrl);
    if (base.protocol !== "https:") {
      return { valid: false, status: "FAILED", message: "ICICIdirect verification URL must use HTTPS.", action_url: configuredUrl };
    }
    const verifyUrl = new URL("/api/verify-session", base.origin);
    const response = await fetch(verifyUrl.toString(), {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-store",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    let data: any;
    try { data = await response.json(); } catch {
      return { valid: false, status: "FAILED", message: "Breeze verification returned invalid JSON (HTTP " + response.status + ").", action_url: configuredUrl };
    }
    if (response.ok && data?.brokerSessionVerified === true && data?.brokerConnected === true) {
      return { valid: true, status: "VALID", message: "ICICIdirect Breeze session live-verified successfully at " + (data.checkedAt ?? "the current check") + ".", action_url: configuredUrl };
    }
    const reason = typeof data?.error === "string" ? data.error : "live session verification did not confirm a connected broker";
    return { valid: false, status: "FAILED", message: "ICICIdirect Breeze session is not verified (" + reason + ", HTTP " + response.status + "). Run Update Auth1 for the Breeze service if broker login is required.", action_url: configuredUrl };
  } catch (error) {
    // Do not echo raw network/runtime errors into the auth report; they can
    // contain internal host details. Keep timeout diagnostics useful but safe.
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "request timed out after 8 seconds"
      : "network or verification request failed";
    return { valid: false, status: "FAILED", message: "ICICIdirect Breeze verification failed: " + reason, action_url: configuredUrl };
  }
}

function result(
  broker: string,
  check: {valid:boolean; message:string; token_expiry?:string|null; auth_mode?:string},
  actionUrl: string,
  defaultAuthMode: string
): BrokerResult {
  return {
    broker,
    status: check.valid ? "VALID" : "AUTHENTICATION_REQUIRED",
    message: check.message,
    action_url: actionUrl,
    auth_mode: check.auth_mode ?? defaultAuthMode,
    token_expiry: check.token_expiry ?? null,
  };
}

export async function runUpdateAuth(env: AuthEnv, baseUrl: string): Promise<any> {
  const actionUrls = {
    Zerodha: new URL("/auth/zerodha", baseUrl).toString(),
    AngelOne: new URL("/auth/angelone", baseUrl).toString(),
    Groww: new URL("/auth/groww", baseUrl).toString(),
    "5Paisa": new URL("/auth/fivepaisa", baseUrl).toString(),
    "m.Stock": new URL("/auth/mstock", baseUrl).toString(),
  };

  const [zerodha, angelone, groww, fivepaisa, mstock, icici] = await Promise.all([
    validateZerodha(env),
    validateAngelOne(env),
    validateGroww(env),
    validateFivePaisa(env, baseUrl),
    validateMStock(env),
    validateICICIDirect(env),
  ]);

  const brokers: BrokerResult[] = [
    result("Zerodha", zerodha, actionUrls.Zerodha, "Kite API session"),
    result("AngelOne", angelone, actionUrls.AngelOne, "SmartAPI + TOTP"),
    result("Groww", groww, actionUrls.Groww, "API access token + TOTP"),
    result("5Paisa", fivepaisa, actionUrls["5Paisa"], fivepaisa.auth_mode ?? "AUTO_TOTP/OAuth"),
    result("m.Stock", mstock, actionUrls["m.Stock"], "Type A + TOTP"),
    { broker: "ICICIdirect Breeze", status: icici.status, message: icici.message, action_url: icici.action_url, auth_mode: "Breeze live-session verification", token_expiry: null },
  ];

  // Breeze is an optional sixth integration. Its absence or failure must never
  // block the original five-broker Trading Desk workflow.
  const coreBrokers = brokers.filter((b) => b.broker !== "ICICIdirect Breeze");
  const validCount = coreBrokers.filter((b) => b.status === "VALID").length;
  const allValid = validCount === coreBrokers.length;
  const anyValid = validCount > 0;

  return {
    // Readiness is broker-independent: partial connectivity must not block
    // reports from the brokers whose API sessions are valid.
    status: allValid ? "READY" : anyValid ? "PARTIAL_READY" : "NOT_READY",
    authentication: brokers,
    tool_refresh: {
      status: "REQUIRES_CHATGPT_PLUGIN_REFRESH",
      message: "Broker authentication is fully automated. The ChatGPT plugin tool catalogue must be refreshed once after this tool is first deployed so ChatGPT can load the new Update Auth tool.",
    },
    downstream_ready: anyValid,
    available_brokers: brokers.filter((b) => b.status === "VALID").map((b) => b.broker),
    unavailable_brokers: brokers.filter((b) => b.status !== "VALID").map((b) => b.broker),
    optional_integrations: { ICICIDirect: { status: icici.status, live_verified: icici.valid, message: icici.message } },
    next_commands: anyValid
      ? ["update trades", "update P/L", "update investments"]
      : [],
    read_only: true,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusIcon(status: BrokerResult["status"]): string {
  return status === "VALID" ? "🟢" : "🔴";
}

export async function handleAuthRoute(
  request: Request,
  env: AuthEnv,
  baseUrl: string,
  broker: string
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    if (broker === "zerodha") {
      const check = await validateZerodha(env);
      if (!check.valid) {
        return Response.redirect(new URL("/login", baseUrl).toString(), 302);
      }
      return new Response(
        "<!doctype html><html><head><title>Zerodha Authentication</title></head><body><h2>🟢 Zerodha Authentication Successful</h2><p>" +
          escapeHtml(check.message) +
          "</p><p>You can close this window.</p></body></html>",
        { headers: { "content-type": "text/html; charset=UTF-8" } }
      );
    }

    if (broker === "angelone") {
      const check = await validateAngelOne(env);
      return new Response(authHtml("AngelOne", check.valid, check.message), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    if (broker === "groww") {
      const check = await validateGroww(env);
      return new Response(authHtml("Groww", check.valid, check.message), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    if (broker === "mstock") {
      const check = await validateMStock(env);
      return new Response(authHtml("m.Stock", check.valid, check.message), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    if (broker === "fivepaisa") {
      const check = await validateFivePaisa(env, baseUrl);
      if (check.valid) {
        return new Response(authHtml("5Paisa", true, check.message), {
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }

      const loginUrl = await getFivePaisaLoginUrl(env, baseUrl);
      return Response.redirect(loginUrl, 302);
    }

    return new Response("Unknown broker", { status: 404 });
  } catch (error) {
    return new Response(
      authHtml(
        broker,
        false,
        error instanceof Error ? error.message : String(error)
      ),
      { status: 502, headers: { "content-type": "text/html; charset=UTF-8" } }
    );
  }
}

function authHtml(broker: string, valid: boolean, message: string): string {
  const icon = valid ? "🟢" : "🔴";
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>" +
    escapeHtml(broker) +
    " Authentication</title></head><body><h2>" +
    icon +
    " " +
    escapeHtml(broker) +
    " Authentication " +
    (valid ? "Successful" : "Failed") +
    "</h2><p>" +
    escapeHtml(message) +
    "</p><p>" +
    (valid ? "You can close this window." : "Correct the broker configuration/session and run Update Auth again.") +
    "</p></body></html>";
}

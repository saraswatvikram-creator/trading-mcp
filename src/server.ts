import { McpServer } from "@modelcontextprotocol/server";
import { registerAngelOneTools, getAngelOneHoldings, getAngelOneMargin } from "./angelone";
import { registerGrowwTools, getGrowwHoldings, getGrowwMargin } from "./groww";
import { registerMStockTools, getMStockHoldings, getMStockMargin } from "./mstock";
import { registerFivePaisaTools, handleFivePaisaCallback, getFivePaisaHoldings, getFivePaisaMargin } from "./fivepaisa";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { runUpdateAuth, handleAuthRoute } from "./auth";

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

async function getZerodhaInvestmentHoldings(env: Env): Promise<any> {
  const response = await zerodhaGet("/portfolio/holdings", env) as any;
  const rows = Array.isArray(response?.data) ? response.data : [];
  const equity = rows.map((r: any) => {
    // Kite reports settled and T+1 quantities separately. Include both when
    // valuing the holding, otherwise ETFs in T+1 settlement can appear as zero.
    const settledQuantity = Number(r?.quantity ?? 0);
    const t1Quantity = Number(r?.t1_quantity ?? 0);
    const quantity = settledQuantity + t1Quantity;
    const average = Number(r?.average_price);
    const ltp = Number(r?.last_price);
    const investmentValue = Number.isFinite(average) ? average * quantity : null;
    const currentValue = Number.isFinite(ltp) ? ltp * quantity : null;
    const computedPnl = investmentValue !== null && currentValue !== null
      ? currentValue - investmentValue
      : null;
    const brokerPnl = r?.pnl !== null && r?.pnl !== undefined && r?.pnl !== ""
      ? Number(r.pnl)
      : null;
    const pnl = computedPnl !== null ? computedPnl : (brokerPnl !== null && Number.isFinite(brokerPnl) ? brokerPnl : null);
    return {
      asset_class: "ETF / Equity",
      symbol: r?.tradingsymbol ?? null,
      exchange: r?.exchange ?? null,
      isin: r?.isin ?? null,
      quantity,
      settled_quantity: settledQuantity,
      t1_quantity: t1Quantity,
      average_price: Number.isFinite(average) ? average : null,
      ltp: Number.isFinite(ltp) ? ltp : null,
      investment_value: investmentValue,
      current_value: currentValue,
      pnl,
      pnl_percent: pnl !== null && investmentValue ? (pnl / investmentValue) * 100 : null,
      source: "Zerodha Kite /portfolio/holdings",
    };
  });

  const mfResponse = await zerodhaGet("/mf/holdings", env) as any;
  const mfRows = Array.isArray(mfResponse?.data) ? mfResponse.data : [];
  const mutualFunds = mfRows.map((r: any) => {
    const quantity = Number(r?.quantity ?? 0);
    const average = Number(r?.average_price);
    const ltp = Number(r?.last_price);
    const investmentValue = Number.isFinite(average) ? average * quantity : null;
    const currentValue = Number.isFinite(ltp) ? ltp * quantity : null;
    // Kite MF holdings can report pnl=0 even while average NAV and latest NAV
    // differ. Prefer a computed cost-basis P&L when both values are available.
    const computedPnl = investmentValue !== null && currentValue !== null
      ? currentValue - investmentValue
      : null;
    const reportedPnl = r?.pnl !== null && r?.pnl !== undefined && r?.pnl !== ""
      ? Number(r.pnl)
      : null;
    const pnl = computedPnl !== null
      ? computedPnl
      : (reportedPnl !== null && Number.isFinite(reportedPnl) ? reportedPnl : null);
    return {
      asset_class: "Mutual Fund",
      fund: r?.fund ?? null,
      symbol: r?.tradingsymbol ?? null,
      isin: r?.isin ?? r?.tradingsymbol ?? null,
      folio: r?.folio ?? null,
      quantity,
      average_price: Number.isFinite(average) ? average : null,
      ltp: Number.isFinite(ltp) ? ltp : null,
      investment_value: investmentValue,
      current_value: currentValue,
      pnl,
      pnl_percent: pnl !== null && investmentValue ? (pnl / investmentValue) * 100 : null,
      source: "Zerodha Kite Connect /mf/holdings",
    };
  });

  const holdings = [...equity, ...mutualFunds];
  const sumValues = (items: any[]) => items.reduce((s: any, h: any) => {
    if (Number.isFinite(h.investment_value)) s.investment_value += h.investment_value;
    if (Number.isFinite(h.current_value)) s.current_value += h.current_value;
    return s;
  }, { investment_value: 0, current_value: 0 });
  const summary = sumValues(holdings);
  summary.pnl = summary.current_value - summary.investment_value;
  summary.pnl_percent = summary.investment_value ? (summary.pnl / summary.investment_value) * 100 : null;
  const by_asset_class = {
    "ETF / Equity": { ...sumValues(equity), holding_count: equity.length },
    "Mutual Fund": { ...sumValues(mutualFunds), holding_count: mutualFunds.length },
  };
  for (const bucket of Object.values(by_asset_class) as any[]) {
    bucket.pnl = bucket.current_value - bucket.investment_value;
    bucket.pnl_percent = bucket.investment_value ? (bucket.pnl / bucket.investment_value) * 100 : null;
  }
  return {
    authenticated: true,
    broker: "Zerodha",
    holdings,
    summary,
    by_asset_class,
    sources: {
      equity_etfs: "Zerodha Kite /portfolio/holdings",
      mutual_funds: "Zerodha Kite Connect /mf/holdings (Coin-related MF holdings endpoint; may not exactly match Coin UI NAV timing)",
    },
    reconciliation: {
      status: "API_DATA_ONLY",
      note: "Coin UI is not independently queried by this worker. Kite ETF/equity and mutual-fund endpoint values are combined; verify against Coin UI if NAV timing or fund-level valuation differs.",
    },
    read_only: true,
  };
}

async function getZerodhaMargin(env: Env): Promise<any> {
  const response = await zerodhaGet("/user/margins", env) as any;
  const equity = response?.data?.equity ?? {};
  const available = equity?.available ?? {};
  const utilised = equity?.utilised ?? {};
  const numeric = (value: any): number | null =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;

  return {
    status: "LIVE",
    broker: "Zerodha",
    available_for_options: numeric(equity?.net),
    available_for_options_source_field: "data.equity.net",
    net_available_margin: numeric(equity?.net),
    available_cash: numeric(available?.cash),
    collateral: numeric(available?.collateral),
    liquid_collateral_utilised: numeric(utilised?.liquid_collateral),
    stock_collateral_utilised: numeric(utilised?.stock_collateral),
    margin_utilised: numeric(utilised?.debits),
    span_utilised: numeric(utilised?.span),
    exposure_utilised: numeric(utilised?.exposure),
    option_premium_utilised: numeric(utilised?.option_premium),
    realised_mtm: numeric(utilised?.m2m_realised),
    unrealised_mtm: numeric(utilised?.m2m_unrealised),
    source: "Zerodha Kite /user/margins (equity segment)",
    as_of: new Date().toISOString(),
    read_only: true,
  };
}

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
  // DAILY AUTHENTICATION GATE
  // ==========================================================
  server.registerTool(
    "update_auth",
    {
      description:
        "Run the daily Trading Desk authentication gate. Validate and, where configured, automatically authenticate Zerodha, AngelOne, Groww, 5Paisa and m.Stock. Return broker-specific authentication hyperlinks, final broker status, and Trading Desk readiness. Read-only; never places, modifies, cancels or squares off orders.",
    },
    async () => {
      const payload = await runUpdateAuth(env, baseUrl);
      const rows = payload.authentication
        .map((item: any, index: number) =>
          `| ${index + 1} | **${item.broker}** | [Complete Authentication](${item.action_url}) | ${item.status === "VALID" ? "🟢 VALID" : "🔴 UNAVAILABLE"} — ${item.message} |`
        )
        .join("\n");

      const toolStatus =
        payload.tool_refresh.status === "READY"
          ? "🟢 READY"
          : "🟡 ONE-TIME CHATGPT ACTION REQUIRED";

      const text = [
        "## Update Auth",
        "",
        "| # | Broker / Component | Action | Status |",
        "|---:|---|---|---|",
        rows,
        `| 6 | **Zerodha Trading Desk** | Refresh Tools in the ChatGPT plugin | ${toolStatus} |`,
        `| 7 | **Trading Desk** | Final authentication check | ${payload.status === "READY" ? "🟢 READY" : "🔴 NOT READY"} |`,
        "",
        payload.status === "READY"
          ? "### Trading Desk READY — all five brokers authenticated"
          : payload.status === "PARTIAL_READY"
            ? "### Trading Desk PARTIALLY READY — continue with authenticated brokers"
            : "### Trading Desk NOT READY — no broker authenticated",
        "",
        payload.status === "READY" || payload.status === "PARTIAL_READY"
          ? "Run **Update Trades** only. The consolidated report includes the investment sections. Each report should include every broker whose authentication/API call succeeds and identify unavailable brokers individually; one broker failure must not block the others."
          : "No broker is currently authenticated, so broker data cannot be refreshed. Complete at least one broker authentication and run **Update Auth** again.",
        "",
        "### Automation note",
        payload.tool_refresh.message,
        "",
        "Read-only authentication workflow. No trading action is performed.",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
      };
    }
  );


  // ==========================================================
  // CONSOLIDATED INVESTMENTS
  // ==========================================================
  server.registerTool(
    "update_investments",
    {
      description: "LEGACY COMPATIBILITY ONLY. Returns the Investments Dashboard for comparison during migration. Does not update the shared investment baseline; only Update Trades advances that baseline. Use Update Trades for the consolidated daily report. Read-only.",
    },
    async () => {
      const results = await Promise.allSettled([
        getZerodhaInvestmentHoldings(env),
        getAngelOneHoldings(env, true),
        getGrowwHoldings(env),
        getFivePaisaHoldings(env, baseUrl),
        getMStockHoldings(env),
      ]);

      // Margin retrieval is independent of holdings: one margin API failure must
      // not suppress portfolio data. Run it after holdings so m.Stock can reuse
      // the session established by its holdings call where possible.
      const angelOneMargin = results[1].status === "fulfilled"
        ? (results[1].value as any)?.margin ?? null
        : null;
      const marginResults = await Promise.allSettled([
        getZerodhaMargin(env),
        angelOneMargin ? Promise.resolve(angelOneMargin) : getAngelOneMargin(env),
        getGrowwMargin(env),
        getFivePaisaMargin(env, baseUrl),
        getMStockMargin(env),
      ]);

      const names = ["Zerodha", "Angel One", "Groww", "5Paisa", "m.Stock"];
      const brokers: any[] = [];
      const holdings: any[] = [];
      // Server-side baseline is authoritative. This keeps ChatGPT and the
      // browser dashboard identical and avoids browser/session-specific baselines.
      const snapshotKey = "investments:last-investment-values:v2";
      const previousInvestment: Record<string, number> = {};
      let baselineAvailable = false;
      let snapshotError: string | null = null;

      if (!env.ZERODHA_TOKEN_STORE) {
        snapshotError = "Investment baseline storage (ZERODHA_TOKEN_STORE) is unavailable.";
      } else {
        try {
          const stored = await env.ZERODHA_TOKEN_STORE.get(snapshotKey, "json");
          if (stored && typeof stored === "object") {
            Object.assign(previousInvestment, stored);
            baselineAvailable = Object.keys(previousInvestment).length > 0;
          }
        } catch (error) {
          snapshotError = error instanceof Error ? error.message : String(error);
        }
      }

      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          const v: any = r.value;
          const rawInvestmentValue = v?.summary?.investment_value;
          const rawCurrentValue = v?.summary?.current_value;
          const investmentValue = typeof rawInvestmentValue === "number" && Number.isFinite(rawInvestmentValue)
            ? rawInvestmentValue
            : null;
          const currentValue = typeof rawCurrentValue === "number" && Number.isFinite(rawCurrentValue)
            ? rawCurrentValue
            : null;
          const validHoldingSummary = investmentValue !== null && currentValue !== null;
          const hasPrevious = Object.prototype.hasOwnProperty.call(previousInvestment, names[i]);
          brokers.push({
            broker: names[i],
            status: validHoldingSummary ? "LIVE" : "PARTIAL",
            error: validHoldingSummary ? null : "Holdings response did not contain valid numeric invested and current values.",
            investment_value: investmentValue,
            new_investment_since_last_update: baselineAvailable && hasPrevious && investmentValue !== null
              ? investmentValue - previousInvestment[names[i]]
              : null,
            current_value: currentValue,
            pnl: typeof v?.summary?.pnl === "number" && Number.isFinite(v.summary.pnl) ? v.summary.pnl : null,
            pnl_percent: typeof v?.summary?.pnl_percent === "number" && Number.isFinite(v.summary.pnl_percent) ? v.summary.pnl_percent : null,
          });
          for (const h of v?.holdings ?? []) holdings.push({ broker: names[i], ...h });
        } else {
          brokers.push({
            broker: names[i],
            status: "ERROR",
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            investment_value: null,
            new_investment_since_last_update: null,
            current_value: null,
            pnl: null,
            pnl_percent: null,
          });
        }
      });

      // Only advance the baseline after a complete five-broker live retrieval.
      // If one broker fails, retain the previous baseline so a temporary API
      // outage cannot erase the next-update comparison.
      const allBrokersLive = brokers.length === names.length && brokers.every(
        (b) => b.status === "LIVE" && Number.isFinite(b.investment_value)
      );

      // Legacy command is deliberately non-mutating during migration.
      // The consolidated Update Trades command is the sole writer of this shared baseline.
      const baselineStatus = baselineAvailable
        ? "READ_ONLY — baseline is advanced only by Update Trades"
        : "UNAVAILABLE — baseline not yet established by Update Trades";

      const total = holdings.reduce((s: any, h: any) => {
        if (Number.isFinite(h.investment_value)) s.investment_value += h.investment_value;
        if (Number.isFinite(h.current_value)) s.current_value += h.current_value;
        return s;
      }, { investment_value: 0, current_value: 0 });
      total.pnl = total.current_value - total.investment_value;
      const liveBrokers = brokers.filter((b) => b.status === "LIVE");
      const knownNewInvestments = liveBrokers.filter(
        (b) => b.new_investment_since_last_update !== null
      );
      total.new_investment_since_last_update =
        liveBrokers.length === names.length &&
        knownNewInvestments.length === names.length
          ? knownNewInvestments.reduce((s: number, b: any) => s + b.new_investment_since_last_update, 0)
          : null;
      total.pnl_percent = total.investment_value ? (total.pnl / total.investment_value) * 100 : null;

      const marginBrokers = marginResults.map((r, i) => {
        if (r.status === "fulfilled") {
          const value: any = r.value;
          const available = value?.available_for_options;
          const availableNumber = available !== null && available !== undefined && Number.isFinite(Number(available))
            ? Number(available)
            : null;
          return {
            broker: names[i],
            status: value?.status === "LIVE" && availableNumber !== null ? "LIVE" : "PARTIAL",
            error: value?.status === "LIVE" ? null : (value?.error ?? value?.message ?? "Margin endpoint did not return a live available amount."),
            available_for_options: availableNumber,
            available_for_options_source_field: value?.available_for_options_source_field ?? null,
            available_balance: value?.available_balance ?? value?.available_cash ?? value?.clear_cash ?? value?.ledger_balance ?? null,
            collateral: value?.collateral ?? value?.collateral_available ?? value?.collateral_after_haircut ?? null,
            margin_utilised: value?.margin_utilised ?? value?.net_margin_used ?? null,
            option_premium_utilised: value?.option_premium_utilised ?? value?.options_premium_utilised ?? value?.option_buy_premium_utilised ?? null,
            source: value?.source ?? null,
            as_of: value?.as_of ?? new Date().toISOString(),
          };
        }
        return {
          broker: names[i],
          status: "ERROR",
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          available_for_options: null,
          available_for_options_source_field: null,
          available_balance: null,
          collateral: null,
          margin_utilised: null,
          option_premium_utilised: null,
          source: null,
          as_of: null,
        };
      });
      const allMarginsLive = marginBrokers.length === names.length && marginBrokers.every(
        (b) => b.status === "LIVE" && Number.isFinite(b.available_for_options)
      );
      const marginTotal = allMarginsLive
        ? marginBrokers.reduce((sum, broker) => sum + Number(broker.available_for_options), 0)
        : null;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "LIVE",
            dashboard: "Investments",
            as_of: new Date().toISOString(),
            scope: "Equity, ETFs as represented in equity holdings, and Zerodha Coin mutual funds.",
            authentication: brokers.map((b) => ({ broker: b.broker, status: b.status, error: b.error })),
            portfolio_summary: { brokers, total },
            margin_summary: {
              status: allMarginsLive ? "LIVE" : "PARTIAL",
              definition: "Available margin/funds for options as reported by each broker's margin API. Source field is retained per broker. The total is shown only when all five APIs return a numeric available amount.",
              brokers: marginBrokers,
              total_available_for_options: marginTotal,
              complete: allMarginsLive,
              as_of: new Date().toISOString(),
            },
            new_investments: {
              status: baselineStatus,
              definition: "Change in investment/cost basis since the previous successful five-broker update; market price/NAV movement does not count as a new investment.",
              storage: env.ZERODHA_TOKEN_STORE ? "server_kv" : "unavailable",
              error: snapshotError,
            },
            holdings,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================
  // UPDATE TRADES — AVAILABLE OPTIONS MARGIN
  // ==========================================================
  server.registerTool(
    "update_trades_margin",
    {
      description: "Fetch Section 4 — Available Margin for Options and Sections 6–8 — Investment Portfolio Summary, Broker-wise Investment Status, and New Investment Tracking — for the consolidated Update Trades dashboard. Uses the five existing broker holdings adapters, includes Zerodha Coin mutual funds, and updates the same server-side investment baseline as Update Investments. Broker failures are isolated. Call on every Update Trades run. Read-only; never places, modifies, cancels or squares off orders.",
    },
    async () => {
      const names = ["Zerodha", "Angel One", "Groww", "5Paisa", "m.Stock"];
      const results = await Promise.allSettled([
        getZerodhaMargin(env),
        getAngelOneMargin(env),
        getGrowwMargin(env),
        getFivePaisaMargin(env, baseUrl),
        getMStockMargin(env),
      ]);

      const brokers = results.map((r, i) => {
        if (r.status === "fulfilled") {
          const value: any = r.value;
          const available = value?.available_for_options;
          const availableNumber =
            available !== null && available !== undefined && available !== "" &&
            Number.isFinite(Number(available))
              ? Number(available)
              : null;
          const live = value?.status === "LIVE" && availableNumber !== null;
          return {
            broker: names[i],
            status: live ? "LIVE" : "PARTIAL",
            error: live ? null : (value?.error ?? value?.message ?? "Margin endpoint did not return a live numeric available amount."),
            available_for_options: availableNumber,
            available_for_options_source_field: value?.available_for_options_source_field ?? null,
            available_balance: value?.available_balance ?? value?.available_cash ?? value?.clear_cash ?? value?.ledger_balance ?? null,
            collateral: value?.collateral ?? value?.collateral_available ?? value?.collateral_after_haircut ?? null,
            margin_utilised: value?.margin_utilised ?? value?.net_margin_used ?? null,
            option_premium_utilised: value?.option_premium_utilised ?? value?.options_premium_utilised ?? value?.option_buy_premium_utilised ?? null,
            source: value?.source ?? null,
            as_of: value?.as_of ?? new Date().toISOString(),
          };
        }
        return {
          broker: names[i],
          status: "ERROR",
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          available_for_options: null,
          available_for_options_source_field: null,
          available_balance: null,
          collateral: null,
          margin_utilised: null,
          option_premium_utilised: null,
          source: null,
          as_of: null,
        };
      });

      const complete = brokers.length === names.length && brokers.every(
        (b) => b.status === "LIVE" && Number.isFinite(b.available_for_options)
      );
      const total = complete
        ? brokers.reduce((sum, broker) => sum + Number(broker.available_for_options), 0)
        : null;
      const inr = (value: number | null) => value === null
        ? "UNAVAILABLE"
        : (value < 0 ? "−₹" + Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "₹" + value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
      const section = [
        "## Section 4 — Available Margin for Options",
        "",
        "Combined available margin reported by broker APIs",
        "",
        "# " + inr(total),
        "",
        complete ? "All five broker margin APIs returned live numeric values." : "Margin validation required — one or more broker values are unavailable. The combined total is withheld rather than estimated.",
        "",
        "| Broker | Available for options | Status |",
        "|---|---:|---|",
        ...brokers.map((b) => "| " + b.broker + " | " + inr(b.available_for_options) + " | " + b.status + (b.error ? " — " + b.error.replace(/\|/g, "/") : "") + " |"),
        "| **TOTAL** | **" + inr(total) + "** | " + (complete ? "LIVE" : "PARTIAL") + " |",
        "",
        "These values are broker-reported balances, not a recommendation to trade. Verify the balances before deploying new spreads."
      ].join("\n");


      // Sections 6–8: investment holdings, reusing the existing broker adapters.
      // Broker failures are isolated; no order-related API is called.
      const investmentResults = await Promise.allSettled([
        getZerodhaInvestmentHoldings(env),
        getAngelOneHoldings(env, true),
        getGrowwHoldings(env),
        getFivePaisaHoldings(env, baseUrl),
        getMStockHoldings(env),
      ]);
      const investmentNames = ["Zerodha", "Angel One", "Groww", "5Paisa", "m.Stock"];
      const snapshotKey = "investments:last-investment-values:v2";
      const previousInvestment: Record<string, number> = {};
      let baselineAvailable = false;
      let baselineError: string | null = null;
      if (!env.ZERODHA_TOKEN_STORE) {
        baselineError = "Investment baseline storage is unavailable.";
      } else {
        try {
          const stored = await env.ZERODHA_TOKEN_STORE.get(snapshotKey, "json");
          if (stored && typeof stored === "object") {
            Object.assign(previousInvestment, stored);
            baselineAvailable = Object.keys(previousInvestment).length > 0;
          }
        } catch (error) {
          baselineError = error instanceof Error ? error.message : String(error);
        }
      }

      const investmentBrokers = investmentResults.map((result, i) => {
        if (result.status !== "fulfilled") {
          return {
            broker: investmentNames[i], status: "ERROR",
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            investment_value: null, current_value: null, pnl: null, pnl_percent: null, net_change: null,
          };
        }
        const holdingResult: any = result.value;
        const summary: any = holdingResult?.summary ?? {};
        const invested = summary.investment_value;
        const current = summary.current_value;
        const pnl = summary.pnl;
        const validInvested = typeof invested === "number" && Number.isFinite(invested) ? invested : null;
        const validCurrent = typeof current === "number" && Number.isFinite(current) ? current : null;
        const validPnl = typeof pnl === "number" && Number.isFinite(pnl)
          ? pnl : (validInvested !== null && validCurrent !== null ? validCurrent - validInvested : null);
        const live = holdingResult?.authenticated === true || holdingResult?.status === "LIVE";
        const complete = live && validInvested !== null && validCurrent !== null;
        const hasPrevious = Object.prototype.hasOwnProperty.call(previousInvestment, investmentNames[i]);
        return {
          broker: investmentNames[i], status: complete ? "LIVE" : "PARTIAL",
          error: complete ? null : (holdingResult?.auth?.reason ?? holdingResult?.error ?? "Holdings response did not contain valid invested and current values."),
          investment_value: validInvested, current_value: validCurrent, pnl: validPnl,
          pnl_percent: typeof summary.pnl_percent === "number" && Number.isFinite(summary.pnl_percent)
            ? summary.pnl_percent : (validPnl !== null && validInvested ? validPnl / validInvested * 100 : null),
          net_change: baselineAvailable && hasPrevious && validInvested !== null
            ? validInvested - previousInvestment[investmentNames[i]] : null,
        };
      });

      const allInvestmentsLive = investmentBrokers.length === investmentNames.length &&
        investmentBrokers.every((b) => b.status === "LIVE" && b.investment_value !== null && b.current_value !== null);
      let investmentBaselineStatus = "UNAVAILABLE";
      if (env.ZERODHA_TOKEN_STORE && allInvestmentsLive) {
        const nextSnapshot: Record<string, number> = {};
        for (const broker of investmentBrokers) nextSnapshot[broker.broker] = Number(broker.investment_value);
        try {
          await env.ZERODHA_TOKEN_STORE.put(snapshotKey, JSON.stringify(nextSnapshot));
          investmentBaselineStatus = baselineAvailable ? "UPDATED" : "ESTABLISHED";
        } catch (error) {
          baselineError = error instanceof Error ? error.message : String(error);
        }
      }

      const sumInvestmentField = (field: "investment_value" | "current_value" | "pnl") =>
        investmentBrokers.reduce((sum, b) => sum + (typeof b[field] === "number" ? b[field] as number : 0), 0);
      const liveInvestmentCount = investmentBrokers.filter((b) => b.status === "LIVE").length;
      const investmentTotal: any = {
        investment_value: sumInvestmentField("investment_value"),
        current_value: sumInvestmentField("current_value"),
        pnl: sumInvestmentField("pnl"),
      };
      investmentTotal.pnl_percent = investmentTotal.investment_value
        ? investmentTotal.pnl / investmentTotal.investment_value * 100 : null;
      const netChangeKnown = allInvestmentsLive && investmentBrokers.every((b) => b.net_change !== null);
      const totalNetChange = netChangeKnown
        ? investmentBrokers.reduce((sum, b) => sum + Number(b.net_change), 0) : null;
      const investmentInr = (value: number | null | undefined) =>
        value === null || value === undefined || !Number.isFinite(Number(value))
          ? "UNAVAILABLE"
          : (Number(value) < 0 ? "−₹" + Math.abs(Number(value)).toLocaleString("en-IN", { maximumFractionDigits: 2 })
            : "₹" + Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
      const investmentPct = (value: number | null | undefined) =>
        value === null || value === undefined || !Number.isFinite(Number(value))
          ? "UNAVAILABLE" : Number(value).toFixed(2) + "%";

      const investmentSections = [
        "## Section 6 — Investment Portfolio Summary",
        "",
        "| Invested Value | Current Value | Unrealised P&L | Return | Data Status |",
        "|---:|---:|---:|---:|---|",
        "| " + investmentInr(investmentTotal.investment_value) + " | " + investmentInr(investmentTotal.current_value) + " | " + investmentInr(investmentTotal.pnl) + " | " + investmentPct(investmentTotal.pnl_percent) + " | " + (allInvestmentsLive ? "LIVE — 5/5 brokers" : "PARTIAL — " + liveInvestmentCount + "/5 brokers") + " |",
        "",
        "## Section 7 — Broker-wise Investment Status",
        "",
        "| Broker | Invested Value | Current Value | Unrealised P&L | Return | Status |",
        "|---|---:|---:|---:|---:|---|",
        ...investmentBrokers.map((b) => "| " + b.broker + " | " + investmentInr(b.investment_value) + " | " + investmentInr(b.current_value) + " | " + investmentInr(b.pnl) + " | " + investmentPct(b.pnl_percent) + " | " + b.status + (b.error ? " — " + b.error.replace(/\|/g, "/") : "") + " |"),
        "",
        "## Section 8 — New Investment Tracking",
        "",
        "Net change in reported investment/cost basis since the previous successful five-broker snapshot. Market price/NAV movement is excluded.",
        "",
        "| Broker | Net Change Since Previous Snapshot | Status |",
        "|---|---:|---|",
        ...investmentBrokers.map((b) => "| " + b.broker + " | " + investmentInr(b.net_change) + " | " + (b.net_change === null ? (b.status === "LIVE" ? "BASELINE UNAVAILABLE" : b.status) : "LIVE") + " |"),
        "| **TOTAL** | **" + investmentInr(totalNetChange) + "** | " + (netChangeKnown ? "LIVE" : "UNAVAILABLE — requires complete five-broker data and baseline") + " |",
        "",
        "Baseline: " + investmentBaselineStatus + (baselineError ? " — " + baselineError : ""),
        "Scope: Equity, ETFs as represented in broker equity holdings, and Zerodha Coin mutual funds."
      ].join("\n");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: complete ? "LIVE" : "PARTIAL",
            dashboard: "Update Trades — Available Margin for Options",
            margin_summary: {
              status: complete ? "LIVE" : "PARTIAL",
              definition: "Available margin/funds for options as reported by the same broker margin APIs used by Update Investments. The combined total is returned only when all five APIs provide live numeric amounts.",
              brokers,
              total_available_for_options: total,
              complete,
              as_of: new Date().toISOString(),
            },
            formatted_section: section + "\n\n" + investmentSections,
            investment_summary: {
              status: allInvestmentsLive ? "LIVE" : "PARTIAL",
              brokers: investmentBrokers,
              total: investmentTotal,
              scope: "Equity, ETFs as represented in equity holdings, and Zerodha Coin mutual funds.",
              as_of: new Date().toISOString(),
            },
            new_investments: {
              status: investmentBaselineStatus,
              total_net_change: totalNetChange,
              definition: "Change in investment/cost basis since the previous successful five-broker update; market price/NAV movement is excluded.",
              storage: env.ZERODHA_TOKEN_STORE ? "server_kv" : "unavailable",
              error: baselineError,
            },
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

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

    if (url.pathname.startsWith("/auth/")) {
      const broker = url.pathname.slice("/auth/".length).toLowerCase();
      return handleAuthRoute(request, env, url.origin, broker);
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
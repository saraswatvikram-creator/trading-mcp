import { McpServer } from "@modelcontextprotocol/server";
import { registerAngelOneTools, getAngelOneHoldings, getAngelOneMargin, getAngelOneTradesForLedger } from "./angelone";
import { registerGrowwTools, getGrowwHoldings, getGrowwMargin, getGrowwTradesForLedger } from "./groww";
import { registerMStockTools, getMStockHoldings, getMStockMargin, getMStockTradesForLedger } from "./mstock";
import { registerFivePaisaTools, handleFivePaisaCallback, getFivePaisaHoldings, getFivePaisaMargin, getFivePaisaTradesForLedger } from "./fivepaisa";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { runUpdateAuth, handleAuthRoute } from "./auth";
import { getLedgerCoverage, persistExecutions, calculateFifoRealisedPnl, type PnlExecution, type PnlBroker, type LedgerExecutionRow } from "./pnl-ledger";

type Env = {
  ZERODHA_API_KEY: string;
  ZERODHA_API_SECRET: string;
  ZERODHA_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;
  PNL_DB?: D1Database;

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
          `| ${index + 1} | **${item.broker}** | [Complete Authentication](${item.action_url}) | ${item.status === "VALID" ? "🟢 VALID" : "🔴 AUTHENTICATION REQUIRED"} |`
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
          ? "### Trading Desk READY"
          : "### Trading Desk NOT READY — complete the failed broker authentication link(s) above and run **Update Auth** again.",
        "",
        payload.status === "READY"
          ? "You can now run **Update Trades**, **Update P/L** and **Update Investments**. Update P/L also supports partial broker authentication and reports per-broker failures."
          : "Partial authentication does not block Update P/L: it processes brokers independently and flags unavailable sources. Complete failed broker authentication links for a fully live Trading Desk.",
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
  // DURABLE P&L LEDGER INITIALIZATION
  // ==========================================================
  server.registerTool(
    "pnl_ledger_initialize",
    {
      description: "Initialize or verify the durable execution ledger schema in D1. Does not require or create a manually supplied historical baseline. Safe to rerun; does not ingest trades or change P&L.",
    },
    async () => {
      if (!env.PNL_DB) {
        return { content: [{ type: "text", text: "BLOCKED: PNL_DB binding is missing. No data was changed." }] };
      }
      try {
        const db = env.PNL_DB;
        const statements = [
          `CREATE TABLE IF NOT EXISTS pnl_executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            broker TEXT NOT NULL CHECK (broker IN ('Zerodha','AngelOne','Groww','5Paisa','m.Stock')),
            execution_id TEXT NOT NULL, order_id TEXT, exchange_order_id TEXT,
            trade_time TEXT NOT NULL, trading_symbol TEXT NOT NULL, exchange TEXT, segment TEXT,
            side TEXT NOT NULL CHECK (side IN ('BUY','SELL')), quantity REAL NOT NULL, price REAL NOT NULL,
            gross_value REAL NOT NULL, broker_realised_pnl REAL, charges REAL, taxes REAL,
            raw_json TEXT NOT NULL, source_endpoint TEXT NOT NULL,
            ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE (broker, execution_id)
          )`,
          "CREATE INDEX IF NOT EXISTS idx_pnl_exec_time ON pnl_executions(trade_time)",
          "CREATE INDEX IF NOT EXISTS idx_pnl_exec_broker_time ON pnl_executions(broker, trade_time)",
          `CREATE TABLE IF NOT EXISTS pnl_ingestion_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, broker TEXT NOT NULL, started_at TEXT NOT NULL,
            completed_at TEXT, status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
            records_seen INTEGER NOT NULL DEFAULT 0, records_inserted INTEGER NOT NULL DEFAULT 0,
            records_duplicate INTEGER NOT NULL DEFAULT 0, coverage_start TEXT, coverage_end TEXT,
            source_endpoint TEXT, error TEXT
          )`,
          "CREATE INDEX IF NOT EXISTS idx_pnl_runs_started ON pnl_ingestion_runs(started_at)",
          `CREATE TABLE IF NOT EXISTS pnl_reconciliation (
            id INTEGER PRIMARY KEY AUTOINCREMENT, report_date TEXT NOT NULL, broker TEXT NOT NULL,
            status TEXT NOT NULL, details_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          )`,
        ];
        for (const sql of statements) await db.prepare(sql).run();
        return { content: [{ type: "text", text: "READY: durable execution-ledger schema verified/initialized automatically. No historical baseline was requested, inserted, or modified. Historical coverage is determined by broker-source records actually available." }] };
      } catch (error) {
        return { content: [{ type: "text", text: "LEDGER INITIALIZATION FAILED: " + (error instanceof Error ? error.message : String(error)) }] };
      }
    }
  );

  // ==========================================================
  // DURABLE P&L EXECUTION INGESTION
  // ==========================================================
  // Shared ingestion runner: Update P/L invokes the same per-broker-isolated workflow.
  const runPnlIngestion = async () => {
      if (!env.PNL_DB) {
        return { content: [{ type: "text", text: "BLOCKED: PNL_DB binding missing. No executions ingested." }] };
      }
      // Self-provision the required ledger tables so the user does not need to
      // run a separate initialization or manually apply a schema migration.
      const schemaStatements = [
        `CREATE TABLE IF NOT EXISTS pnl_executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          broker TEXT NOT NULL CHECK (broker IN ('Zerodha','AngelOne','Groww','5Paisa','m.Stock')),
          execution_id TEXT NOT NULL, order_id TEXT, exchange_order_id TEXT,
          trade_time TEXT NOT NULL, trading_symbol TEXT NOT NULL, exchange TEXT, segment TEXT,
          side TEXT NOT NULL CHECK (side IN ('BUY','SELL')), quantity REAL NOT NULL, price REAL NOT NULL,
          gross_value REAL NOT NULL, broker_realised_pnl REAL, charges REAL, taxes REAL,
          raw_json TEXT NOT NULL, source_endpoint TEXT NOT NULL,
          ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE (broker, execution_id)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_pnl_exec_time ON pnl_executions(trade_time)",
        "CREATE INDEX IF NOT EXISTS idx_pnl_exec_broker_time ON pnl_executions(broker, trade_time)",
        `CREATE TABLE IF NOT EXISTS pnl_ingestion_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, broker TEXT NOT NULL, started_at TEXT NOT NULL,
          completed_at TEXT, status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
          records_seen INTEGER NOT NULL DEFAULT 0, records_inserted INTEGER NOT NULL DEFAULT 0,
          records_duplicate INTEGER NOT NULL DEFAULT 0, coverage_start TEXT, coverage_end TEXT,
          source_endpoint TEXT, error TEXT
        )`,
        "CREATE INDEX IF NOT EXISTS idx_pnl_runs_started ON pnl_ingestion_runs(started_at)"
      ];
      for (const sql of schemaStatements) await env.PNL_DB.prepare(sql).run();
      const startedAt = new Date().toISOString();
      const outcomes: any[] = [];
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const baseUrl = new URL("https://trading-mcp.saraswat-vikram.workers.dev").origin;

      const normalizeSide = (value: unknown): "BUY" | "SELL" | null => {
        const v = String(value ?? "").trim().toUpperCase();
        if (["BUY", "B", "1"].includes(v)) return "BUY";
        if (["SELL", "S", "2"].includes(v)) return "SELL";
        return null;
      };
      const toNumber = (...values: unknown[]): number | null => {
        for (const value of values) {
          if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))) return Number(value);
        }
        return null;
      };
      const toIso = (value: unknown): string | null => {
        if (typeof value !== "string" || !value.trim()) return null;
        const text = value.trim();
        // Broker tradebooks commonly return local exchange time without an
        // offset. Interpret these explicitly as India Standard Time rather
        // than letting the Worker runtime silently treat them as UTC.
        const dmy = text.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
        if (dmy) {
          const indiaTime = new Date(dmy[3] + "-" + dmy[2] + "-" + dmy[1] + "T" + dmy[4] + "+05:30");
          return Number.isNaN(indiaTime.getTime()) ? null : indiaTime.toISOString();
        }
        const ymdLocal = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
        if (ymdLocal) {
          const indiaTime = new Date(ymdLocal[1] + "T" + ymdLocal[2] + "+05:30");
          return Number.isNaN(indiaTime.getTime()) ? null : indiaTime.toISOString();
        }
        const dateOnly = text.match(/^(\d{4}-\d{2}-\d{2})$/);
        if (dateOnly) {
          const indiaDate = new Date(dateOnly[1] + "T00:00:00+05:30");
          return Number.isNaN(indiaDate.getTime()) ? null : indiaDate.toISOString();
        }
        const parsed = new Date(text);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
      };
      const ingest = async (
        broker: PnlBroker,
        rows: any[],
        endpoint: string,
        mapper: (row: any) => PnlExecution | null,
        coverageStart: string | null,
        coverageEnd: string | null,
        sourceStatus: "SUCCESS" | "PARTIAL" = "SUCCESS",
        sourceError?: string,
      ) => {
        const mapped: PnlExecution[] = [];
        let rejected = 0;
        for (const row of rows) {
          const execution = mapper(row);
          if (!execution) rejected++;
          else mapped.push(execution);
        }
        const status = sourceStatus === "PARTIAL" || rejected > 0 ? "PARTIAL" : "SUCCESS";
        const result = await persistExecutions(
          env.PNL_DB!, broker, mapped, endpoint, coverageStart, coverageEnd,
          startedAt, new Date().toISOString(), status,
          [sourceError, rejected ? String(rejected) + " source rows rejected because stable execution ID or required execution fields were missing/unrecognised" : null].filter(Boolean).join("; ") || undefined,
        );
        outcomes.push({ ...result, sourceRowsRejected: rejected, coverageStart, coverageEnd, sourceEndpoint: endpoint });
      };

      try {
        const response: any = await zerodhaGet("/trades", env);
        const rows = Array.isArray(response?.data) ? response.data : [];
        await ingest("Zerodha", rows, "Kite Connect GET /trades (current day only)", (row) => {
          const executionId = row?.trade_id === undefined || row?.trade_id === null ? null : String(row.trade_id);
          const side = normalizeSide(row?.transaction_type);
          const quantity = toNumber(row?.quantity);
          const price = toNumber(row?.price, row?.average_price);
          const tradeTime = toIso(row?.exchange_timestamp ?? row?.fill_timestamp ?? row?.order_timestamp);
          if (!executionId || !side || !quantity || !price || !tradeTime || !row?.tradingsymbol) return null;
          return {
            broker: "Zerodha", executionId, orderId: row?.order_id == null ? null : String(row.order_id),
            exchangeOrderId: row?.exchange_order_id == null && row?.EXCH_ORDER_NUMBER == null ? null : String(row?.exchange_order_id ?? row?.EXCH_ORDER_NUMBER),
            tradeTime, tradingSymbol: String(row.tradingsymbol), exchange: row?.exchange ?? null,
            segment: row?.instrument_token ? String(row.instrument_token) : row?.product ?? null,
            side, quantity, price, brokerRealisedPnl: null, charges: null, taxes: null,
            raw: row, sourceEndpoint: "Kite Connect GET /trades (current day only)",
          };
        }, today, today, "SUCCESS");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { await persistExecutions(env.PNL_DB, "Zerodha", [], "Kite Connect GET /trades (current day only)", today, today, startedAt, new Date().toISOString(), "FAILED", message); } catch { /* A ledger audit-write failure must not block the other brokers. */ }
        outcomes.push({ broker: "Zerodha", status: "FAILED", error: message, recordsSeen: 0, recordsInserted: 0, recordsDuplicate: 0 });
      }

      try {
        const result = await getFivePaisaTradesForLedger(env, baseUrl);
        await ingest("5Paisa", result.trades, result.endpoint, (row) => {
          const executionIdRaw = row?.ExchangeTradeID ?? row?.ExchangeTradeId ?? row?.TradeID ?? row?.TradeId ?? row?.TradeNo ?? row?.TradeNumber;
          const executionId = executionIdRaw == null ? null : String(executionIdRaw);
          const side = normalizeSide(row?.BuySell ?? row?.BuySellFlag ?? row?.TransactionType ?? row?.TrdType);
          const quantity = toNumber(row?.TradeQty, row?.Qty, row?.Quantity, row?.TradedQty);
          const price = toNumber(row?.TradeRate, row?.Rate, row?.Price, row?.TradePrice);
          const timeValue = row?.ExchangeTradeTime ?? row?.TradeTime ?? row?.ExchangeTime ?? row?.OrderTime ?? row?.TrdTime;
          const tradeTime = toIso(timeValue);
          const symbol = row?.ScripName ?? row?.Symbol ?? row?.TradingSymbol ?? row?.ScripCode;
          if (!executionId || !side || !quantity || !price || !tradeTime || symbol == null) return null;
          return {
            broker: "5Paisa", executionId, orderId: row?.ExchOrderID == null && row?.OrderID == null ? null : String(row?.ExchOrderID ?? row?.OrderID),
            exchangeOrderId: row?.ExchangeOrderID == null ? null : String(row.ExchangeOrderID),
            tradeTime, tradingSymbol: String(symbol), exchange: row?.Exch ?? row?.Exchange ?? null,
            segment: row?.ExchType ?? row?.Segment ?? null, side, quantity, price,
            brokerRealisedPnl: null, charges: null, taxes: null, raw: row, sourceEndpoint: result.endpoint,
          };
        }, null, null, "SUCCESS", result.coverage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { await persistExecutions(env.PNL_DB, "5Paisa", [], "5Paisa POST /V1/TradeBook", null, null, startedAt, new Date().toISOString(), "FAILED", message); } catch { /* A ledger audit-write failure must not block the other brokers. */ }
        outcomes.push({ broker: "5Paisa", status: "FAILED", error: message, recordsSeen: 0, recordsInserted: 0, recordsDuplicate: 0 });
      }

      try {
        const result = await getAngelOneTradesForLedger(env);
        await ingest("AngelOne", result.trades, result.endpoint, (row) => {
          const id = row?.fillid ?? row?.fillId ?? row?.tradeid ?? row?.trade_id;
          const executionId = id == null ? null : String(id);
          const side = normalizeSide(row?.transactiontype ?? row?.transaction_type);
          const quantity = toNumber(row?.fillsize, row?.quantity, row?.fillquantity);
          const price = toNumber(row?.fillprice, row?.price);
          const timeValue = row?.filltime ?? row?.exchtime ?? row?.tradetime;
          let tradeTime = toIso(timeValue);
          if (!tradeTime && typeof timeValue === "string" && /^\d{2}:\d{2}:\d{2}$/.test(timeValue)) tradeTime = toIso(today + "T" + timeValue + "+05:30");
          if (!executionId || !side || !quantity || price === null || !tradeTime || !row?.tradingsymbol) return null;
          return { broker: "AngelOne", executionId, orderId: row?.orderid == null ? null : String(row.orderid), exchangeOrderId: row?.exchangeorderid == null ? null : String(row.exchangeorderid), tradeTime, tradingSymbol: String(row.tradingsymbol), exchange: row?.exchange ?? null, segment: row?.producttype ?? row?.instrumenttype ?? null, side, quantity, price, brokerRealisedPnl: null, charges: null, taxes: null, raw: row, sourceEndpoint: result.endpoint };
        }, today, today, "SUCCESS");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { await persistExecutions(env.PNL_DB, "AngelOne", [], "GET /rest/secure/angelbroking/order/v1/getTradeBook", today, today, startedAt, new Date().toISOString(), "FAILED", message); } catch { /* A ledger audit-write failure must not block the other brokers. */ }
        outcomes.push({ broker: "AngelOne", status: "FAILED", error: message, recordsSeen: 0, recordsInserted: 0, recordsDuplicate: 0 });
      }

      try {
        const result = await getGrowwTradesForLedger(env);
        await ingest("Groww", result.trades, result.endpoint, (row) => {
          const id = row?.groww_trade_id ?? row?.exchange_trade_id;
          const executionId = id == null ? null : String(id);
          const side = normalizeSide(row?.transaction_type);
          const quantity = toNumber(row?.quantity);
          const price = toNumber(row?.price);
          const tradeTime = toIso(row?.trade_date_time ?? row?.created_at);
          if (!executionId || !side || !quantity || price === null || !tradeTime || !row?.trading_symbol) return null;
          return { broker: "Groww", executionId, orderId: row?.groww_order_id == null ? null : String(row.groww_order_id), exchangeOrderId: row?.exchange_order_id == null ? null : String(row.exchange_order_id), tradeTime, tradingSymbol: String(row.trading_symbol), exchange: row?.exchange ?? null, segment: row?.segment ?? null, side, quantity, price, brokerRealisedPnl: null, charges: null, taxes: null, raw: row, sourceEndpoint: result.endpoint };
        }, today, today, "SUCCESS", "Orders examined: " + result.ordersSeen);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { await persistExecutions(env.PNL_DB, "Groww", [], "GET /v1/order/list + GET /v1/order/trades/{groww_order_id}", today, today, startedAt, new Date().toISOString(), "FAILED", message); } catch { /* A ledger audit-write failure must not block the other brokers. */ }
        outcomes.push({ broker: "Groww", status: "FAILED", error: message, recordsSeen: 0, recordsInserted: 0, recordsDuplicate: 0 });
      }

      try {
        const result = await getMStockTradesForLedger(env);
        await ingest("m.Stock", result.trades, result.endpoint, (row) => {
          const id = row?.trade_id ?? row?.tradeid ?? row?.trade_no ?? row?.fill_id ?? row?.exchange_trade_id ?? row?.TRADE_NUMBER;
          const executionId = id == null ? null : String(id);
          const side = normalizeSide(row?.transaction_type ?? row?.transactiontype ?? row?.buy_sell ?? row?.BUY_SELL);
          const quantity = toNumber(row?.quantity, row?.traded_quantity, row?.fill_quantity, row?.QUANTITY);
          const price = toNumber(row?.price, row?.trade_price, row?.average_price, row?.PRICE);
          const tradeTime = toIso(row?.trade_time ?? row?.trade_date_time ?? row?.trade_date ?? row?.filltime ?? row?.order_timestamp ?? row?.ORDER_DATE_TIME);
          const symbol = row?.trading_symbol ?? row?.tradingsymbol ?? row?.symbol ?? row?.SYMBOL;
          if (!executionId || !side || !quantity || price === null || !tradeTime || !symbol) return null;
          return { broker: "m.Stock", executionId, orderId: row?.order_id == null && row?.orderid == null && row?.ORDER_NUMBER == null ? null : String(row?.order_id ?? row?.orderid ?? row?.ORDER_NUMBER), exchangeOrderId: row?.exchange_order_id == null && row?.EXCH_ORDER_NUMBER == null ? null : String(row?.exchange_order_id ?? row?.EXCH_ORDER_NUMBER), tradeTime, tradingSymbol: String(symbol), exchange: row?.exchange ?? row?.EXCHANGE ?? null, segment: row?.segment ?? row?.product ?? row?.SEGMENT ?? null, side, quantity, price, brokerRealisedPnl: null, charges: null, taxes: null, raw: row, sourceEndpoint: result.endpoint };
        }, today, today, "SUCCESS");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { await persistExecutions(env.PNL_DB, "m.Stock", [], "GET /openapi/typea/tradebook", today, today, startedAt, new Date().toISOString(), "FAILED", message); } catch { /* A ledger audit-write failure must not block the other brokers. */ }
        outcomes.push({ broker: "m.Stock", status: "FAILED", error: message, recordsSeen: 0, recordsInserted: 0, recordsDuplicate: 0 });
      }
      return { content: [{ type: "text", text: JSON.stringify({
        status: outcomes.some((x) => x.status === "FAILED" || x.status === "PARTIAL" || x.status === "NOT_INGESTED") ? "PARTIAL" : "SUCCESS",
        generatedAt: new Date().toISOString(),
        duplicateProtection: "UNIQUE(broker, execution_id) + INSERT OR IGNORE in D1",
        realisedPnl: "Not calculated from fills. Broker-reported realised P&L and fees are not populated by these endpoints; this is execution ingestion only.",
        historicalBaselineUsed: false,
        brokers: outcomes,
      }, null, 2) }] };
  };

  server.registerTool(
    "pnl_ingest_executions",
    {
      description: "Read-only, duplicate-safe ingestion of current-day execution records from all five broker APIs. Reports row-level rejections and broker failures; does not infer realised P&L from positions or orders.",
    },
    async () => runPnlIngestion(),
  );

  // ==========================================================
  // DURABLE P&L LEDGER HEALTH
  // ==========================================================
  server.registerTool(
    "pnl_ledger_status",
    {
      description: "Read-only health and coverage check for the durable D1 P&L execution ledger. Reports stored executions by broker and whether broker-reported realised P&L is present. Does not change ledger data.",
    },
    async () => {
      if (!env.PNL_DB) {
        return { content: [{ type: "text", text: [
          "# P&L Ledger Status",
          "",
          "**Status: BLOCKED — D1 binding missing**",
          "",
          "The Worker has no PNL_DB binding. The durable ledger is not active. Bind PNL_DB to the provisioned Cloudflare D1 database and apply migrations/0001_pnl_ledger.sql before relying on ledger coverage.",
          "The existing KV binding is for tokens and audit metadata; it is not the transaction ledger.",
        ].join("\\n") }] };
      }
      try {
        const coverage = await getLedgerCoverage(env.PNL_DB as any);
        const rows = (coverage as any[]).map((row) =>
          `| ${row.broker} | ${row.executions} | ${row.first_execution ?? "—"} | ${row.last_execution ?? "—"} | ${row.rows_with_realised_pnl} |`
        ).join("\\n");
        return { content: [{ type: "text", text: [
          "# P&L Ledger Status",
          "",
          "**Status: D1 CONNECTED — ingestion coverage only**",
          "",
          "| Broker | Stored executions | First execution | Latest execution | Rows with broker-reported realised P&L |",
          "|---|---:|---|---|---:|",
          rows || "| — | 0 | — | — | 0 |",
          "",
          "An empty ledger or missing realised-P&L fields is not proof of zero P&L. This health check does not certify accounting completeness.",
        ].join("\\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: "P&L ledger query failed: " + (error instanceof Error ? error.message : String(error)) }] };
      }
    }
  );

  // ==========================================================
  // HISTORICAL P&L LEDGER / RECONCILIATION AUDIT
  // ==========================================================
  server.registerTool(
    "update_pnl",
    {
      description: "Refresh both Historical P&L tables from one durable execution ledger. Does not read, preserve, or require a manually entered historical baseline. Automatically runs Update Auth and attempts each broker independently. Explicitly flags incomplete broker tradebook coverage; never treats open-position MTM as realised P&L. Read-only broker APIs; only ledger/audit metadata is written.",
    },
    async () => {
      const now = new Date();
      const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const auditKey = `pnl:reconciliation:audit:${dateKey}`;
      const baseUrl = new URL("https://trading-mcp.saraswat-vikram.workers.dev").origin;
      const issues: string[] = [];
      // Update P/L runs the same authentication gate as Update Auth so the
      // workflow is connected end-to-end, without relying on the user to run
      // a separate chat first. Partial broker authentication is recorded but
      // does not prevent healthy brokers from being ingested.
      let authenticationStatus = "UNAVAILABLE";
      let authenticationBrokers: any[] = [];
      try {
        const authPayload: any = await runUpdateAuth(env, baseUrl);
        authenticationStatus = String(authPayload?.status ?? "UNKNOWN");
        authenticationBrokers = Array.isArray(authPayload?.authentication)
          ? authPayload.authentication
          : [];
        for (const brokerAuth of authenticationBrokers) {
          if (brokerAuth?.status !== "VALID") {
            issues.push(String(brokerAuth?.broker ?? "Unknown broker") + " authentication is not VALID; its feed may be unavailable.");
          }
        }
        if (authenticationStatus !== "READY") {
          issues.push("Update Auth gate did not return READY; ingestion will continue broker-by-broker and realised P&L remains unconfirmed.");
        }
      } catch (error) {
        authenticationStatus = "FAILED";
        issues.push("Update Auth gate failed: " + (error instanceof Error ? error.message : String(error)) + ". Broker ingestion will still attempt independent sources.");
      }

      let ingestionStatus = "UNAVAILABLE";
      let ingestionBrokers: any[] = [];
      try {
        const ingestionResponse: any = await runPnlIngestion();
        const ingestionText = ingestionResponse?.content?.find((item: any) => item?.type === "text")?.text;
        if (typeof ingestionText === "string") {
          try {
            const parsed = JSON.parse(ingestionText);
            ingestionStatus = String(parsed?.status ?? "UNKNOWN");
            ingestionBrokers = Array.isArray(parsed?.brokers) ? parsed.brokers : [];
            for (const brokerResult of ingestionBrokers) {
              if (brokerResult?.status === "FAILED" || brokerResult?.status === "PARTIAL") {
                issues.push(String(brokerResult.broker) + " execution ingestion " + String(brokerResult.status) + ": " + String(brokerResult.error ?? brokerResult.sourceRowsRejected ?? "source coverage incomplete"));
              }
            }
            if (parsed?.status !== "SUCCESS" && parsed?.status !== "PARTIAL") {
              issues.push("Execution ingestion did not return a recognized completion status.");
            }
          } catch {
            ingestionStatus = "UNPARSEABLE_RESPONSE";
            issues.push("Execution ingestion returned an unparseable response; no new realised P&L was posted.");
          }
        } else {
          ingestionStatus = "NO_RESPONSE";
          issues.push("Execution ingestion returned no text response; no new realised P&L was posted.");
        }
      } catch (error) {
        ingestionStatus = "FAILED";
        issues.push("Execution ingestion runner failed: " + (error instanceof Error ? error.message : String(error)));
      }
      let storageStatus = "UNAVAILABLE";
      let ledgerRows: LedgerExecutionRow[] = [];
      let ledgerQueryError: string | null = null;
      let coverageRows: any[] = [];
      if (!env.PNL_DB) {
        issues.push("PNL_DB is not bound; no durable execution ledger is available.");
      } else {
        try {
          const result: any = await env.PNL_DB.prepare(
            "SELECT broker, trade_time, trading_symbol, exchange, segment, side, quantity, price, charges, taxes, broker_realised_pnl FROM pnl_executions ORDER BY trade_time ASC"
          ).all();
          ledgerRows = Array.isArray(result?.results) ? result.results as LedgerExecutionRow[] : [];
          coverageRows = await getLedgerCoverage(env.PNL_DB as any) as any[];
          storageStatus = "D1_READ_WRITE_AVAILABLE";
        } catch (error) {
          ledgerQueryError = error instanceof Error ? error.message : String(error);
          issues.push("Could not read the durable execution ledger: " + ledgerQueryError);
        }
      }

      // Compute all report periods from one shared FIFO ledger. No manually
      // entered baseline or second report is used as an input.
      const fifo = calculateFifoRealisedPnl(ledgerRows);
      const brokers: PnlBroker[] = ["Zerodha", "AngelOne", "Groww", "5Paisa", "m.Stock"];
      const nowDate = new Date();
      const isoAtIndiaMidnight = (date: string) => new Date(date + "T00:00:00+05:30").toISOString();
      const dayStart = isoAtIndiaMidnight(dateKey);
      const dateObj = new Date(dateKey + "T12:00:00+05:30");
      const weekday = dateObj.getUTCDay();
      const daysSinceMonday = (weekday + 6) % 7;
      const monday = new Date(dateObj.getTime() - daysSinceMonday * 86400000);
      const mondayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(monday);
      const monthKey = dateKey.slice(0, 7) + "-01";
      const fyStartYear = Number(dateKey.slice(0, 4)) - (Number(dateKey.slice(5, 7)) < 4 ? 1 : 0);
      const currentFyLabel = "FY " + fyStartYear + "–" + String(fyStartYear + 1).slice(-2);
      const fyStart = fyStartYear + "-04-01";
      const periodStart = { today: dayStart, week: isoAtIndiaMidnight(mondayKey), month: isoAtIndiaMidnight(monthKey), fy: isoAtIndiaMidnight(fyStart) };
      const inRange = (time: string, startTime: string, endTime?: string) => time >= startTime && (!endTime || time < endTime);
      const sumMatches = (items: typeof fifo.matches) => items.reduce((sum, m) => sum + m.grossPnl, 0);
      const lakh = (value: number) => (value / 100000).toFixed(2);
      const fmtPeriod = (items: typeof fifo.matches, broker?: PnlBroker) => {
        const selected = broker ? items.filter((m) => m.broker === broker) : items;
        return selected.length ? lakh(sumMatches(selected)) : "—";
      };
      const currentFyMatches = fifo.matches.filter((m) => inRange(m.closeTime, periodStart.fy));
      const allMatches = fifo.matches;
      const currentPeriodMatches = {
        today: fifo.matches.filter((m) => inRange(m.closeTime, periodStart.today)),
        week: fifo.matches.filter((m) => inRange(m.closeTime, periodStart.week)),
        month: fifo.matches.filter((m) => inRange(m.closeTime, periodStart.month)),
        fy: currentFyMatches,
        all: allMatches,
      };
      const brokerRows = brokers.map((broker) =>
        "| " + broker + " | " + fmtPeriod(currentPeriodMatches.today, broker) + " | " +
        fmtPeriod(currentPeriodMatches.week, broker) + " | " +
        fmtPeriod(currentPeriodMatches.month, broker) + " | " +
        fmtPeriod(currentPeriodMatches.fy, broker) + " | " +
        fmtPeriod(currentPeriodMatches.all, broker) + " |"
      ).join("\n");
      const consolidatedRow = "| **Consolidated realised gross P&L** | **" +
        fmtPeriod(currentPeriodMatches.today) + "** | **" +
        fmtPeriod(currentPeriodMatches.week) + "** | **" +
        fmtPeriod(currentPeriodMatches.month) + "** | **" +
        fmtPeriod(currentPeriodMatches.fy) + "** | **" +
        fmtPeriod(currentPeriodMatches.all) + "** |";

      const availableTimes = ledgerRows.map((r) => r.trade_time).filter((v) => typeof v === "string").sort();
      const firstAvailable = availableTimes[0] ?? null;
      const lastAvailable = availableTimes[availableTimes.length - 1] ?? null;
      const hasIncompleteCostData = ledgerRows.some((r) => r.charges === null || r.charges === undefined || r.taxes === null || r.taxes === undefined);
      const coverageSummary = brokers.map((broker) => {
        const c = coverageRows.find((row) => row.broker === broker);
        return { broker, executions: Number(c?.executions ?? 0), first: c?.first_execution ?? null, last: c?.last_execution ?? null };
      });
      if (ledgerRows.length === 0) issues.push("The execution ledger contains no transactions; realised P&L cannot be computed from an empty ledger.");
      if (hasIncompleteCostData) issues.push("Brokerage and taxes are missing on one or more execution records; net P&L cannot be asserted from the current ledger.");
      if (coverageSummary.some((c) => c.executions === 0)) issues.push("One or more brokers have no stored executions; consolidated all-time history is not complete.");
      issues.push("Historical coverage is limited to records actually returned by broker APIs and stored in the ledger. No user-entered baseline is used.");
      issues.push("Interest is not exposed by the execution feeds used here; net P&L and income tax remain unconfirmed until source-backed values are available.");
      const allHistoryYears = new Set<number>();
      for (const row of ledgerRows) {
        const d = new Date(row.trade_time);
        if (!Number.isNaN(d.getTime())) {
          const indiaYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).format(d));
          const indiaMonth = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", month: "2-digit" }).format(d));
          allHistoryYears.add(indiaMonth >= 4 ? indiaYear : indiaYear - 1);
        }
      }
      const currentYearForFy = fyStartYear;
      allHistoryYears.add(currentYearForFy);
      const years = [...allHistoryYears].sort((a, b) => a - b);
      const yearlyRows = years.map((fyYear) => {
        const start = isoAtIndiaMidnight(fyYear + "-04-01");
        const end = isoAtIndiaMidnight((fyYear + 1) + "-04-01");
        const yearMatches = fifo.matches.filter((m) => inRange(m.closeTime, start, end));
        const gross = yearMatches.length ? lakh(sumMatches(yearMatches)) : "—";
        const yearExecutions = ledgerRows.filter((r) => inRange(r.trade_time, start, end));
        const costsComplete = yearExecutions.length > 0 && yearExecutions.every((r) => r.charges !== null && r.charges !== undefined && r.taxes !== null && r.taxes !== undefined);
        const chargesTaxes = costsComplete ? lakh(-yearExecutions.reduce((sum, r) => sum + Math.abs(Number(r.charges ?? 0)) + Math.abs(Number(r.taxes ?? 0)), 0)) : "—";
        return "| " + fyYear + "–" + String(fyYear + 1).slice(-2) + " | " + gross + " | " + chargesTaxes + " | — | — | — |";
      }).join("\n");
      const totalGross = allMatches.length ? lakh(sumMatches(allMatches)) : "—";
      const costRowsComplete = ledgerRows.length > 0 && ledgerRows.every((r) => r.charges !== null && r.charges !== undefined && r.taxes !== null && r.taxes !== undefined);
      const totalCosts = costRowsComplete ? lakh(-ledgerRows.reduce((sum, r) => sum + Math.abs(Number(r.charges ?? 0)) + Math.abs(Number(r.taxes ?? 0)), 0)) : "—";
      const audit = {
        report_date: dateKey,
        generated_at: nowDate.toISOString(),
        status: ledgerQueryError ? "LEDGER_READ_FAILED" : (ledgerRows.length && ingestionStatus === "SUCCESS" && !hasIncompleteCostData ? "LEDGER_CALCULATED_COSTS_PARTIAL" : "SOURCE_COVERAGE_LIMITED"),
        authentication_status: authenticationStatus,
        authentication_brokers: authenticationBrokers,
        execution_ingestion_status: ingestionStatus,
        execution_ingestion_brokers: ingestionBrokers,
        storage_status: storageStatus,
        baseline_status: "NOT_USED",
        ledger_execution_count: ledgerRows.length,
        ledger_first_execution: firstAvailable,
        ledger_last_execution: lastAvailable,
        fifo_realised_match_count: fifo.matches.length,
        open_lot_count: fifo.openLots,
        confirmed_today_realised_gross_pnl: currentPeriodMatches.today.length ? sumMatches(currentPeriodMatches.today) : null,
        open_position_mtm_included: false,
        issues,
      };
      if (env.ZERODHA_TOKEN_STORE && storageStatus === "D1_READ_WRITE_AVAILABLE") {
        try {
          await env.ZERODHA_TOKEN_STORE.put(auditKey, JSON.stringify(audit), { expirationTtl: 60 * 60 * 24 * 400 });
          await env.ZERODHA_TOKEN_STORE.put("pnl:reconciliation:last-run", JSON.stringify(audit), { expirationTtl: 60 * 60 * 24 * 400 });
          storageStatus = "D1_READ_WRITE_AVAILABLE / AUDIT_PERSISTED";
        } catch (error) {
          audit.status = "AUDIT_PERSISTENCE_FAILED";
          audit.issues.push("Could not persist audit metadata: " + (error instanceof Error ? error.message : String(error)));
        }
      }

      const report = [
        "# Update P/L — " + dateKey,
        "",
        "**Status: " + audit.status + "**",
        "",
        "Update Auth ran automatically: " + authenticationStatus + ". Execution ingestion: " + ingestionStatus + ". Ledger: " + storageStatus + ".",
        "Both reports below are calculated from the same durable execution ledger; no manually supplied baseline or cross-report reconciliation is used.",
        "Table 1 is reconstructed realised **gross** P&L using FIFO matching for executions currently stored. Open positions/MTM are excluded. “All Time in Ledger” is not a claim of full account history: pre-ledger trades absent from broker API responses cannot be reconstructed. A dash means source data is unavailable, not zero.",
        "",
        "## Table 1 — P&L Summary (₹ lakh)",
        "",
        "| Broker | Today | This Week | This Month | " + currentFyLabel + " | All Time in Ledger |",
        "|---|---:|---:|---:|---:|---:|",
        brokerRows,
        consolidatedRow,
        "",
        "## Table 2 — Yearly Summary (₹ lakh)",
        "",
        "| FY | Gross realised P&L (FIFO) | Charges & Taxes | Interest | Income Tax | Net P&L |",
        "|---|---:|---:|---:|---:|---:|",
        yearlyRows || "| — | — | — | — | — | — |",
        "| **TOTAL in ledger** | **" + totalGross + "** | **" + totalCosts + "** | **—** | **—** | **—** |",
        "",
        "Ledger coverage: " + (firstAvailable ?? "—") + " to " + (lastAvailable ?? "—") + ".",
        "Cost and tax treatment is shown only when source fields are populated; interest is not inferred. This prevents fabricated net P&L or tax figures.",
        "",
        "## Validation",
        "- Open-position MTM excluded.",
        "- No manually entered baseline used.",
        "- Duplicate-safe execution ingestion remains enabled.",
        "- Issues: " + issues.join(" "),
      ].join("\n");
      return { content: [{ type: "text", text: report }] };
    }
  );

  // ==========================================================
  // CONSOLIDATED INVESTMENTS
  // ==========================================================
  server.registerTool(
    "update_investments",
    {
      description: "Return the live consolidated Investments Dashboard across Zerodha equity and Coin mutual funds, Angel One, Groww, 5Paisa and m.Stock. Read-only. One broker failure does not block the other brokers.",
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
          const investmentValue = Number.isFinite(Number(v?.summary?.investment_value))
            ? Number(v.summary.investment_value)
            : null;
          const hasPrevious = Object.prototype.hasOwnProperty.call(previousInvestment, names[i]);
          brokers.push({
            broker: names[i],
            status: "LIVE",
            error: null,
            investment_value: investmentValue,
            new_investment_since_last_update: baselineAvailable && hasPrevious && investmentValue !== null
              ? investmentValue - previousInvestment[names[i]]
              : null,
            current_value: v?.summary?.current_value ?? null,
            pnl: v?.summary?.pnl ?? null,
            pnl_percent: v?.summary?.pnl_percent ?? null,
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

      let baselineStatus: "ESTABLISHED" | "UPDATED" | "UNAVAILABLE" = "UNAVAILABLE";
      if (env.ZERODHA_TOKEN_STORE && allBrokersLive) {
        const nextSnapshot: Record<string, number> = {};
        for (const broker of brokers) {
          nextSnapshot[broker.broker] = broker.investment_value;
        }
        try {
          await env.ZERODHA_TOKEN_STORE.put(snapshotKey, JSON.stringify(nextSnapshot));
          baselineStatus = baselineAvailable ? "UPDATED" : "ESTABLISHED";
        } catch (error) {
          snapshotError = error instanceof Error ? error.message : String(error);
        }
      }

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
import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Badge,
  Surface,
  Text,
  Empty,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  WrenchIcon,
  DatabaseIcon,
  PaperPlaneRightIcon,
  TrashIcon,
  ArrowClockwiseIcon,
  PlugIcon,
  InfoIcon,
  WarningCircleIcon,
  CheckCircleIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";
import "./styles.css";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

interface McpResource {
  name: string;
  uri: string;
  description?: string;
}

interface ServerInfo {
  name: string;
  version: string;
}

interface ToolResult {
  label: string;
  text: string;
  isError: boolean;
  timestamp: number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 0;

async function mcpFetch(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | null
): Promise<{ data: JsonRpcResponse | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  const isNotification = method.startsWith("notifications/");
  if (!isNotification) body.id = ++nextId;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const newSessionId = res.headers.get("mcp-session-id") || sessionId;

  if (isNotification || res.status === 202) {
    return { data: null, sessionId: newSessionId };
  }

  const contentType = res.headers.get("content-type") || "";
  let data: JsonRpcResponse;
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const match = text.match(/^data: (.+)$/m);
    data = match ? JSON.parse(match[1]) : { jsonrpc: "2.0" };
  } else {
    data = await res.json();
  }

  return { data, sessionId: newSessionId };
}

function ToolCard({
  tool,
  onCall
}: {
  tool: McpTool;
  onCall: (name: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const properties = tool.inputSchema?.properties || {};
  const propertyEntries = Object.entries(properties);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const typedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      const prop = properties[key];
      if (prop?.type === "number" || prop?.type === "integer") {
        typedArgs[key] = Number(value);
      } else if (prop?.type === "boolean") {
        typedArgs[key] = value === "true";
      } else {
        typedArgs[key] = value;
      }
    }

    await onCall(tool.name, typedArgs);
    setLoading(false);
  };

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line">
      <Text size="sm" bold>
        {tool.name}
      </Text>
      {tool.description && (
        <span className="mt-0.5 block">
          <Text size="xs" variant="secondary">
            {tool.description}
          </Text>
        </span>
      )}
      <form onSubmit={handleSubmit} className="mt-3 space-y-2">
        {propertyEntries.map(([key, schema]) => (
          <div key={key}>
            <label className="block text-xs text-kumo-subtle mb-1">
              {key}
              {tool.inputSchema?.required?.includes(key) && (
                <span className="text-red-500"> *</span>
              )}
              <input
                aria-label={key}
                type={
                  schema.type === "number" || schema.type === "integer"
                    ? "number"
                    : "text"
                }
                value={args[key] || ""}
                onChange={(e) =>
                  setArgs((prev) => ({
                    ...prev,
                    [key]: e.target.value
                  }))
                }
                placeholder={schema.description || key}
                className="mt-1 w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
            </label>
          </div>
        ))}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={loading}
          icon={<PaperPlaneRightIcon size={14} />}
        >
          Call
        </Button>
      </form>
    </Surface>
  );
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </output>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}


type InvestmentHolding = {
  broker: string;
  asset_class: string;
  symbol: string | null;
  exchange: string | null;
  isin: string | null;
  quantity: number;
  average_price: number | null;
  ltp: number | null;
  investment_value: number | null;
  current_value: number | null;
  pnl: number | null;
  pnl_percent: number | null;
};

type InvestmentBroker = {
  broker: string;
  status: "connected" | "error";
  message?: string;
  investment_value: number;
  current_value: number;
  pnl: number;
  pnl_percent: number | null;
  holdings: InvestmentHolding[];
};

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return "₹" + value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function pct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(2) + "%";
}

function InvestmentsDashboard() {
  const [brokers, setBrokers] = useState<InvestmentBroker[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const brokerTools = [
      ["Zerodha", "zerodha_holdings"],
      ["Angel One", "angelone_holdings"],
      ["Groww", "groww_holdings"],
      ["5Paisa", "fivepaisa_holdings"],
      ["m.Stock", "mstock_holdings"]
    ] as const;

    try {
      const init = await mcpFetch(
        "/mcp",
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "investments-dashboard", version: "1.0.0" }
        },
        null
      );

      const sessionId = init.sessionId;
      await mcpFetch("/mcp", "notifications/initialized", {}, sessionId);

      const rows: InvestmentBroker[] = [];

      for (const [broker, tool] of brokerTools) {
        try {
          const res = await mcpFetch(
            "/mcp",
            "tools/call",
            { name: tool, arguments: {} },
            sessionId
          );
          const result = res.data?.result as
            | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
            | undefined;
          const rawText = result?.content?.[0]?.text ?? "";
          if (!rawText || result?.isError) throw new Error(rawText || "Tool call failed.");

          const raw = JSON.parse(rawText);
          let holdings: InvestmentHolding[] = [];
          let summary = { investment_value: 0, current_value: 0, pnl: 0, pnl_percent: null as number | null };

          if (broker === "Zerodha") {
            const data = Array.isArray(raw?.data) ? raw.data : [];
            holdings = data.map((r: any) => {
              const quantity = Number(r?.quantity ?? 0);
              const average = Number(r?.average_price);
              const ltp = Number(r?.last_price);
              const investment = Number.isFinite(average) ? average * quantity : null;
              const current = Number.isFinite(ltp) ? ltp * quantity : null;
              const pnl = Number.isFinite(Number(r?.pnl))
                ? Number(r.pnl)
                : investment !== null && current !== null ? current - investment : null;
              return {
                broker,
                asset_class: "Equity",
                symbol: r?.tradingsymbol ?? null,
                exchange: r?.exchange ?? null,
                isin: r?.isin ?? null,
                quantity,
                average_price: Number.isFinite(average) ? average : null,
                ltp: Number.isFinite(ltp) ? ltp : null,
                investment_value: investment,
                current_value: current,
                pnl,
                pnl_percent: investment ? ((pnl ?? 0) / investment) * 100 : null
              };
            });
            // Zerodha Coin mutual funds are exposed by a separate Kite API.
            const mfRes = await mcpFetch(
              "/mcp",
              "tools/call",
              { name: "zerodha_mf_holdings", arguments: {} },
              sessionId
            );
            const mfResult = mfRes.data?.result as
              | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
              | undefined;
            const mfText = mfResult?.content?.[0]?.text ?? "";
            if (!mfText || mfResult?.isError) throw new Error(mfText || "Mutual fund tool call failed.");
            const mfRaw = JSON.parse(mfText);
            if (!Array.isArray(mfRaw?.data)) throw new Error(mfRaw?.message || "Mutual fund holdings unavailable.");
            const mfHoldings: InvestmentHolding[] = mfRaw.data.map((r: any) => ({
              broker,
              asset_class: "Mutual Fund",
              symbol: r?.fund ?? r?.symbol ?? null,
              exchange: null,
              isin: r?.isin ?? r?.symbol ?? null,
              quantity: Number(r?.quantity ?? 0),
              average_price: Number.isFinite(Number(r?.average_price)) ? Number(r.average_price) : null,
              ltp: Number.isFinite(Number(r?.ltp)) ? Number(r.ltp) : null,
              investment_value: Number.isFinite(Number(r?.investment_value)) ? Number(r.investment_value) : null,
              current_value: Number.isFinite(Number(r?.current_value)) ? Number(r.current_value) : null,
              pnl: Number.isFinite(Number(r?.pnl)) ? Number(r.pnl) : null,
              pnl_percent: Number.isFinite(Number(r?.pnl_percent)) ? Number(r.pnl_percent) : null
            }));
            holdings = holdings.concat(mfHoldings);

            const investment = holdings.reduce((s, r) => s + (r.investment_value ?? 0), 0);
            const current = holdings.reduce((s, r) => s + (r.current_value ?? 0), 0);
            const pnlValue = current - investment;
            summary = {
              investment_value: investment,
              current_value: current,
              pnl: pnlValue,
              pnl_percent: investment ? (pnlValue / investment) * 100 : null
            };
          } else {
            if (!Array.isArray(raw?.holdings)) {
              throw new Error(raw?.message || raw?.reason || "Holdings unavailable; broker authentication is required.");
            }
            holdings = raw.holdings.map((r: any) => ({
              ...r,
              broker,
              asset_class: r?.asset_class ?? "Equity"
            }));
            summary = {
              investment_value: Number(raw?.summary?.investment_value ?? 0),
              current_value: Number(raw?.summary?.current_value ?? 0),
              pnl: Number(raw?.summary?.pnl ?? 0),
              pnl_percent: Number.isFinite(Number(raw?.summary?.pnl_percent))
                ? Number(raw.summary.pnl_percent)
                : null
            };
          }

          if (broker === "Zerodha") {
            const investment = holdings.reduce((s, r) => s + (r.investment_value ?? 0), 0);
            const current = holdings.reduce((s, r) => s + (r.current_value ?? 0), 0);
            const pnlValue = current - investment;
            summary = {
              investment_value: investment,
              current_value: current,
              pnl: pnlValue,
              pnl_percent: investment ? (pnlValue / investment) * 100 : null
            };
          }

          rows.push({
            broker,
            status: "connected",
            ...summary,
            holdings
          });
        } catch (e) {
          rows.push({
            broker,
            status: "error",
            message: e instanceof Error ? e.message : String(e),
            investment_value: 0,
            current_value: 0,
            pnl: 0,
            pnl_percent: null,
            holdings: []
          });
        }
      }

      setBrokers(rows);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totals = brokers.reduce(
    (s, b) => ({
      investment: s.investment + b.investment_value,
      current: s.current + b.current_value,
      pnl: s.pnl + b.pnl
    }),
    { investment: 0, current: 0, pnl: 0 }
  );
  const totalPct = totals.investment ? (totals.pnl / totals.investment) * 100 : null;
  const allHoldings = brokers.flatMap(b => b.holdings).sort(
    (a, b) => (b.current_value ?? 0) - (a.current_value ?? 0)
  );

  return (
    <div className="min-h-screen bg-kumo-base text-kumo-default p-5">
      <div className="max-w-6xl mx-auto space-y-5">
        <header className="flex items-center justify-between border-b border-kumo-line pb-4">
          <div>
            <h1 className="text-xl font-semibold">Investments Dashboard</h1>
            <p className="text-xs text-kumo-subtle mt-1">
              Stocks, ETFs and Mutual Funds. Separate from the F&O Trading Desk and Historical P&L.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-kumo-subtle">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              loading={loading}
              icon={<ArrowClockwiseIcon size={14} />}
              onClick={load}
            >
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { window.location.href = "/"; }}
            >
              Trading MCP
            </Button>
          </div>
        </header>

        {error && (
          <Surface className="p-4 rounded-xl ring ring-red-500/30 bg-red-50 dark:bg-red-950/20">
            <Text size="sm">{error}</Text>
          </Surface>
        )}

        <section>
          <Text size="base" bold>Authentication & Connection</Text>
          <Surface className="p-4 mt-3 rounded-xl ring ring-kumo-line">
            <div className="flex flex-wrap gap-6">
              {brokers.map(b => (
                <div key={b.broker} className="flex items-center gap-2">
                  <span className={`size-2.5 rounded-full ${b.status === "connected" ? "bg-green-500" : "bg-red-500"}`} />
                  <span className="text-sm">{b.broker}</span>
                </div>
              ))}
            </div>
          </Surface>
        </section>

        <section>
          <Text size="base" bold>Portfolio Summary</Text>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <Text size="xs" variant="secondary">Investment Value</Text>
              <div className="text-lg font-semibold mt-1">{money(totals.investment)}</div>
            </Surface>
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <Text size="xs" variant="secondary">Current Value</Text>
              <div className="text-lg font-semibold mt-1">{money(totals.current)}</div>
            </Surface>
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <Text size="xs" variant="secondary">Unrealised P&L</Text>
              <div className={`text-lg font-semibold mt-1 ${totals.pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                {money(totals.pnl)}
              </div>
            </Surface>
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <Text size="xs" variant="secondary">P&L %</Text>
              <div className={`text-lg font-semibold mt-1 ${(totalPct ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                {pct(totalPct)}
              </div>
            </Surface>
          </div>
        </section>

        <section>
          <Text size="base" bold>Broker Summary</Text>
          <Surface className="mt-3 rounded-xl ring ring-kumo-line overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-kumo-elevated">
                  <tr>
                    <th className="text-left p-3">Broker</th>
                    <th className="text-right p-3">Investment Value</th>
                    <th className="text-right p-3">Current Value</th>
                    <th className="text-right p-3">P&L</th>
                    <th className="text-right p-3">P&L %</th>
                  </tr>
                </thead>
                <tbody>
                  {brokers.map(b => (
                    <tr key={b.broker} className="border-t border-kumo-line">
                      <td className="p-3 font-medium">{b.broker}</td>
                      <td className="p-3 text-right">{b.status === "connected" ? money(b.investment_value) : "—"}</td>
                      <td className="p-3 text-right">{b.status === "connected" ? money(b.current_value) : "—"}</td>
                      <td className={`p-3 text-right ${b.pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {b.status === "connected" ? money(b.pnl) : "—"}
                      </td>
                      <td className={`p-3 text-right ${(b.pnl_percent ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {b.status === "connected" ? pct(b.pnl_percent) : "—"}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-kumo-line font-semibold">
                    <td className="p-3">TOTAL</td>
                    <td className="p-3 text-right">{money(totals.investment)}</td>
                    <td className="p-3 text-right">{money(totals.current)}</td>
                    <td className={`p-3 text-right ${totals.pnl >= 0 ? "text-green-600" : "text-red-600"}`}>{money(totals.pnl)}</td>
                    <td className={`p-3 text-right ${(totalPct ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{pct(totalPct)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Surface>
        </section>

        <section>
          <Text size="base" bold>Holding Detail</Text>
          <Surface className="mt-3 rounded-xl ring ring-kumo-line overflow-hidden">
            {allHoldings.length === 0 ? (
              <div className="p-6 text-sm text-kumo-subtle">
                {loading ? "Loading holdings..." : "No holdings returned from connected brokers."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-kumo-elevated">
                    <tr>
                      <th className="text-left p-3">Broker</th>
                      <th className="text-left p-3">Asset Class</th>
                      <th className="text-left p-3">Symbol / Fund</th>
                      <th className="text-left p-3">ISIN</th>
                      <th className="text-right p-3">Qty</th>
                      <th className="text-right p-3">Avg Price</th>
                      <th className="text-right p-3">LTP</th>
                      <th className="text-right p-3">Investment</th>
                      <th className="text-right p-3">Current Value</th>
                      <th className="text-right p-3">P&L</th>
                      <th className="text-right p-3">P&L %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allHoldings.map((h, i) => (
                      <tr key={h.broker + "-" + h.symbol + "-" + i} className="border-t border-kumo-line">
                        <td className="p-3">{h.broker}</td>
                        <td className="p-3">{h.asset_class}</td>
                        <td className="p-3 font-medium">{h.symbol ?? "—"}</td>
                        <td className="p-3 text-xs">{h.isin ?? "—"}</td>
                        <td className="p-3 text-right">{h.quantity.toLocaleString("en-IN")}</td>
                        <td className="p-3 text-right">{money(h.average_price)}</td>
                        <td className="p-3 text-right">{money(h.ltp)}</td>
                        <td className="p-3 text-right">{money(h.investment_value)}</td>
                        <td className="p-3 text-right">{money(h.current_value)}</td>
                        <td className={`p-3 text-right ${(h.pnl ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{money(h.pnl)}</td>
                        <td className={`p-3 text-right ${(h.pnl_percent ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{pct(h.pnl_percent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Surface>
        </section>
      </div>
    </div>
  );
}

function App() {
  if (window.location.pathname === "/investments") {
    return <InvestmentsDashboard />;
  }
  return <MainApp />;
}

function MainApp() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [resources, setResources] = useState<McpResource[]>([]);
  const [results, setResults] = useState<ToolResult[]>([]);
  const sessionRef = useRef<string | null>(null);

  const connect = useCallback(async () => {
    try {
      setStatus("connecting");

      const init = await mcpFetch(
        "/mcp",
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "browser-tester",
            version: "1.0.0"
          }
        },
        null
      );

      sessionRef.current = init.sessionId;
      const initResult = init.data?.result as
        | { serverInfo?: ServerInfo }
        | undefined;
      setServerInfo(initResult?.serverInfo ?? null);

      await mcpFetch("/mcp", "notifications/initialized", {}, init.sessionId);

      const toolsRes = await mcpFetch("/mcp", "tools/list", {}, init.sessionId);
      const toolsResult = toolsRes.data?.result as
        | { tools?: McpTool[] }
        | undefined;
      setTools(toolsResult?.tools ?? []);

      try {
        const resourcesRes = await mcpFetch(
          "/mcp",
          "resources/list",
          {},
          init.sessionId
        );
        const resourcesResult = resourcesRes.data?.result as
          | { resources?: McpResource[] }
          | undefined;
        setResources(resourcesResult?.resources ?? []);
      } catch {
        // Server may not support resources
      }

      setStatus("connected");
    } catch {
      setStatus("disconnected");
    }
  }, []);

  useEffect(() => {
    connect();
  }, [connect]);

  const handleCallTool = async (
    name: string,
    args: Record<string, unknown>
  ) => {
    try {
      const res = await mcpFetch(
        "/mcp",
        "tools/call",
        { name, arguments: args },
        sessionRef.current
      );
      const result = res.data?.result as
        | {
            content?: Array<{ type: string; text?: string }>;
            isError?: boolean;
          }
        | undefined;
      const text = result?.content?.[0]?.text ?? JSON.stringify(result);
      setResults((prev) => [
        {
          label: name,
          text,
          isError: result?.isError ?? false,
          timestamp: Date.now()
        },
        ...prev
      ]);
    } catch (err) {
      setResults((prev) => [
        {
          label: name,
          text: err instanceof Error ? err.message : String(err),
          isError: true,
          timestamp: Date.now()
        },
        ...prev
      ]);
    }
  };

  const handleReadResource = async (uri: string) => {
    try {
      const res = await mcpFetch(
        "/mcp",
        "resources/read",
        { uri },
        sessionRef.current
      );
      const result = res.data?.result as
        | { contents?: Array<{ text?: string; uri?: string }> }
        | undefined;
      const text = result?.contents?.[0]?.text ?? JSON.stringify(result);
      setResults((prev) => [
        { label: uri, text, isError: false, timestamp: Date.now() },
        ...prev
      ]);
    } catch (err) {
      setResults((prev) => [
        {
          label: uri,
          text: err instanceof Error ? err.message : String(err),
          isError: true,
          timestamp: Date.now()
        },
        ...prev
      ]);
    }
  };

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PlugIcon size={22} className="text-kumo-accent" weight="bold" />
            <h1 className="text-lg font-semibold text-kumo-default">
              {serverInfo?.name ?? "MCP Server"}
            </h1>
            {serverInfo && (
              <Badge variant="secondary">v{serverInfo.version}</Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={status} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { window.location.href = "/investments"; }}
            >
              Investments
            </Button>
            <ModeToggle />
            {status === "disconnected" && (
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowClockwiseIcon size={14} />}
                onClick={connect}
              >
                Reconnect
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl mx-auto space-y-8">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Stateless MCP Server (createMcpHandler)
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    The simplest way to run an MCP server on Cloudflare Workers.
                    Uses{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      createMcpHandler
                    </code>{" "}
                    from the Agents SDK to wrap an{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      McpServer
                    </code>{" "}
                    into a Worker-compatible fetch handler in one line — no
                    Durable Objects, no persistent state.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {status === "disconnected" && (
            <Empty
              icon={<PlugIcon size={32} />}
              title="Disconnected"
              description="Could not connect to the MCP server. Make sure it is running and try reconnecting."
            />
          )}

          {status === "connected" && (
            <>
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <WrenchIcon
                    size={18}
                    weight="bold"
                    className="text-kumo-subtle"
                  />
                  <Text size="base" bold>
                    Tools
                  </Text>
                  <Badge variant="secondary">{tools.length}</Badge>
                </div>
                {tools.length === 0 ? (
                  <Empty
                    icon={<WrenchIcon size={32} />}
                    title="No tools"
                    description="This server has no registered tools."
                  />
                ) : (
                  <div className="space-y-3">
                    {tools.map((tool) => (
                      <ToolCard
                        key={tool.name}
                        tool={tool}
                        onCall={handleCallTool}
                      />
                    ))}
                  </div>
                )}
              </section>

              {resources.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <DatabaseIcon
                      size={18}
                      weight="bold"
                      className="text-kumo-subtle"
                    />
                    <Text size="base" bold>
                      Resources
                    </Text>
                    <Badge variant="secondary">{resources.length}</Badge>
                  </div>
                  <div className="space-y-2">
                    {resources.map((r) => (
                      <Surface
                        key={r.uri}
                        className="p-3 rounded-xl ring ring-kumo-line flex items-center justify-between"
                      >
                        <div>
                          <Text size="sm" bold>
                            {r.name}
                          </Text>
                          <Text size="xs" variant="secondary">
                            {r.uri}
                          </Text>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleReadResource(r.uri)}
                        >
                          Read
                        </Button>
                      </Surface>
                    ))}
                  </div>
                </section>
              )}

              {results.length > 0 && (
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <Text size="base" bold>
                      Results
                    </Text>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<TrashIcon size={14} />}
                      onClick={() => setResults([])}
                    >
                      Clear
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {results.map((r) => (
                      <Surface
                        key={r.timestamp}
                        className={`p-3 rounded-xl ring ${r.isError ? "ring-red-500/30 bg-red-50 dark:bg-red-950/20" : "ring-kumo-line"}`}
                      >
                        <div className="flex items-start gap-2">
                          {r.isError ? (
                            <WarningCircleIcon
                              size={16}
                              weight="fill"
                              className="text-red-500 shrink-0 mt-0.5"
                            />
                          ) : (
                            <CheckCircleIcon
                              size={16}
                              weight="fill"
                              className="text-green-600 shrink-0 mt-0.5"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <Text size="xs" variant="secondary" bold>
                              {r.label}
                            </Text>
                            <p
                              className={`text-sm mt-0.5 whitespace-pre-wrap break-words ${r.isError ? "text-red-600 dark:text-red-400" : "text-kumo-default"}`}
                            >
                              {r.text}
                            </p>
                          </div>
                          <span className="text-[10px] text-kumo-inactive tabular-nums shrink-0">
                            {new Date(r.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </Surface>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

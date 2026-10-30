import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.PREVIEW_MCP_URL;
if (!endpoint) throw new Error("PREVIEW_MCP_URL is not configured.");

let lastError;
for (let attempt = 1; attempt <= 30; attempt++) {
  const client = new Client({ name: "trading-mcp-preview-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "hello", arguments: { name: "Preview" } });
    const text = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (result.isError || !text.includes("MCP connection is working")) {
      throw new Error("hello tool returned an unexpected result: " + JSON.stringify(result));
    }
    const listed = await client.listTools();
    const names = new Set((listed.tools ?? []).map((tool) => tool.name));
    for (const required of ["hello", "update_trades_margin", "update_investments"]) {
      if (!names.has(required)) throw new Error("Expected MCP tool is missing: " + required);
    }
    const report = await client.callTool({ name: "update_trades_margin", arguments: {} });
    if (report.isError) throw new Error("update_trades_margin returned an MCP error: " + JSON.stringify(report));
    const reportText = (report.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
    let reportJson;
    try { reportJson = JSON.parse(reportText); } catch { throw new Error("update_trades_margin did not return valid JSON text: " + reportText.slice(0, 1000)); }
    const requiredSections = [
      "## Section 4 — Available Margin for Options",
      "## Section 6 — Investment Portfolio Summary",
      "## Section 7 — Broker-wise Investment Status",
      "## Section 8 — New Investment Tracking",
    ];
    const dashboardText = String(reportJson.dashboard_text ?? reportJson.report ?? reportJson.formatted_report ?? "");
    const combinedText = reportText + "\\n" + dashboardText;
    for (const section of requiredSections) {
      if (!combinedText.includes(section)) throw new Error("Combined report is missing " + section);
    }
    console.log("PASS: MCP initialize, hello/callTool, tools/list.");
    console.log("PASS: update_trades_margin executed and Sections 4, 6, 7, 8 returned.");
    console.log("Report status: " + String(reportJson.status ?? "unknown"));
    console.log("Margin broker statuses: " + JSON.stringify((reportJson.margin_summary?.brokers ?? []).map((b) => ({ broker: b.broker, status: b.status, error: b.error }))));
    console.log("Investment broker statuses: " + JSON.stringify((reportJson.investment_summary?.brokers ?? []).map((b) => ({ broker: b.broker, status: b.status, error: b.error }))));
    console.log("Investment baseline: " + JSON.stringify(reportJson.new_investments ?? {}));
    console.log("Verified tools: " + ["hello", "update_trades_margin", "update_investments"].join(", "));
    await client.close();
    process.exit(0);
  } catch (error) {
    lastError = error;
    try { await client.close(); } catch {}
    if (attempt < 30) {
      console.log("Preview not ready or MCP request failed (attempt " + attempt + "/30): " + String(error));
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}
throw new Error("Preview MCP smoke test failed after 5 minutes: " + String(lastError));

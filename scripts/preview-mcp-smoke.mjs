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
    console.log("PASS: MCP initialize, hello/callTool, tools/list.");
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

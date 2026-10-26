# Trading MCP Server

Cloudflare Worker MCP server for the read-only Trading Desk broker integrations.

## m.Stock Type A integration

The server exposes:

- `mstock_auth_status`
- `mstock_login`
- `mstock_positions`
- `mstock_dashboard`
- `mstock_self_test`

Authentication is now **Type A TOTP**. The Worker calls the documented m.Stock endpoint:

`POST /openapi/typea/session/verifytotp`

and generates the current 6-digit TOTP locally from the `MSTOCK_TOTP_SECRET` Cloudflare Worker secret. The normal SMS OTP endpoint is not used.

### Required Cloudflare secrets

- `MSTOCK_API_KEY`
- `MSTOCK_TOTP_SECRET`

The existing `ZERODHA_TOKEN_STORE` KV binding is reused only for the m.Stock access token and login time.

`MSTOCK_USERNAME` and `MSTOCK_PASSWORD` are no longer required for m.Stock authentication.

### Intended ChatGPT workflow

The preferred command is:

**show mstock positions**

Behaviour:

1. If a valid m.Stock access token is already stored in KV, the Worker uses it directly.
2. If the token is missing or expired, the Worker generates the current TOTP from `MSTOCK_TOTP_SECRET`.
3. It calls m.Stock Type A `/openapi/typea/session/verifytotp`.
4. The returned access token is persisted in KV.
5. The Worker immediately calls `/openapi/typea/portfolio/positions`.
6. ChatGPT receives the live positions and P&L.

A manual 6-digit TOTP remains available as an optional fallback to the MCP tools, but it should not be required in normal operation.

m.Stock access tokens are still daily sessions; TOTP removes the manual SMS-OTP step, not the broker's session expiry.

### Enabling TOTP in m.Stock

1. Log in to `trade.mstock.com`.
2. Open **Trading APIs**.
3. Click **Generate TOTP** / **Enable TOTP**.
4. Complete the authenticator-app setup.
5. Preserve the TOTP secret from the setup QR/code.
6. Store that secret in Cloudflare as `MSTOCK_TOTP_SECRET`.

Do not put the API key or TOTP secret in ChatGPT messages.

### Security

- Read-only broker integration.
- No order placement, modification, cancellation, conversion or square-off is exposed.
- API key and TOTP secret remain Cloudflare Worker secrets.
- Access tokens remain in the existing KV namespace under `mstock_*` keys.

## Consolidated investment margin

Every **Update Investments** call refreshes margin data alongside the five broker holdings feeds. This is live-on-demand refresh, not a background polling schedule.

The response adds `margin_summary` with one row per broker, broker-reported available margin/funds for options, the source field, available cash/balance, collateral, utilisation, source, timestamp and per-broker status.

Read-only sources:
- Zerodha Kite `GET /user/margins` (equity segment `net` and collateral/utilisation components)
- Angel One SmartAPI `GET /rest/secure/angelbroking/user/v1/getRMS`
- Groww `GET /v1/margins/detail/user` (F&O option-sell available balance)
- 5Paisa Xstream `POST /V4/Margin` (`EquityMargin[0].NetAvailableMargin`)
- m.Stock Type A `GET /openapi/typea/user/fundsummary`

Margin failures are independent of holdings failures: a broker margin API error marks that row as ERROR and does not suppress the investments table. The consolidated available-for-options total is returned only when all five brokers have a live response and a numeric available field; otherwise the total is null rather than being estimated from collateral. The response retains each broker's source field because the brokers do not use identical field names or definitions.

Additional read-only tools: `angelone_margin`, `groww_margin`, `fivepaisa_margin`, and `mstock_margin`; `zerodha_margins` remains available.

If m.Stock returns HTTP 403 `ACCESS DENIED` with a `Your IP` field, the current Worker egress is being rejected. Cloudflare Worker outbound IPs are not fixed; the margin/holdings APIs cannot be considered fully available until m.Stock accepts a stable egress IP. Do not treat the reported Cloudflare IP as a stable allowlist value.

## Daily Trading Desk authentication

The preferred first command each trading day is:

**update auth**

The `update_auth` MCP tool validates the five broker sessions in parallel:

- Zerodha
- AngelOne
- Groww
- 5Paisa
- m.Stock

Where broker-side TOTP/session automation is configured, authentication is performed automatically. The tool also returns broker-specific Worker authentication hyperlinks:

- `/auth/zerodha`
- `/auth/angelone`
- `/auth/groww`
- `/auth/fivepaisa`
- `/auth/mstock`

The workflow is read-only and never places, modifies, cancels or squares off an order.

After broker authentication, the user can run:

1. **Update Trades**
2. **Update Investments**

Historical P&L is maintained manually in Google Sheets.

**Update Trades margin integration:** every Update Trades run must call the `update_trades_margin` tool and render its `formatted_section` as **Section 4 — Available Margin for Options**. Keep the five broker rows and combined total sourced from that live response; if any broker API fails or returns a non-numeric value, show that broker as unavailable and withhold the combined total. Move **New Trades — Today** to Section 5. This tool uses the same five margin API helpers as Update Investments and is read-only.

### Trading Desk RAG — 75% Target / MTM

The **75% Target / MTM** dashboard column uses the following RAG thresholds against Max Profit:

- 🟢 **≥75% of Max**
- 🟠 **60% to <75% of Max**
- 🔴 **≤−65% of Max**
- No RAG indicator for values between **−65% and <60%** of Max.

The RAG is applied to the **current MTM as a percentage of Max Profit**, not to the absolute MTM amount. The same thresholds must be used consistently in Portfolio Totals, Trade Summary, Broker Summary, and New Trades wherever the **75% Target / MTM** column is displayed.

The ChatGPT plugin's **Refresh Tools** catalogue is a ChatGPT UI operation and cannot be triggered by an MCP server. After the new tool is first deployed, refresh the **Zerodha Trading Desk** tools once so ChatGPT loads `update_auth`. Subsequent daily broker authentication is automated by the tool.

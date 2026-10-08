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

After all five brokers are valid, the user can run:

1. **update dashboard**
2. **update P/L**
3. **update investments**

The ChatGPT plugin's **Refresh Tools** catalogue is a ChatGPT UI operation and cannot be triggered by an MCP server. After the new tool is first deployed, refresh the **Zerodha Trading Desk** tools once so ChatGPT loads `update_auth`. Subsequent daily broker authentication is automated by the tool.

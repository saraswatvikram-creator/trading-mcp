type GrowwEnv = {
  GROWW_ACCESS_TOKEN?: string;
};

const GROWW_BASE_URL = "https://api.groww.in";

function requireGrowwConfig(env: GrowwEnv): string {
  const token = env.GROWW_ACCESS_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "Groww configuration is incomplete. Missing Cloudflare secret: GROWW_ACCESS_TOKEN. " +
      "This integration uses the Groww ACCESS TOKEN flow only; TOTP is not required."
    );
  }

  return token;
}

function getJwtExpiry(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;

    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));

    return typeof payload.exp === "number"
      ? new Date(payload.exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

function getGrowwAccessToken(env: GrowwEnv): {
  accessToken: string;
  expiry: string | null;
} {
  const accessToken = requireGrowwConfig(env);

  return {
    accessToken,
    expiry: getJwtExpiry(accessToken),
  };
}

async function growwGet(
  path: string,
  env: GrowwEnv,
  accessToken: string
): Promise<any> {
  const response = await fetch(GROWW_BASE_URL + path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + accessToken,
      "X-API-VERSION": "1.0",
    },
  });

  const data = await response.json();

  if (!response.ok || data?.status === "FAILURE") {
    throw new Error(
      "Groww API error " +
        response.status +
        ": " +
        JSON.stringify(data?.error ?? data)
    );
  }

  return data;
}

function dashboardSummary(
  profile: any,
  positions: any[],
  margin: any,
  orders: any[]
): string {
  const fnoPositions = positions.filter(
    (row) =>
      String(row?.segment ?? "").toUpperCase() === "FNO" &&
      Number(row?.quantity ?? 0) !== 0
  );

  const realisedPnl = fnoPositions.reduce((sum, row) => {
    const value =
      Number(row?.realised_pnl) ||
      Number(row?.realized_pnl) ||
      0;
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const fno = margin?.fno_margin_details ?? {};

  return [
    "## Groww Dashboard",
    "",
    "| Metric | Value |",
    "|---|---:|",
    "| Authentication | CONNECTED |",
    "| Auth mode | ACCESS TOKEN |",
    "| F&O positions | " + fnoPositions.length + " |",
    "| Today's orders | " + orders.length + " |",
    "| Realised P&L in returned positions | ₹" + realisedPnl.toFixed(2) + " |",
    "| F&O margin used | ₹" + (fno.net_fno_margin_used ?? "—") + " |",
    "| Option sell balance | ₹" + (fno.option_sell_balance_available ?? "—") + " |",
    "| Client/UCC | " + (profile?.ucc ?? "—") + " |",
    "",
    "Read-only integration. No Groww order placement, modification, cancellation or square-off is exposed.",
    "Groww direct access tokens expire daily at 6 AM and must be replaced in the Cloudflare secret when they expire.",
  ].join("\n");
}

export function registerGrowwTools(server: any, env: GrowwEnv): void {
  server.registerTool(
    "groww_auth_status",
    {
      description:
        "Check Groww direct ACCESS TOKEN configuration and decode its expiry when available. Read-only; never exposes the token.",
    },
    async () => {
      const configured = Boolean(env.GROWW_ACCESS_TOKEN?.trim());
      const expiry = configured
        ? getJwtExpiry(env.GROWW_ACCESS_TOKEN!.trim())
        : null;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            configured,
            auth_mode: "ACCESS_TOKEN",
            token_expiry: expiry,
            note:
              "Groww direct access token is used exactly as supplied. " +
              "It expires daily at 6 AM and must be regenerated in Groww and updated as GROWW_ACCESS_TOKEN.",
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_profile",
    {
      description:
        "Return the authenticated Groww user profile using the configured direct ACCESS TOKEN. Read-only.",
    },
    async () => {
      const token = getGrowwAccessToken(env);
      const profile = await growwGet(
        "/v1/user/detail",
        env,
        token.accessToken
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            auth_mode: "ACCESS_TOKEN",
            profile: profile?.payload ?? profile,
            token_expiry: token.expiry,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_positions",
    {
      description:
        "Return current Groww F&O positions using the configured direct ACCESS TOKEN. This is the primary Groww positions command. Read-only.",
    },
    async () => {
      const token = getGrowwAccessToken(env);
      const response = await growwGet(
        "/v1/positions/user?segment=FNO",
        env,
        token.accessToken
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            auth_mode: "ACCESS_TOKEN",
            segment: "FNO",
            positions:
              response?.payload?.positions ??
              response?.payload ??
              [],
            token_expiry: token.expiry,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_margin",
    {
      description:
        "Return current Groww available margin, including F&O margin details, using the direct ACCESS TOKEN. Read-only.",
    },
    async () => {
      const token = getGrowwAccessToken(env);
      const margin = await growwGet(
        "/v1/margins/detail/user",
        env,
        token.accessToken
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            auth_mode: "ACCESS_TOKEN",
            margin: margin?.payload ?? margin,
            token_expiry: token.expiry,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_orders",
    {
      description:
        "Return today's Groww F&O order list using the direct ACCESS TOKEN. Read-only. No order placement or modification is exposed.",
    },
    async () => {
      const token = getGrowwAccessToken(env);
      const orders = await growwGet(
        "/v1/order/list?segment=FNO&page=0&page_size=100",
        env,
        token.accessToken
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            auth_mode: "ACCESS_TOKEN",
            segment: "FNO",
            orders: orders?.payload?.order_list ?? [],
            token_expiry: token.expiry,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_dashboard",
    {
      description:
        "Return a consolidated, read-only Groww dashboard using the direct ACCESS TOKEN: authentication, user profile, F&O positions, available margin and today's F&O orders. Never place, modify, cancel or square off orders.",
    },
    async () => {
      const token = getGrowwAccessToken(env);

      const [
        profileResponse,
        positionResponse,
        marginResponse,
        orderResponse,
      ] = await Promise.all([
        growwGet("/v1/user/detail", env, token.accessToken),
        growwGet(
          "/v1/positions/user?segment=FNO",
          env,
          token.accessToken
        ),
        growwGet(
          "/v1/margins/detail/user",
          env,
          token.accessToken
        ),
        growwGet(
          "/v1/order/list?segment=FNO&page=0&page_size=100",
          env,
          token.accessToken
        ),
      ]);

      const profile =
        profileResponse?.payload ?? profileResponse;
      const positions =
        positionResponse?.payload?.positions ?? [];
      const margin =
        marginResponse?.payload ?? marginResponse;
      const orders =
        orderResponse?.payload?.order_list ?? [];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "CONNECTED",
            auth_mode: "ACCESS_TOKEN",
            dashboard: dashboardSummary(
              profile,
              positions,
              margin,
              orders
            ),
            session: {
              authenticated: true,
              token_expiry: token.expiry,
            },
            profile,
            positions,
            margin,
            orders,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "groww_self_test",
    {
      description:
        "Run an automated read-only Groww integration self-test using the direct ACCESS TOKEN: configuration, profile, F&O positions, margin and F&O order list. Never performs a trading action.",
    },
    async () => {
      const configured = Boolean(env.GROWW_ACCESS_TOKEN?.trim());
      const checks: Record<string, string> = {
        configuration: configured ? "PASS" : "FAIL",
      };
      const errors: Record<string, string> = {};

      if (!configured) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "FAIL",
              auth_mode: "ACCESS_TOKEN",
              checks,
              errors: {
                configuration:
                  "Missing Cloudflare secret GROWW_ACCESS_TOKEN. " +
                  "Add the current Groww TradingDesk ACCESS TOKEN; do not add TOTP credentials.",
              },
              read_only: true,
            }, null, 2),
          }],
        };
      }

      const token = getGrowwAccessToken(env);
      const tests: Array<[string, string]> = [
        ["profile", "/v1/user/detail"],
        ["positions", "/v1/positions/user?segment=FNO"],
        ["margin", "/v1/margins/detail/user"],
        ["orders", "/v1/order/list?segment=FNO&page=0&page_size=100"],
      ];

      for (const [name, path] of tests) {
        try {
          await growwGet(path, env, token.accessToken);
          checks[name] = "PASS";
        } catch (e) {
          checks[name] = "FAIL";
          errors[name] =
            e instanceof Error ? e.message : String(e);
        }
      }

      const passed = Object.values(checks).filter(
        (v) => v === "PASS"
      ).length;
      const total = Object.keys(checks).length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: passed === total ? "PASS" : "FAIL",
            auth_mode: "ACCESS_TOKEN",
            token_expiry: token.expiry,
            checks,
            passed,
            total,
            errors,
            read_only: true,
          }, null, 2),
        }],
      };
    }
  );
}

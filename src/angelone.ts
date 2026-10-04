import { z } from "zod";

type AngelOneEnv = {
  ANGELONE_API_KEY?: string;
  ANGELONE_CLIENT_ID?: string;
  ANGELONE_PIN?: string;
  ANGELONE_TOTP_SECRET?: string;
};

const ANGELONE_LOGIN_URL =
  "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword";

const ANGELONE_PROFILE_URL =
  "https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getProfile";

const ANGELONE_POSITION_URL =
  "https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getPosition";

function base32Decode(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/\s+/g, "");

  let buffer = 0;
  let bits = 0;
  const output: number[] = [];

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new Error("ANGELONE_TOTP_SECRET is not valid Base32");
    }

    buffer = (buffer << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }

  return new Uint8Array(output);
}

async function generateTotp(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBytes = new ArrayBuffer(8);
  const counterView = new DataView(counterBytes);
  counterView.setUint32(0, Math.floor(counter / 0x100000000));
  counterView.setUint32(4, counter >>> 0);

  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterBytes)
  );

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1000000).padStart(6, "0");
}

function requireAngelOneConfig(env: AngelOneEnv): void {
  const missing: string[] = [];

  if (!env.ANGELONE_API_KEY) missing.push("ANGELONE_API_KEY");
  if (!env.ANGELONE_CLIENT_ID) missing.push("ANGELONE_CLIENT_ID");
  if (!env.ANGELONE_PIN) missing.push("ANGELONE_PIN");
  if (!env.ANGELONE_TOTP_SECRET) missing.push("ANGELONE_TOTP_SECRET");

  if (missing.length > 0) {
    throw new Error(
      "AngelOne configuration is incomplete. Missing Cloudflare secrets: " +
        missing.join(", ")
    );
  }
}

async function angelOneLogin(env: AngelOneEnv): Promise<any> {
  requireAngelOneConfig(env);

  const totp = await generateTotp(env.ANGELONE_TOTP_SECRET!);

  const response = await fetch(ANGELONE_LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-PrivateKey": env.ANGELONE_API_KEY!,
    },
    body: JSON.stringify({
      clientcode: env.ANGELONE_CLIENT_ID!,
      password: env.ANGELONE_PIN!,
      totp,
    }),
  });

  const data = await response.json();

  if (!response.ok || data?.status === false) {
    throw new Error(
      "AngelOne authentication failed: " +
        JSON.stringify(data)
    );
  }

  const jwtToken = data?.data?.jwtToken;

  if (!jwtToken) {
    throw new Error(
      "AngelOne authentication succeeded but no jwtToken was returned."
    );
  }

  return {
    data,
    jwtToken,
    totpGenerated: true,
  };
}

async function angelOneGet(
  url: string,
  env: AngelOneEnv,
  jwtToken: string
): Promise<any> {
  requireAngelOneConfig(env);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-PrivateKey": env.ANGELONE_API_KEY!,
      Authorization: "Bearer " + jwtToken,
    },
  });

  const data = await response.json();

  if (!response.ok || data?.status === false) {
    throw new Error(
      "AngelOne API error " +
        response.status +
        ": " +
        JSON.stringify(data)
    );
  }

  return data;
}

export function registerAngelOneTools(
  server: any,
  env: AngelOneEnv
): void {
  server.registerTool(
    "angelone_auth_status",
    {
      description:
        "Check whether AngelOne SmartAPI credentials and TOTP configuration are present. Read-only; does not expose secrets.",
    },
    async () => {
      const configured =
        Boolean(env.ANGELONE_API_KEY) &&
        Boolean(env.ANGELONE_CLIENT_ID) &&
        Boolean(env.ANGELONE_PIN) &&
        Boolean(env.ANGELONE_TOTP_SECRET);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                configured,
                api_key_configured: Boolean(env.ANGELONE_API_KEY),
                client_id_configured: Boolean(env.ANGELONE_CLIENT_ID),
                pin_configured: Boolean(env.ANGELONE_PIN),
                totp_secret_configured: Boolean(env.ANGELONE_TOTP_SECRET),
                note:
                  "TOTP secret presence confirms Cloudflare configuration only; successful loginByPassword confirms that the generated TOTP is accepted by AngelOne.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "angelone_profile",
    {
      description:
        "Authenticate to AngelOne SmartAPI using the configured PIN and generated TOTP, then return the AngelOne profile. Read-only.",
    },
    async () => {
      const login = await angelOneLogin(env);
      const profile = await angelOneGet(
        ANGELONE_PROFILE_URL,
        env,
        login.jwtToken
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                authenticated: true,
                profile: profile?.data ?? profile,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "angelone_positions",
    {
      description:
        "Authenticate to AngelOne SmartAPI using generated TOTP and return current positions. Read-only.",
    },
    async () => {
      const login = await angelOneLogin(env);
      const positions = await angelOneGet(
        ANGELONE_POSITION_URL,
        env,
        login.jwtToken
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                authenticated: true,
                positions: positions?.data ?? [],
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

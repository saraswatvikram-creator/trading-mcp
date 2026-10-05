import { McpServer } from "@modelcontextprotocol/server";
import { registerAngelOneTools } from "./angelone";
import { registerGrowwTools } from "./groww";
import { registerFivePaisaTools, handleFivePaisaCallback } from "./fivepaisa";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  ZERODHA_API_KEY: string;
  ZERODHA_API_SECRET: string;
  ZERODHA_ACCESS_TOKEN?: string;
  ZERODHA_TOKEN_STORE?: KVNamespace;

  ANGELONE_API_KEY?: string;
  ANGELONE_CLIENT_ID?: string;
  ANGELONE_PIN?: string;
  ANGELONE_TOTP_SECRET?: string;

  GROWW_ACCESS_TOKEN?: string;

  FIVEPAISA_API_KEY?: string;
  FIVEPAISA_ENCRYPTION_KEY?: string;
  FIVEPAISA_USER_ID?: string;
  FIVEPAISA_REDIRECT_URL?: string;
  FIVEPAISA_TOKEN_STORE?: KVNamespace;
};

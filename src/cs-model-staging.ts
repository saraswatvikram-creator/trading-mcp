import { handleCsModelMcp } from "./cs-model";

type Env = {
  CS_MODEL_API_TOKEN?: string;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/cs-model/mcp") {
      return new Response("Not found", { status: 404 });
    }
    return handleCsModelMcp(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

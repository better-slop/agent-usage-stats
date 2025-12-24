import { Hono } from "hono";
import { fetchCodexUsage, normalizeCodexUsage } from "@aus/agent";
import type { AgentUsageSnapshot } from "@aus/agent";
import rpcApp from "./rpc";

type UsageApiSuccess = {
  ok: true;
  type: string;
  email?: string;
  usage: AgentUsageSnapshot;
};

type UsageApiError = {
  ok: false;
  type: string;
  email?: string;
  error: string;
};

type UsageApiResponse = UsageApiSuccess | UsageApiError;

const SUPPORTED_TYPES = new Set(["codex"]);

const app = new Hono();

app.get("/health", (c) => c.text("ok"));
app.route("/rpc", rpcApp);

app.get("/api/usage", async (c) => {
  const type = (c.req.query("type") ?? "codex").toLowerCase();
  const email = c.req.query("email")?.trim() || undefined;

  if (!SUPPORTED_TYPES.has(type)) {
    const payload: UsageApiResponse = {
      ok: false,
      type,
      email,
      error: `Unsupported usage type: ${type}`,
    };
    return c.json(payload, 400);
  }

  try {
    const snapshot = await fetchCodexUsage();
    const usage = normalizeCodexUsage(snapshot);
    if (email && usage.account?.email && usage.account.email !== email) {
      const payload: UsageApiResponse = {
        ok: false,
        type,
        email,
        error: "No usage data for requested email.",
      };
      return c.json(payload, 404);
    }

    const payload: UsageApiResponse = {
      ok: true,
      type,
      email,
      usage,
    };
    return c.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: UsageApiResponse = {
      ok: false,
      type,
      email,
      error: message,
    };
    return c.json(payload, 500);
  }
});

export default app;

const DEFAULT_PORT = 8787;

const parsePortArg = (args: string[]): number | undefined => {
  const flagIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  if (flagIndex !== -1) {
    const value = args[flagIndex + 1];
    if (value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }

  const inlineFlag = args.find((arg) => arg.startsWith("--port="));
  if (inlineFlag) {
    const value = inlineFlag.split("=")[1] ?? "";
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
};

if (import.meta.main) {
  const portArg = parsePortArg(Bun.argv);
  const portEnv = Bun.env.PORT ? Number(Bun.env.PORT) : undefined;
  const port = portArg ?? (Number.isFinite(portEnv) ? portEnv : undefined) ?? DEFAULT_PORT;
  const server = Bun.serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${server.port}`);
}

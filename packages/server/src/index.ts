import { Hono } from "hono";
import { fetchCodexUsage, normalizeCodexUsage } from "@aus/agent";
import type { AgentUsageSnapshot } from "@aus/agent";

type UsageApiSuccess = {
  ok: true;
  accountId: string;
  usage: AgentUsageSnapshot;
};

type UsageApiError = {
  ok: false;
  accountId: string;
  error: string;
};

type UsageApiResponse = UsageApiSuccess | UsageApiError;

const app = new Hono();

app.get("/health", (c) => c.text("ok"));

app.get("/api/account/:accountId/usage", async (c) => {
  const accountId = c.req.param("accountId");
  try {
    const snapshot = await fetchCodexUsage();
    const usage = normalizeCodexUsage(snapshot);
    const payload: UsageApiResponse = {
      ok: true,
      accountId,
      usage,
    };
    return c.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: UsageApiResponse = {
      ok: false,
      accountId,
      error: message,
    };
    return c.json(payload, 500);
  }
});

export default app;

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 8787);
  Bun.serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
}

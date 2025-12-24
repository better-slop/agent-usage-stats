import { Hono } from "hono";
import type { Context } from "hono";
import { fetchCodexUsage, normalizeCodexUsage } from "@aus/agent";
import type { AgentUsageSnapshot } from "@aus/agent";

type CachedUsage = {
  snapshot: AgentUsageSnapshot;
  etag: string;
  lastUpdated: number;
};

type RpcUsageResponse = {
  ok: true;
  lastUpdated: number;
  usage: AgentUsageSnapshot;
};

type RpcLastUpdatedResponse = {
  ok: true;
  lastUpdated: number;
};

type RpcUsageError = {
  ok: false;
  error: string;
};

const DEFAULT_CACHE_TTL_MS = 10_000;

const parseCacheTtl = (): number => {
  const raw = Bun.env.RPC_CACHE_TTL_MS;
  if (!raw) {
    return DEFAULT_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CACHE_TTL_MS;
  }
  return parsed;
};

const cacheTtlMs = parseCacheTtl();

let cache: CachedUsage | undefined;
let inFlight: Promise<CachedUsage> | undefined;

const buildEtag = (timestamp: number): string => `W/"codex-${timestamp}"`;

const isNotModified = (c: Context, entry: CachedUsage): boolean => {
  const ifNoneMatch = c.req.header("if-none-match");
  const ifModifiedSince = c.req.header("if-modified-since");
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    return true;
  }
  if (ifModifiedSince) {
    const parsed = Date.parse(ifModifiedSince);
    if (!Number.isNaN(parsed) && entry.lastUpdated <= parsed) {
      return true;
    }
  }
  return false;
};

const applyCacheHeaders = (c: Context, entry: CachedUsage): void => {
  c.header("ETag", entry.etag);
  c.header("Last-Modified", new Date(entry.lastUpdated).toUTCString());
  c.header("X-Last-Updated", String(entry.lastUpdated));
  c.header("Cache-Control", "no-cache");
};

const isFresh = (entry: CachedUsage, now: number): boolean => now - entry.lastUpdated < cacheTtlMs;

const loadUsage = async (): Promise<CachedUsage> => {
  const now = Date.now();
  if (cache && isFresh(cache, now)) {
    return cache;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const snapshot = await fetchCodexUsage();
    const usage = normalizeCodexUsage(snapshot);
    const lastUpdated = usage.fetchedAt;
    const entry: CachedUsage = {
      snapshot: usage,
      etag: buildEtag(lastUpdated),
      lastUpdated,
    };
    cache = entry;
    return entry;
  })().finally(() => {
    inFlight = undefined;
  });

  return inFlight;
};

const rpcApp = new Hono();

rpcApp.get("/usage", async (c) => {
  try {
    const entry = await loadUsage();
    if (isNotModified(c, entry)) {
      return c.body(null, 304);
    }
    applyCacheHeaders(c, entry);

    const payload: RpcUsageResponse = {
      ok: true,
      lastUpdated: entry.lastUpdated,
      usage: entry.snapshot,
    };
    return c.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: RpcUsageError = { ok: false, error: message };
    return c.json(payload, 500);
  }
});

rpcApp.get("/last-updated", async (c) => {
  try {
    const entry = await loadUsage();
    if (isNotModified(c, entry)) {
      return c.body(null, 304);
    }
    applyCacheHeaders(c, entry);

    const payload: RpcLastUpdatedResponse = {
      ok: true,
      lastUpdated: entry.lastUpdated,
    };
    return c.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: RpcUsageError = { ok: false, error: message };
    return c.json(payload, 500);
  }
});

export default rpcApp;

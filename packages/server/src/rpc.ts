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
  type: string;
  email?: string;
  lastUpdated: number;
  usage: AgentUsageSnapshot;
};

type RpcLastUpdatedResponse = {
  ok: true;
  type: string;
  email?: string;
  lastUpdated: number;
};

type RpcUsageError = {
  ok: false;
  type: string;
  email?: string;
  error: string;
};

const SUPPORTED_TYPES = new Set(["codex"]);
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
const cache = new Map<string, CachedUsage>();
const inFlight = new Map<string, Promise<CachedUsage>>();

const buildEtag = (type: string, timestamp: number): string => `W/"${type}-${timestamp}"`;

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

const loadUsage = async (type: string): Promise<CachedUsage> => {
  const now = Date.now();
  const cached = cache.get(type);
  if (cached && isFresh(cached, now)) {
    return cached;
  }
  const pending = inFlight.get(type);
  if (pending) {
    return pending;
  }

  const fetchPromise = (async () => {
    if (type !== "codex") {
      throw new Error(`Unsupported usage type: ${type}`);
    }
    const snapshot = await fetchCodexUsage();
    const usage = normalizeCodexUsage(snapshot);
    const lastUpdated = usage.fetchedAt;
    const entry: CachedUsage = {
      snapshot: usage,
      etag: buildEtag(type, lastUpdated),
      lastUpdated,
    };
    cache.set(type, entry);
    return entry;
  })().finally(() => {
    inFlight.delete(type);
  });

  inFlight.set(type, fetchPromise);
  return fetchPromise;
};

const rpcApp = new Hono();

rpcApp.get("/usage/:type", async (c) => {
  const type = c.req.param("type").toLowerCase();
  const email = c.req.query("email")?.trim() || undefined;

  if (!SUPPORTED_TYPES.has(type)) {
    const payload: RpcUsageError = {
      ok: false,
      type,
      email,
      error: `Unsupported usage type: ${type}`,
    };
    return c.json(payload, 400);
  }

  try {
    const entry = await loadUsage(type);
    if (isNotModified(c, entry)) {
      return c.body(null, 304);
    }
    applyCacheHeaders(c, entry);

    if (email && entry.snapshot.account?.email && entry.snapshot.account.email !== email) {
      const payload: RpcUsageError = {
        ok: false,
        type,
        email,
        error: "No usage data for requested email.",
      };
      return c.json(payload, 404);
    }

    const payload: RpcUsageResponse = {
      ok: true,
      type,
      email,
      lastUpdated: entry.lastUpdated,
      usage: entry.snapshot,
    };
    return c.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: RpcUsageError = { ok: false, type, email, error: message };
    return c.json(payload, 500);
  }
});

rpcApp.get("/last-updated/:type", async (c) => {
  const type = c.req.param("type").toLowerCase();
  const email = c.req.query("email")?.trim() || undefined;

  if (!SUPPORTED_TYPES.has(type)) {
    const payload: RpcUsageError = {
      ok: false,
      type,
      email,
      error: `Unsupported usage type: ${type}`,
    };
    return c.json(payload, 400);
  }

  try {
    const entry = await loadUsage(type);
    if (isNotModified(c, entry)) {
      return c.body(null, 304);
    }
    applyCacheHeaders(c, entry);

    if (email && entry.snapshot.account?.email && entry.snapshot.account.email !== email) {
      const payload: RpcUsageError = {
        ok: false,
        type,
        email,
        error: "No usage data for requested email.",
      };
      return c.json(payload, 404);
    }

    const payload: RpcLastUpdatedResponse = {
      ok: true,
      type,
      email,
      lastUpdated: entry.lastUpdated,
    };
    return c.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: RpcUsageError = { ok: false, type, email, error: message };
    return c.json(payload, 500);
  }
});

export default rpcApp;

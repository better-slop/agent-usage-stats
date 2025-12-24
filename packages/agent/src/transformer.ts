import type { CodexCredits, CodexRateLimitWindow, CodexUsageSnapshot } from "./codex";

export type UsageWindow = {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
};

export type UsageCredits = {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: number;
};

export type UsageAccount = {
  email?: string;
  planType?: string;
};

export type AgentUsageSnapshot = {
  provider: "codex";
  source: CodexUsageSnapshot["source"];
  fetchedAt: number;
  account?: UsageAccount;
  limits?: {
    primary?: UsageWindow;
    secondary?: UsageWindow;
  };
  credits?: UsageCredits;
  raw?: unknown;
};

export function normalizeCodexUsage(snapshot: CodexUsageSnapshot): AgentUsageSnapshot {
  return {
    provider: "codex",
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    account: snapshot.account
      ? {
          email: snapshot.account.email,
          planType: snapshot.account.planType,
        }
      : undefined,
    limits: snapshot.rateLimits
      ? {
          primary: normalizeWindow(snapshot.rateLimits.primary),
          secondary: normalizeWindow(snapshot.rateLimits.secondary),
        }
      : undefined,
    credits: normalizeCredits(snapshot.rateLimits?.credits),
    raw: snapshot.raw,
  };
}

function normalizeWindow(window?: CodexRateLimitWindow): UsageWindow | undefined {
  if (!window) {
    return undefined;
  }
  return {
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
  };
}

function normalizeCredits(credits?: CodexCredits): UsageCredits | undefined {
  if (!credits) {
    return undefined;
  }
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    balance: credits.balance,
  };
}

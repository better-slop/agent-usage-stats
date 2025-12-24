import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type CodexFetchOptions = {
  binaryPath?: string;
  timeoutMs?: number;
  authPath?: string;
  clientInfo?: {
    name: string;
    version: string;
  };
};

export type CodexAccount = {
  type?: string;
  email?: string;
  planType?: string;
  requiresOpenaiAuth?: boolean;
};

export type CodexRateLimitWindow = {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
};

export type CodexCredits = {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: number;
};

export type CodexRateLimits = {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  credits?: CodexCredits;
};

export type CodexUsageSnapshot = {
  source: "rpc";
  fetchedAt: number;
  account?: CodexAccount;
  rateLimits?: CodexRateLimits;
  raw?: {
    account?: unknown;
    rateLimits?: unknown;
  };
};

type RpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type RpcRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type RpcResponse<T> = {
  id: number;
  result?: T;
  error?: RpcError;
};

type CodexAccountResponse = {
  account?: {
    type?: string;
    email?: string;
    planType?: string;
  };
  requiresOpenaiAuth?: boolean;
};

type CodexRateLimitsResponse = {
  rateLimits?: {
    primary?: CodexRateLimitWindow;
    secondary?: CodexRateLimitWindow;
    credits?: {
      hasCredits?: boolean;
      unlimited?: boolean;
      balance?: string | number;
    };
  };
};

type CodexAuthClaims = Record<string, unknown>;

type CodexAuthFallback = {
  email?: string;
  planType?: string;
  claims?: CodexAuthClaims;
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CLIENT_INFO = {
  name: "agent-usage-stats",
  version: "0.0.0",
};

class CodexRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly stderrChunks: string[] = [];
  private readonly rl;
  private nextId = 1;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderrChunks.push(chunk.toString());
    });
    this.child.on("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      const message =
        code === 0
          ? "Codex RPC process exited unexpectedly"
          : `Codex RPC process exited (${code ?? "unknown"}$${
              signal ? `:${signal}` : ""
            })`;
      this.failAllPending(new Error(message));
    });
  }

  static async connect(binaryPath: string): Promise<CodexRpcClient> {
    const child = spawn(binaryPath, ["-s", "read-only", "-a", "untrusted", "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new CodexRpcClient(child);
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number
  ): Promise<T> {
    if (this.closed) {
      throw new Error("Codex RPC client is closed");
    }

    const id = this.nextId++;
    const payload: RpcRequest = { jsonrpc: "2.0", id, method, params };
    const serialized = JSON.stringify(payload);
    const response = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });
    });

    this.child.stdin.write(`${serialized}\n`);

    return response;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) {
      return;
    }
    const payload: RpcRequest = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rl.close();
    this.child.stdin.end();
    this.child.kill();
    this.failAllPending(new Error("Codex RPC client closed"));
  }

  private handleLine(line: string): void {
    let payload: RpcResponse<unknown> | null = null;
    try {
      payload = JSON.parse(line) as RpcResponse<unknown>;
    } catch {
      return;
    }
    if (!payload || typeof payload.id !== "number") {
      return;
    }
    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }
    this.pending.delete(payload.id);
    clearTimeout(pending.timeoutId);
    if (payload.error) {
      pending.reject(
        new Error(`Codex RPC error ${payload.error.code}: ${payload.error.message}`)
      );
      return;
    }
    pending.resolve(payload.result);
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  get stderr(): string {
    return this.stderrChunks.join("").trim();
  }
}

export async function fetchCodexUsage(
  options: CodexFetchOptions = {}
): Promise<CodexUsageSnapshot> {
  const binaryPath = options.binaryPath ?? "codex";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
  const authPath = options.authPath ?? join(homedir(), ".codex", "auth.json");

  const client = await CodexRpcClient.connect(binaryPath);
  try {
    await client.request("initialize", { clientInfo }, timeoutMs);
    client.notify("initialized", {});

    const accountResult = await client.request<CodexAccountResponse>(
      "account/read",
      {},
      timeoutMs
    );
    const rateLimitsResult = await client.request<CodexRateLimitsResponse>(
      "account/rateLimits/read",
      {},
      timeoutMs
    );

    const authFallback = await readCodexAuth(authPath).catch(() => undefined);
    const account = mergeAccount(accountResult, authFallback);
    const rateLimits = normalizeRateLimits(rateLimitsResult);

    return {
      source: "rpc",
      fetchedAt: Date.now(),
      account,
      rateLimits,
      raw: {
        account: accountResult,
        rateLimits: rateLimitsResult,
      },
    };
  } catch (error) {
    const stderr = client.stderr;
    if (stderr) {
      throw new Error(`${(error as Error).message}\nCodex stderr: ${stderr}`);
    }
    throw error;
  } finally {
    await client.close();
  }
}

function normalizeRateLimits(result: CodexRateLimitsResponse): CodexRateLimits | undefined {
  if (!result.rateLimits) {
    return undefined;
  }
  const credits = result.rateLimits.credits
    ? {
        hasCredits: result.rateLimits.credits.hasCredits,
        unlimited: result.rateLimits.credits.unlimited,
        balance: parseCreditsBalance(result.rateLimits.credits.balance),
      }
    : undefined;

  return {
    primary: result.rateLimits.primary,
    secondary: result.rateLimits.secondary,
    credits,
  };
}

function parseCreditsBalance(balance: string | number | undefined): number | undefined {
  if (typeof balance === "number") {
    return Number.isFinite(balance) ? balance : undefined;
  }
  if (typeof balance !== "string") {
    return undefined;
  }
  const normalized = balance.replace(/,/g, "").trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mergeAccount(
  result: CodexAccountResponse,
  fallback?: CodexAuthFallback
): CodexAccount | undefined {
  const account = result.account ?? {};
  const merged: CodexAccount = {
    type: account.type,
    email: account.email ?? fallback?.email,
    planType: account.planType ?? fallback?.planType,
    requiresOpenaiAuth: result.requiresOpenaiAuth,
  };
  const hasAnyValue = Object.values(merged).some((value) => value !== undefined);
  return hasAnyValue ? merged : undefined;
}

async function readCodexAuth(authPath: string): Promise<CodexAuthFallback | undefined> {
  const raw = await readFile(authPath, "utf8");
  const parsed = JSON.parse(raw) as { tokens?: { idToken?: string } };
  const idToken = parsed.tokens?.idToken;
  if (!idToken) {
    return undefined;
  }
  const claims = decodeJwtPayload(idToken);
  if (!claims) {
    return undefined;
  }
  return {
    email:
      (claims["https://api.openai.com/profile.email"] as string | undefined) ??
      (claims.email as string | undefined),
    planType:
      (claims["https://api.openai.com/auth.chatgpt_plan_type"] as string | undefined) ??
      (claims.chatgpt_plan_type as string | undefined),
    claims,
  };
}

function decodeJwtPayload(token: string): CodexAuthClaims | undefined {
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded) as CodexAuthClaims;
  } catch {
    return undefined;
  }
}

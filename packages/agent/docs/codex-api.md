# Codex Usage Statistics API - Implementation Guide

Based on investigation of `steipete/codexbar`, here's the complete API spec for Codex usage fetching:

---

## 1. API BASE & ENDPOINTS

### Primary: Codex RPC (Local Process)

- **Type**: JSON-RPC 2.0 over stdin/stdout pipes
- **Binary**: `codex` CLI (launched with `-s read-only -a untrusted app-server`)
- **Transport**: Process pipes (stdin/stdout), newline-delimited JSON
- **Methods**:
  - `initialize` - Handshake
  - `account/read` - Fetch account details (email, plan)
  - `account/rateLimits/read` - Fetch rate limits & credits

### Fallback: Codex PTY Scrape

- **Type**: TTY interactive mode
- **Command**: `codex /status` (sent to PTY)
- **Terminal Size**: 60-70 rows × 200-220 cols (with retry logic)
- **Output**: Text parsing of status screen

### Optional: OpenAI Web Dashboard

- **URL**: `https://chatgpt.com/codex/settings/usage`
- **Type**: WebView scraping (uses browser cookies)
- **Auth**: Safari/Chrome cookies (requires Full Disk Access on macOS)

---

## 2. REQUIRED HEADERS / AUTH

### RPC (Process)

- **No HTTP headers** - uses process pipes
- **Environment Variables**:
  - `PATH` must include Node tooling and binary paths
  - `CODEX_HOME`: defaults to `~/.codex` (contains `auth.json`)
- **Session**: Codex binary handles internal auth via `~/.codex/auth.json`

### PTY (Fallback)

- **No auth headers** - uses local binary
- **Auth from**: `~/.codex/auth.json` (JWT-based, decoded from `tokens.idToken`)
- **JWT Fields** (from `https://api.openai.com/auth` and `https://api.openai.com/profile` claims):
  - `chatgpt_plan_type` - Plan type
  - `email` - Account email

### Web Dashboard

- **Cookies**: Safari/Chrome persistent cookies for `chatgpt.com` and `openai.com`
- **No Bearer tokens** - auth is session-based
- **Requires**: User already logged into `chatgpt.com` in Safari/Chrome

---

## 3. REQUEST METHOD / BODY / QUERY PARAMS

### RPC - Initialize

```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "codexbar",
      "version": "0.5.4"
    }
  }
}
```

### RPC - Fetch Account Details

```json
{
  "id": 2,
  "method": "account/read",
  "params": {}
}
```

**Response**:

```json
{
  "id": 2,
  "result": {
    "account": {
      "type": "chatgpt",
      "email": "user@example.com",
      "planType": "pro"
    },
    "requiresOpenaiAuth": false
  }
}
```

### RPC - Fetch Rate Limits & Credits

```json
{
  "id": 3,
  "method": "account/rateLimits/read",
  "params": {}
}
```

**Response Shape**:

```json
{
  "id": 3,
  "result": {
    "rateLimits": {
      "primary": {
        "usedPercent": 45.5,
        "windowDurationMins": 300,
        "resetsAt": 1735001234
      },
      "secondary": {
        "usedPercent": 22.0,
        "windowDurationMins": 10080,
        "resetsAt": 1735260000
      },
      "credits": {
        "hasCredits": true,
        "unlimited": false,
        "balance": "12.50"
      }
    }
  }
}
```

### PTY - Send `/status`

- **Input**: Send string `/status\n` to PTY stdin
- **Output**: ANSI-formatted status screen text
- **Timeout**: 18s (retry with 24s timeout if parse fails)

### Web Dashboard

- **URL**: `https://chatgpt.com/codex/settings/usage` (loaded in WebView)
- **Method**: GET (SPA, no API calls)
- **Auth**: Cookie-based (imported from browser)

---

## 4. RESPONSE SHAPE

### RPC Rate Limits Response

```swift
struct RPCRateLimitWindow {
  let usedPercent: Double       // 0-100
  let windowDurationMins: Int?  // 300 (5h) or 10080 (1 week)
  let resetsAt: Int?            // Unix timestamp
}

struct RPCCreditsSnapshot {
  let hasCredits: Bool
  let unlimited: Bool
  let balance: String?          // e.g., "12.50"
}
```

### PTY Status Parsing

Regex patterns extracted from output:

- **Credits**: `Credits:\s*([0-9][0-9.,]*)`
- **5h Limit**: Line matching `5h limit[^\n]*` → extract percentage + reset text
- **Weekly Limit**: Line matching `Weekly limit[^\n]*` → extract percentage + reset text
- **Reset Format**: Relative text (e.g., "resets in 2h 30m") or absolute date

### Web Dashboard Scraping

JavaScript extracts from DOM:

- **Code Review Remaining**: Percentage from UI elements
- **Credit Events**: Table rows with date/service/amount
- **Usage Breakdown**: Daily breakdown JSON from SPA state
- **Credits Purchase URL**: Link to buy more credits

---

## 5. RATE LIMITING & CACHING BEHAVIOR

### Codex RPC

- **Per-request serialization**: All RPC requests are serialized (no concurrent requests to avoid starving readers on single stdout pipe)
- **No explicit rate limiting**: Process-based, runs locally
- **Connection reuse**: Each fetch creates new process, runs batch queries, then terminates

### PTY

- **Timeout**: 18s base, 24s on retry
- **Retry logic**: If parse fails (e.g., timeout), retry once with larger PTY (70×220 rows)
- **No caching**: Fresh fetch each time

### Web Dashboard

- **WebView pooling**: Cached WebView instances per account email to avoid recreating browser context
- **Polling timeout**: 60s max to load page (includes hydration wait for JS frameworks)
- **No rate limiting**: Client-side scraping only

### Cache in `codexbar`

- **Credits**: Cached when RPC unavailable (fallback retains last known balance)
- **Account info**: Loaded synchronously from `~/.codex/auth.json` (JWT parse)

---

## 6. NORMALIZATION LOGIC

### Percentage Calculation

```
used% = 100 - remaining%
remaining% = 100 - used%
```

- RPC: `usedPercent` is provided directly
- PTY: Extract percentage from text, invert if needed

### Credits Parsing

- RPC: String balance → `parseDouble(balance)`
- PTY: Regex `Credits:\s*([0-9][0-9.,]*)` → parse with locale-aware number handling
- Fallback: Keep cached value if unavailable

### Reset Time Conversion

- RPC: `resetsAt` is Unix timestamp → convert to Date, format as relative string
- PTY: Extract textual reset description directly from screen (e.g., "resets in 2h")

### Account Info

- RPC: `account` object with `email` and `planType`
- JWT (PTY fallback):
  - Extract from `https://api.openai.com/auth.chatgpt_plan_type` claim
  - Extract from `https://api.openai.com/profile.email` claim
  - Fallback to root `email` and `chatgpt_plan_type` claims

---

## Key File Locations in `codexbar`

1. **RPC Client**: `Sources/CodexBarCore/UsageFetcher.swift` (lines 119-262)
   - `CodexRPCClient` class
   - Methods: `initialize()`, `fetchAccount()`, `fetchRateLimits()`
   - JSON-RPC wire protocol implementation

2. **PTY Scraper**: `Sources/CodexBarCore/CodexStatusProbe.swift`
   - `CodexStatusProbe.fetch()` - executes `codex /status` in PTY
   - `CodexStatusProbe.parse()` - regex-based text parsing
   - `TTYCommandRunner` - PTY management

3. **Models**:
   - `Sources/CodexBarCore/UsageFetcher.swift` (lines 119-175) - RPC response structs
   - `Sources/CodexBarCore/CodexStatusProbe.swift` - PTY output model
   - `Sources/CodexBarCore/CreditsModels.swift` - Credit snapshot model

4. **Web Dashboard** (optional):
   - `Sources/CodexBarCore/OpenAIWeb/OpenAIDashboardFetcher.swift` (line 21) - URL
   - `Sources/CodexBarCore/OpenAIWeb/OpenAIDashboardScrapeScript.swift` - JS injection
   - `Sources/CodexBarCore/OpenAIWeb/OpenAIDashboardParser.swift` - DOM parsing

---

## Implementation Checklist for `packages/agent/src/codex.ts`

- [ ] **RPC Client Setup**
  - [ ] Spawn `codex` process with `-s read-only -a untrusted app-server`
  - [ ] Pipe stdin/stdout, newline-delimited JSON
  - [ ] Implement JSON-RPC 2.0 request/response matching (by id)
  - [ ] Handle serialized request queue

- [ ] **Initialize Handshake**
  - [ ] Send `initialize` with clientInfo (name + version)
  - [ ] Send `initialized` notification after success

- [ ] **Fetch Endpoints**
  - [ ] `account/read` → parse email & plan
  - [ ] `account/rateLimits/read` → parse primary/secondary windows & credits

- [ ] **Fallback: PTY**
  - [ ] Spawn `codex` in PTY mode (pty size: 60×200)
  - [ ] Send `/status\n`
  - [ ] Parse ANSI output with regex patterns
  - [ ] Retry on timeout with larger PTY (70×220)

- [ ] **Error Handling**
  - [ ] Codex not installed → clear error message
  - [ ] Parse failures → partial fallback or retry
  - [ ] Timeouts → escalate to secondary method

- [ ] **Account Info Fallback**
  - [ ] Read `~/.codex/auth.json`
  - [ ] Decode JWT from `tokens.idToken`
  - [ ] Extract email & plan from JWT claims

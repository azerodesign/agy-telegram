# AGY USAGE MONITOR — PHASE 1: READ-ONLY SOURCE AUDIT

**Target Project:** `/home/ubuntu/agy-telegram`  
**Repository:** `https://github.com/azerodesign/agy-telegram`  
**Date of Audit:** October 31, 2026  
**Auditor:** Antigravity Engineering Pair Assistant  
**Status:** **READY WITH LIMITATIONS**

---

## 1. Executive Summary

This source audit investigates the feasibility and mechanism for retrieving real-time remaining quota and usage metadata across all 14 Google Auth accounts managed by Antigravity CLI (`agy`), without relying on estimated tokens or heuristic guessing.

### Key Discoveries
1. **Native Golden Endpoint Discovered:**  
   Antigravity CLI contains a native read-only slash command:
   ```bash
   agy --output-format json -p "/usage"
   ```
   This command directly queries Google Cloud Code Prediction Service (`/v1internal:retrieveUserQuotaSummary`) and returns exact, structured JSON metadata.
2. **Zero Quota Consumption Verified:**  
   Testing confirmed mathematically and empirically:
   - `input_tokens`: `0`
   - `output_tokens`: `0`
   - `thinking_tokens`: `0`
   - `cache_read_tokens`: `0`
   - `num_turns`: `0`
   - `duration_seconds`: `0`
   No model prompts are dispatched; no LLM tokens or quotas are consumed.
3. **Complete Coverage of All 3 Target Model Groups:**  
   The returned payload covers:
   - **Gemini Models** (Weekly Limit + Five-Hour Limit)
   - **Claude and GPT models** (Weekly Limit + Five-Hour Limit)
   - **Gemini 4 Argon** (Weekly Dedicated WTU Limit)
   Each group includes the exact `remaining_fraction` (float `0.0`–`1.0`), ISO-8601 UTC `reset_time`, human countdown string, and window identifiers (`"weekly"` / `"5h"`).
4. **Safe Multi-Account Isolation Feasibility:**  
   Because `agy` resolves its token file relative to `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`, querying individual account slots can be performed using an **isolated sandboxed `$HOME` environment** (`HOME=/tmp/agy_slot_probe/<slot>`). This guarantees that:
   - Production `antigravity-oauth-token` is **never modified**.
   - `round_robin_state.json` is **never touched**.
   - Active account selection is **not switched**.
   - The running `agy-telegram.service` daemon experiences **zero interruption**.

---

## 2. Existing AGY Usage Mechanism

### 2.1 AGY CLI Internal Source Locations
Decompilation and binary inspection of `/home/ubuntu/.local/bin/agy` revealed the following core components:

* **Command Definition:**  
  `google3/third_party/jetski/cli/commands/usage.go`
  * Implements `usageCommand` with aliases `/usage` and `/quota`.
  * In interactive TUI mode: builds `UsageModel` (Bubble Tea component).
  * In non-interactive print mode (`-p "/usage"`): executes a direct call to `CodeAssistClient.RetrieveUserQuotaSummary()` and writes structured output to stdout without launching the TUI.
* **TUI Renderer:**  
  `google3/third_party/jetski/cli/model/usage.go`
  * Implements `renderQuotaGroup`, `renderCreditsSection`, `renderQuotaDescription`, `quotaBarColor`, `quotaStatus`, `quotaStatusStyle`, and `formatDuration`.
* **RPC & Protocol Client:**  
  `google3/third_party/jetski/language_server/code_assist_client/codeassistclient.go`
  * Methods: `RetrieveUserQuotaSummary()` and `fetchRetrieveUserQuotaSummary()`.
  * Calls backend RPC: `google.internal.cloud.code.v1internal.PredictionService/RetrieveUserQuotaSummary`.
  * REST Transcoding Endpoint: `https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`.
* **Protobuf Definitions:**  
  `google3/google/internal/cloud/code/v1internal/v1internal_prediction_service_go_proto`:
  * `RetrieveUserQuotaSummaryRequest` (`project`)
  * `RetrieveUserQuotaSummaryResponse` (`groups`, `buckets`, `description`)
  * `QuotaSummaryGroup` (`display_name`, `description`, `buckets`)
  * `QuotaSummaryBucket` (`bucket_id`, `display_name`, `description`, `disabled`, `remaining`, `reset_time`, `window`)

### 2.2 Current `/usage` in `agy-telegram`
In [`/home/ubuntu/agy-telegram/bot.mjs`](file:///home/ubuntu/agy-telegram/bot.mjs):
* Line 3556–3576 handles `/usage`, `/9usage`, and `/agusage`.
* Function `getAgyAccountsUsage()` (lines 170–240) only reads static metadata from `/home/ubuntu/.gemini/antigravity-cli/accounts/`:
  * Account slot filename (`1.json` ... `14.json`)
  * Account plan (`PRO` vs `FREE`)
  * Masked email address
  * Active slot from `round_robin_state.json`
* **Limitation:** It currently does **not** retrieve live quota percentages or reset times.

---

## 3. Account Architecture & Slot Mapping

### 3.1 Account Storage
* **Base Directory:** `/home/ubuntu/.gemini/antigravity-cli`
* **Slot Directory:** `/home/ubuntu/.gemini/antigravity-cli/accounts/`
* **Active Token File:** `/home/ubuntu/.gemini/antigravity-cli/antigravity-oauth-token`
* **State File:** `/home/ubuntu/.gemini/antigravity-cli/accounts/round_robin_state.json`

### 3.2 Account Slot Mapping
All 14 accounts are stored as standardized JSON files:
* **Slot JSON Schema:**
  ```json
  {
    "token": {
      "access_token": "<REDACTED>",
      "token_type": "Bearer",
      "refresh_token": "<REDACTED>",
      "expiry": "2026-10-31T17:20:44.525564843+08:00",
      "expires_in": 3599
    },
    "auth_method": "consumer",
    "id_token_email": "<REDACTED>@gmail.com",
    "plan": "PRO" | "FREE"
  }
  ```
* **Slot Distribution:**
  * **PRO Accounts (7 Slots):** `1`, `5`, `6`, `7`, `9`, `10`, `12`
  * **FREE Accounts (7 Slots):** `2`, `3`, `4`, `8`, `11`, `13`, `14`
  * **Total Managed Slots:** 14 accounts

### 3.3 Account Selection & Rotation Managers
Two helper scripts on the system govern account rotation:
1. [`/home/ubuntu/.local/bin/ag-acc`](file:///home/ubuntu/.local/bin/ag-acc):
   * `switch_to_slot(slot)`: Overwrites `antigravity-oauth-token` with the slot's token and updates `round_robin_state.json`.
   * `rotate_round_robin()`: Iterates through the PRO pool, respects 1-hour cooldowns for rate-limited accounts, and switches slot.
   * `sync_active_to_slot()`: Two-way sync saving refreshed tokens back to the slot file.
2. [`/home/ubuntu/.local/bin/ag-smart`](file:///home/ubuntu/.local/bin/ag-smart):
   * Wrapper around `agy "$@"` that tails `cli.log` and automatically triggers `ag-acc rotate-quota` upon detecting HTTP 429 / resource exhaustion.

---

## 4. Quota Data Availability Matrix

Empirical validation using `agy --output-format json -p "/usage"` produced the following schema verification:

| Model Group | Bucket ID | Window | Metric Available | Reset Timestamp Available | Human Countdown Available |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Gemini Models** | `gemini-weekly` | Weekly | `remaining_fraction` (0.0–1.0) | ISO-8601 UTC (e.g. `2026-11-01T06:51:19Z`) | "will fully refresh in X hours, Y min" |
| **Gemini Models** | `gemini-5h` | 5-Hour | `remaining_fraction` (0.0–1.0) | ISO-8601 UTC (e.g. `2026-10-31T10:57:50Z`) | "will fully refresh in X hours, Y min" |
| **Claude & GPT Models** | `3p-weekly` | Weekly | `remaining_fraction` (0.0–1.0) | ISO-8601 UTC (e.g. `2026-11-05T08:24:58Z`) | "will fully refresh in X days, Y hours" |
| **Claude & GPT Models** | `3p-5h` | 5-Hour | `remaining_fraction` (0.0–1.0) | ISO-8601 UTC (e.g. `2026-10-31T14:31:12Z`) | N/A (Standard reset window) |
| **Gemini 4 Argon** | `gemini-argon-wtu-weekly` | Weekly | `remaining_fraction` (0.0–1.0) | ISO-8601 UTC (e.g. `2026-11-04T15:41:19Z`) | "will fully refresh in X days, Y hours" |

### Availability Summary:
* **Remaining Percentage:** Available across all 3 groups via `remaining_fraction * 100`.
* **5-Hour Quota:** Available for Gemini Models and Claude & GPT Models.
* **Weekly Quota:** Available for Gemini Models, Claude & GPT Models, and Gemini 4 Argon.
* **Reset Metadata:** 100% available with exact UTC timestamps.
* **Exhaustion Status:** Directly indicated when `remaining_fraction == 0.0` or if `disabled: true`.

---

## 5. Safe Retrieval Analysis for All 14 Accounts

### 5.1 The Danger of Naive Account Switching
Executing `ag-acc switch <slot>` across 14 accounts in production would:
1. Overwrite the shared `antigravity-oauth-token` 14 times.
2. Interfere with `agy-telegram.service` (PID 744050) while it is actively processing user queries.
3. Advance `round_robin_state.json` counters and disrupt session affinity.
4. Risk race conditions and token desynchronization.

### 5.2 The Safe Sandboxed Query Pattern (Validated)
Because `agy` reads `~/.gemini/antigravity-cli/antigravity-oauth-token` by resolving `$HOME`:
```
Isolated Environment:
HOME=/tmp/agy_probes/slot_<ID>
└── .gemini/antigravity-cli/
    └── antigravity-oauth-token  <-- Copy/Symlink of accounts/<ID>.json
```
Executing:
```bash
HOME=/tmp/agy_probes/slot_<ID> agy --output-format json -p "/usage"
```
**Safety Verification Results:**
* Production `/home/ubuntu/.gemini/antigravity-cli/antigravity-oauth-token` remains untouched.
* `round_robin_state.json` remains untouched.
* The running `agy-telegram.service` process is unaffected.
* Active account selection in the live bot does not change.
* Total prompt token usage is exactly zero.

---

## 6. Technical Limitations & Operational Risks

### Limitation 1: Expired Access Tokens on Inactive Slots
* **Detail:** Google OAuth2 access tokens have a lifetime of 3,600 seconds (1 hour). Accounts that have been idle for more than 1 hour have expired `access_token` values.
* **Impact:** When `agy` runs for an account with an expired access token, it automatically contacts Google's OAuth endpoint (`https://oauth2.googleapis.com/token`) using the `refresh_token` to obtain a fresh `access_token`.
* **Constraint Compliance:** In Phase 1, credential refresh was prohibited. In Phase 2 implementation, querying idle slots will either:
  * Automatically perform standard OAuth token refresh inside the isolated sandbox, or
  * Only query slots whose tokens are currently valid, or
  * Sync refreshed tokens back to their respective slot files atomically.

### Limitation 2: Process Concurrency
* **Detail:** Spawning 14 instances of `agy` concurrently would consume unnecessary CPU and memory.
* **Mitigation:** Probes must run sequentially with brief pacing (e.g., 300–500ms between slots), or background collection can be throttled with a cache TTL of 5–15 minutes.

### Limitation 3: API Rate Limiting on Quota Endpoint
* **Detail:** While `/v1internal:retrieveUserQuotaSummary` is free, sending hundreds of requests per minute could trigger Google's Cloud Code PA rate limit (HTTP 429).
* **Mitigation:** Implement in-memory caching with a minimum 5-minute TTL so telegram users requesting `/usage` read from cache instead of querying Google 14 times on every button click.

---

## 7. Recommended Architecture for Phase 2 Implementation

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AGY Telegram Bridge                             │
│                  Telegram User (/usage / /agusage)                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Usage Collector Module                          │
│   • Checks CacheStore (TTL: 5-15 min)                                  │
│   • If cache valid -> Returns instant rich table                       │
│   • If cache stale/empty -> Triggers Async Background Scanner          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      Sandboxed Account Scanner                         │
│   1. Reads /home/ubuntu/.gemini/antigravity-cli/accounts/*.json        │
│   2. For each slot (1 to 14):                                          │
│      a. Prepares /tmp/agy_monitor/slot_<id>/.../antigravity-oauth-token│
│      b. Executes: HOME=/tmp/agy_monitor/slot_<id> agy --output-format  │
│         json -p "/usage"                                               │
│      c. Captures stdout JSON without touching production files         │
│      d. (Optional) Two-way syncs refreshed token back to slot file     │
│      e. Cleans up temporary sandbox directory                         │
│   3. Isolates errors: If slot fails, marks slot as 'UNAVAILABLE'       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       Model-Group Quota Parser                         │
│   • Normalizes groups into unified model metrics:                      │
│     - Gemini (5h % & reset, Weekly % & reset)                          │
│     - Claude/GPT (5h % & reset, Weekly % & reset)                      │
│     - Argon (Weekly % & reset)                                         │
│   • Computes pool health summary (Active PRO, Standby, Cooldown)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       Cache & Presentation Layer                       │
│   • Updates in-memory / JSON cache                                     │
│   • Generates tg-rich-messages native table view for Telegram          │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Explicit Matrix: Quota-Consuming vs Non-Consuming Operations

| Operation | Consumes LLM Quota? | Modifies Account State? | Safe in Background? |
| :--- | :---: | :---: | :---: |
| `agy --output-format json -p "/usage"` | **NO** (0 tokens) | **NO** (Read-only RPC) | **YES** |
| `HOME=/tmp/... agy -p "/usage"` | **NO** (0 tokens) | **NO** (Fully isolated) | **YES** |
| `ag-acc switch <slot>` | **NO** (0 tokens) | **YES** (Overwrites active token) | **NO** (Breaks prod) |
| `ag-acc rotate-quota` | **NO** (0 tokens) | **YES** (Modifies state file) | **NO** (Disrupts order) |
| `agy -p "any prompt"` | **YES** (Normal tokens) | **YES** (Updates session DB) | **NO** (Wastes quota) |
| `agy models` | **NO** (0 tokens) | **NO** (Read-only models list) | **YES** |

---

## 9. Conclusion

### **READY WITH LIMITATIONS**

The source audit is complete. A 100% reliable, zero-quota data source exists natively in `agy` via `agy --output-format json -p "/usage"`. All three requested model groups (Gemini, Claude/GPT, Argon) are supported with exact remaining percentages, 5-hour/weekly windows, and UTC reset timestamps.

**Operational Limitation for Phase 2:**  
To inspect all 14 accounts safely, the implementation must use the **Sandboxed `$HOME` pattern** to avoid touching production credentials or disrupting `agy-telegram.service`. Additionally, accounts whose access tokens have lapsed past their 1-hour lifetime will perform a standard OAuth refresh token exchange when probed.

*Awaiting review and approval before proceeding to Phase 2.*

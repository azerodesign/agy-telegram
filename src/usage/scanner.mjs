/**
 * AGY Usage Monitor - Standalone Scanner & Collector Engine (Phase 2 Remediation)
 * 
 * Safety Guarantees:
 * - 100% Read-Only to Production Credentials: Never modifies accounts/*.json or active token.
 * - Isolated Ephemeral Sandboxes: Uses byte-copy into /tmp/... with mode 0700/0600 (NO SYMLINKS).
 * - Zero Write-Back: Tokens refreshed by OAuth in sandbox are permanently discarded upon cleanup.
 * - Scoped Lifecycle Cleanup: try/finally per probe + scoped collector cleanup (NO global signal hijacking).
 * - Child Process Safety: Process groups detached, wait for child exit before teardown, timers cleared.
 * - Strict Quota Validation: OK (all metrics), PARTIAL (some metrics), UNKNOWN (zero metrics / null).
 * - Plan Classification: PRO -> pro, FREE -> free, Unknown/Missing -> unknown (never silent fallback).
 * - Email Privacy: Short and long localparts strictly masked; full email never exposed in cache/logs.
 * - Stale Sandbox Recovery: Sweeps orphaned /tmp/agy_monitor_sandbox_* folders before execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Production constants (READ-ONLY)
export const PROD_BASE_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
export const PROD_ACCOUNTS_DIR = path.join(PROD_BASE_DIR, 'accounts');
export const PROD_ACTIVE_TOKEN = path.join(PROD_BASE_DIR, 'antigravity-oauth-token');
export const PROD_STATE_FILE = path.join(PROD_ACCOUNTS_DIR, 'round_robin_state.json');

// Sandboxing constants
export const SANDBOX_PREFIX = 'agy_monitor_sandbox_';
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_PACING_MS = 400;
export const DEFAULT_CACHE_TTL_MS = 600000; // 10 minutes
export const DEFAULT_CACHE_PATH = path.join(os.tmpdir(), 'agy_usage_cache.json');

// Total expected quota metrics across the 3 target model groups
export const TOTAL_EXPECTED_METRICS = 5; // gemini(5h, weekly), claude(5h, weekly), argon(weekly)

// Active sandbox registry for explicit teardown
const activeSandboxes = new Set();

/**
 * Synchronously destroys all currently registered active sandboxes.
 * Scoped to explicit invocation and collector teardown; does not hijack process exit.
 */
export function cleanupAllActiveSandboxesSync() {
  for (const dir of activeSandboxes) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (_) {}
  }
  activeSandboxes.clear();
}

/**
 * Returns the count of currently registered active sandboxes.
 */
export function getActiveSandboxCount() {
  return activeSandboxes.size;
}

/**
 * Sweep stale sandboxes from prior runs (e.g. from previous unhandled crash or SIGKILL)
 */
export function cleanStaleSandboxes(olderThanMinutes = 15) {
  const tmpDir = os.tmpdir();
  const now = Date.now();
  const thresholdMs = olderThanMinutes * 60 * 1000;
  let cleanedCount = 0;

  try {
    const entries = fs.readdirSync(tmpDir);
    for (const name of entries) {
      if (name.startsWith(SANDBOX_PREFIX)) {
        const fullPath = path.join(tmpDir, name);
        try {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > thresholdMs) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleanedCount++;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  return cleanedCount;
}

/**
 * Creates an isolated sandbox directory and copies the slot token byte-for-byte.
 * STRICTLY FORBIDS SYMLINKS. Enforces 0700/0600 permissions.
 */
export function createIsolatedSandbox(slot, sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source account credential not found: ${sourcePath}`);
  }

  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked source file for slot ${slot}`);
  }

  const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const sandboxRoot = path.join(os.tmpdir(), `${SANDBOX_PREFIX}${slot}_${uniqueId}`);
  const dotGemini = path.join(sandboxRoot, '.gemini', 'antigravity-cli');
  const targetTokenPath = path.join(dotGemini, 'antigravity-oauth-token');

  // Create directory with strict rwx------ permissions
  fs.mkdirSync(dotGemini, { recursive: true, mode: 0o700 });

  // Byte-copy credentials (NEVER SYMLINK)
  fs.copyFileSync(sourcePath, targetTokenPath);
  fs.chmodSync(targetTokenPath, 0o600);

  // Assertion: Target must NOT be a symlink
  const targetStat = fs.lstatSync(targetTokenPath);
  if (targetStat.isSymbolicLink()) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    throw new Error(`Security violation: sandbox token must not be a symlink`);
  }

  activeSandboxes.add(sandboxRoot);

  return {
    root: sandboxRoot,
    tokenPath: targetTokenPath
  };
}

/**
 * Destroys a sandbox directory and removes it from the tracking registry.
 */
export function destroyIsolatedSandbox(sandboxRoot) {
  try {
    if (sandboxRoot && fs.existsSync(sandboxRoot)) {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  } finally {
    if (sandboxRoot) {
      activeSandboxes.delete(sandboxRoot);
    }
  }
}

/**
 * Helper to run an operation inside a temporary isolated sandbox with guaranteed teardown.
 */
export async function withIsolatedSandbox(slot, sourcePath, fn) {
  const sandbox = createIsolatedSandbox(slot, sourcePath);
  try {
    return await fn(sandbox);
  } finally {
    destroyIsolatedSandbox(sandbox.root);
  }
}

/**
 * Safe Email Masker:
 * Ensures all email localparts (short, medium, long) are strictly masked.
 * Full email address is NEVER returned or exposed.
 * 
 * Rules:
 * - 1 char:  "a@domain.com"     -> "*@domain.com"
 * - 2 chars: "ab@domain.com"    -> "a*@domain.com"
 * - 3 chars: "abc@domain.com"   -> "a***@domain.com"
 * - 4 chars: "john@domain.com"  -> "j***@domain.com"
 * - 5+ chars: "zerocoffe0@..."  -> "zer***@domain.com"
 */
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return 'unknown';
  const trimmed = email.trim();
  const atIdx = trimmed.indexOf('@');
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return '***';

  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx); // includes '@'

  if (local.length === 1) {
    return `*${domain}`;
  }
  if (local.length === 2) {
    return `${local[0]}*${domain}`;
  }
  if (local.length <= 4) {
    return `${local[0]}***${domain}`;
  }
  return `${local.slice(0, 3)}***${domain}`;
}

/**
 * Validates and converts remaining_fraction (0.0 - 1.0) to an integer percentage (0 - 100).
 * Rejects NaN, Infinity, negative values, and values greater than 1.0.
 */
export function parseFractionToPct(frac) {
  if (typeof frac !== 'number' || Number.isNaN(frac) || !Number.isFinite(frac)) {
    return null;
  }
  if (frac < 0 || frac > 1) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(frac * 100)));
}

/**
 * Validates ISO-8601 UTC timestamp string.
 * Returns valid trimmed string or null.
 */
export function parseIsoTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return null;
  const trimmed = ts.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return trimmed;
}

/**
 * Evaluates whether an error message or string indicates rate limiting (429).
 */
export function isRateLimitError(str) {
  if (!str || typeof str !== 'string') return false;
  return /resource_exhausted|rate limit exceeded|rate_limited|quota exceeded|429/i.test(str);
}

/**
 * Evaluates whether an error message or string indicates expired or invalid authentication.
 */
export function isAuthExpiredError(str) {
  if (!str || typeof str !== 'string') return false;
  return /authentication required|invalid_grant|not logged in|unauthorized|unauthenticated|token expired|login required/i.test(str);
}

/**
 * Parser for `agy --output-format json -p "/usage"` response.
 * 
 * Status Contract:
 * - 'OK': All 5 expected quota metrics are valid and present.
 * - 'PARTIAL': At least 1 valid quota metric is present, but others are missing.
 * - 'UNKNOWN': No valid quota metrics found (never reports OK when metrics are null).
 * - 'RATE_LIMITED': Google Cloud Code rate limit / quota exhaustion encountered.
 * - 'AUTH_EXPIRED': Authentication expired or invalid grant.
 */
export function parseUsageOutput(rawOutput) {
  const result = {
    status: 'UNKNOWN',
    gemini: {
      pct5h: null,
      reset5hUtc: null,
      pctWeekly: null,
      resetWeeklyUtc: null
    },
    claudeGpt: {
      pct5h: null,
      reset5hUtc: null,
      pctWeekly: null,
      resetWeeklyUtc: null
    },
    argon: {
      pctWeekly: null,
      resetWeeklyUtc: null
    },
    errorMessage: null
  };

  if (!rawOutput || typeof rawOutput !== 'string') {
    result.errorMessage = 'Empty probe output';
    return result;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (_) {
    // Non-JSON fallback attempt
  }

  // Path 1: Structured JSON output
  if (parsed && typeof parsed === 'object') {
    // Check JSON-level error payload
    if (parsed.status && parsed.status !== 'SUCCESS') {
      const errText = parsed.response || parsed.error?.message || parsed.message || `Status: ${parsed.status}`;
      if (isRateLimitError(errText)) {
        result.status = 'RATE_LIMITED';
        result.errorMessage = errText;
      } else if (isAuthExpiredError(errText)) {
        result.status = 'AUTH_EXPIRED';
        result.errorMessage = errText;
      } else {
        result.status = 'UNKNOWN';
        result.errorMessage = errText;
      }
      return result;
    }

    if (parsed.error) {
      const errText = parsed.error.message || JSON.stringify(parsed.error);
      if (isRateLimitError(errText)) {
        result.status = 'RATE_LIMITED';
        result.errorMessage = errText;
      } else if (isAuthExpiredError(errText)) {
        result.status = 'AUTH_EXPIRED';
        result.errorMessage = errText;
      } else {
        result.status = 'UNKNOWN';
        result.errorMessage = errText;
      }
      return result;
    }

    if (parsed.status === 'SUCCESS') {
      const groups = parsed.command?.data?.groups;

      if (Array.isArray(groups)) {
        for (const g of groups) {
          const gName = (g.name || '').toLowerCase();
          const buckets = Array.isArray(g.buckets) ? g.buckets : [];

          // 1. Gemini Models
          if (gName.includes('gemini') && !gName.includes('argon')) {
            for (const b of buckets) {
              const pct = parseFractionToPct(b.remaining_fraction);
              const resetTs = parseIsoTimestamp(b.reset_time);
              if (b.window === '5h' || b.id === 'gemini-5h') {
                result.gemini.pct5h = pct;
                result.gemini.reset5hUtc = resetTs;
              } else if (b.window === 'weekly' || b.id === 'gemini-weekly') {
                result.gemini.pctWeekly = pct;
                result.gemini.resetWeeklyUtc = resetTs;
              }
            }
          }

          // 2. Claude and GPT models
          else if (gName.includes('claude') || gName.includes('gpt')) {
            for (const b of buckets) {
              const pct = parseFractionToPct(b.remaining_fraction);
              const resetTs = parseIsoTimestamp(b.reset_time);
              if (b.window === '5h' || b.id === '3p-5h') {
                result.claudeGpt.pct5h = pct;
                result.claudeGpt.reset5hUtc = resetTs;
              } else if (b.window === 'weekly' || b.id === '3p-weekly') {
                result.claudeGpt.pctWeekly = pct;
                result.claudeGpt.resetWeeklyUtc = resetTs;
              }
            }
          }

          // 3. Gemini 4 Argon
          else if (gName.includes('argon')) {
            for (const b of buckets) {
              const pct = parseFractionToPct(b.remaining_fraction);
              const resetTs = parseIsoTimestamp(b.reset_time);
              if (b.window === 'weekly' || b.id?.includes('weekly')) {
                result.argon.pctWeekly = pct;
                result.argon.resetWeeklyUtc = resetTs;
              }
            }
          }
        }
      }

      // Count valid metrics to determine OK vs PARTIAL vs UNKNOWN
      let validMetricCount = 0;
      if (result.gemini.pct5h !== null) validMetricCount++;
      if (result.gemini.pctWeekly !== null) validMetricCount++;
      if (result.claudeGpt.pct5h !== null) validMetricCount++;
      if (result.claudeGpt.pctWeekly !== null) validMetricCount++;
      if (result.argon.pctWeekly !== null) validMetricCount++;

      if (validMetricCount === TOTAL_EXPECTED_METRICS) {
        result.status = 'OK';
      } else if (validMetricCount > 0) {
        result.status = 'PARTIAL';
      } else {
        result.status = 'UNKNOWN';
        result.errorMessage = 'No valid quota metrics found in response';
      }

      return result;
    }
  }

  // Path 2: Text / TSV Fallback Parsing
  if (isRateLimitError(rawOutput)) {
    result.status = 'RATE_LIMITED';
    result.errorMessage = 'Google Cloud Code rate limit encountered';
    return result;
  }
  if (isAuthExpiredError(rawOutput)) {
    result.status = 'AUTH_EXPIRED';
    result.errorMessage = 'Authentication expired or invalid';
    return result;
  }

  const lines = rawOutput.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = line.split('\t').map(p => p.trim());
    if (parts.length >= 3) {
      const g = parts[0].toLowerCase();
      const lim = parts[1].toLowerCase();
      const pctMatch = parts[2].match(/(\d+)%/);
      const rawPct = pctMatch ? parseInt(pctMatch[1], 10) : null;
      const pct = (rawPct !== null && !Number.isNaN(rawPct) && rawPct >= 0 && rawPct <= 100) ? rawPct : null;
      const resetTime = parseIsoTimestamp(parts[3]);

      if (g.includes('gemini') && !g.includes('argon')) {
        if (lim.includes('five hour') || lim.includes('5h')) {
          result.gemini.pct5h = pct;
          result.gemini.reset5hUtc = resetTime;
        } else if (lim.includes('weekly')) {
          result.gemini.pctWeekly = pct;
          result.gemini.resetWeeklyUtc = resetTime;
        }
      } else if (g.includes('claude') || g.includes('gpt')) {
        if (lim.includes('five hour') || lim.includes('5h')) {
          result.claudeGpt.pct5h = pct;
          result.claudeGpt.reset5hUtc = resetTime;
        } else if (lim.includes('weekly')) {
          result.claudeGpt.pctWeekly = pct;
          result.claudeGpt.resetWeeklyUtc = resetTime;
        }
      } else if (g.includes('argon')) {
        if (lim.includes('weekly')) {
          result.argon.pctWeekly = pct;
          result.argon.resetWeeklyUtc = resetTime;
        }
      }
    }
  }

  let validMetricCount = 0;
  if (result.gemini.pct5h !== null) validMetricCount++;
  if (result.gemini.pctWeekly !== null) validMetricCount++;
  if (result.claudeGpt.pct5h !== null) validMetricCount++;
  if (result.claudeGpt.pctWeekly !== null) validMetricCount++;
  if (result.argon.pctWeekly !== null) validMetricCount++;

  if (validMetricCount === TOTAL_EXPECTED_METRICS) {
    result.status = 'OK';
  } else if (validMetricCount > 0) {
    result.status = 'PARTIAL';
  } else {
    result.status = 'UNKNOWN';
    result.errorMessage = 'Could not parse quota metrics from output';
  }

  return result;
}

/**
 * Safely kills a child process and its detached process group.
 */
export function killChildProcessGroup(child, signal = 'SIGKILL') {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (_) {
    try {
      child.kill(signal);
    } catch (_) {}
  }
}

/**
 * Execute a single isolated probe for one slot.
 * Zero side-effects on production credentials or round_robin_state.
 */
export async function probeSingleSlot(slot, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const accountsDir = options.accountsDir || PROD_ACCOUNTS_DIR;
  const sourceFile = path.join(accountsDir, `${slot}.json`);
  const spawnCommand = options.command || 'agy';
  const spawnArgs = options.args || ['--output-format', 'json', '-p', '/usage'];

  const outputRecord = {
    slot: String(slot),
    plan: 'UNKNOWN',
    email: 'unknown',
    status: 'UNKNOWN',
    lastCheckedUtc: new Date().toISOString(),
    gemini: { pct5h: null, reset5hUtc: null, pctWeekly: null, resetWeeklyUtc: null },
    claudeGpt: { pct5h: null, reset5hUtc: null, pctWeekly: null, resetWeeklyUtc: null },
    argon: { pctWeekly: null, resetWeeklyUtc: null },
    errorMessage: null
  };

  // 1. Read static metadata safely (Read-Only)
  if (!fs.existsSync(sourceFile)) {
    outputRecord.errorMessage = `Slot file ${slot}.json does not exist`;
    return outputRecord;
  }

  try {
    const rawAccount = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    outputRecord.plan = (rawAccount.plan || 'UNKNOWN').toUpperCase();
    outputRecord.email = maskEmail(rawAccount.id_token_email || rawAccount.email);
  } catch (err) {
    outputRecord.errorMessage = `Failed to parse ${slot}.json: ${err.message}`;
    return outputRecord;
  }

  // 2. Run sandboxed execution with guaranteed child process exit before teardown
  try {
    const rawStdout = await withIsolatedSandbox(slot, sourceFile, async (sandbox) => {
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let isTimedOut = false;
        let timer = null;
        let killTimer = null;

        const child = spawn(spawnCommand, spawnArgs, {
          env: {
            ...process.env,
            HOME: sandbox.root, // Force CLI to use sandbox
            ANTIGRAVITY_APP_DATA_DIR: path.join(sandbox.root, '.gemini', 'antigravity-cli')
          },
          detached: true, // Allocate new process group for clean multi-process termination
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const onStdout = (d) => { stdout += d.toString('utf8'); };
        const onStderr = (d) => { stderr += d.toString('utf8'); };

        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);

        const cleanupAndFinish = (result) => {
          if (settled) return;
          settled = true;

          if (timer) { clearTimeout(timer); timer = null; }
          if (killTimer) { clearTimeout(killTimer); killTimer = null; }

          try {
            child.stdout?.removeListener('data', onStdout);
            child.stderr?.removeListener('data', onStderr);
            child.removeAllListeners('close');
            child.removeAllListeners('error');
          } catch (_) {}

          resolve(result);
        };

        // Timeout handler: Signals process group and WAITS for actual exit
        timer = setTimeout(() => {
          isTimedOut = true;
          killChildProcessGroup(child, 'SIGTERM');

          // Escalate to SIGKILL after 500ms if child has not exited
          killTimer = setTimeout(() => {
            killChildProcessGroup(child, 'SIGKILL');
            // Safety fallback: if OS close event never fires after SIGKILL
            setTimeout(() => {
              cleanupAndFinish({ timedOut: true, stdout, stderr });
            }, 500).unref();
          }, 500);
        }, timeoutMs);

        child.on('close', (code, signal) => {
          cleanupAndFinish({ timedOut: isTimedOut, code, signal, stdout, stderr });
        });

        child.on('error', (err) => {
          cleanupAndFinish({ timedOut: false, error: err, stdout, stderr });
        });
      });
    });

    if (rawStdout.timedOut) {
      outputRecord.status = 'UNKNOWN';
      outputRecord.errorMessage = `Probe timed out after ${timeoutMs}ms`;
      return outputRecord;
    }

    if (rawStdout.error) {
      outputRecord.status = 'UNKNOWN';
      outputRecord.errorMessage = `Process execution error: ${rawStdout.error.message}`;
      return outputRecord;
    }

    // 3. Parse output safely
    const parsed = parseUsageOutput(rawStdout.stdout || rawStdout.stderr);
    outputRecord.status = parsed.status;
    outputRecord.gemini = parsed.gemini;
    outputRecord.claudeGpt = parsed.claudeGpt;
    outputRecord.argon = parsed.argon;
    outputRecord.errorMessage = parsed.errorMessage;

    return outputRecord;
  } catch (err) {
    outputRecord.status = 'UNKNOWN';
    outputRecord.errorMessage = `Sandbox error: ${err.message}`;
    return outputRecord;
  }
}

/**
 * Atomic cache persistence with strict 0600 file permissions.
 */
export function saveCacheAtomic(cachePath, cacheData) {
  const tmpPath = `${cachePath}.tmp.${Date.now()}`;
  const serialized = JSON.stringify(cacheData, null, 2);
  fs.writeFileSync(tmpPath, serialized, { mode: 0o600, encoding: 'utf8' });
  fs.renameSync(tmpPath, cachePath);
}

/**
 * Loads cache if present and unexpired.
 */
export function loadCache(cachePath = DEFAULT_CACHE_PATH, ttlMs = DEFAULT_CACHE_TTL_MS, nowMs = Date.now()) {
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw);
    const cacheAge = nowMs - (data.timestampMs || 0);
    if (cacheAge < ttlMs) {
      return { data, isStale: false, ageSeconds: Math.round(cacheAge / 1000) };
    }
    return { data, isStale: true, ageSeconds: Math.round(cacheAge / 1000) };
  } catch (_) {
    return null;
  }
}

/**
 * Sequential Account Scanner & Collector
 * Probes designated slots with pacing, partitions into PRO, FREE, and UNKNOWN pools.
 * Guarantees unknown plans are never classified as FREE.
 */
let isScanRunning = false;

export async function runSequentialCollector(targetSlots = null, options = {}) {
  if (isScanRunning) {
    return { status: 'SCAN_IN_PROGRESS', error: 'Another scan operation is currently active' };
  }

  isScanRunning = true;
  const startTime = Date.now();
  const pacingMs = options.pacingMs !== undefined ? options.pacingMs : DEFAULT_PACING_MS;
  const accountsDir = options.accountsDir || PROD_ACCOUNTS_DIR;
  const cachePath = options.cachePath || DEFAULT_CACHE_PATH;

  // Step 1: Pre-execution sweep of any stale sandboxes
  cleanStaleSandboxes(15);

  try {
    // Step 2: Determine slots to probe
    let slots = [];
    if (Array.isArray(targetSlots) && targetSlots.length > 0) {
      slots = targetSlots.map(s => String(s));
    } else {
      if (!fs.existsSync(accountsDir)) {
        throw new Error(`Accounts directory does not exist: ${accountsDir}`);
      }
      const files = fs.readdirSync(accountsDir)
        .filter(f => /^\d+\.json$/.test(f));
      slots = files.map(f => f.replace('.json', '')).sort((a, b) => parseInt(a) - parseInt(b));
    }

    const proResults = [];
    const freeResults = [];
    const unknownResults = [];

    // Step 3: Sequential probe loop with error isolation
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (i > 0 && pacingMs > 0) {
        await new Promise(r => setTimeout(r, pacingMs));
      }

      const slotRecord = await probeSingleSlot(slot, {
        timeoutMs: options.timeoutMs,
        accountsDir,
        command: options.command,
        args: options.args
      });

      const planUpper = (slotRecord.plan || '').trim().toUpperCase();
      if (planUpper === 'PRO') {
        proResults.push(slotRecord);
      } else if (planUpper === 'FREE') {
        freeResults.push(slotRecord);
      } else {
        unknownResults.push(slotRecord);
      }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 10) / 100;

    const payload = {
      timestampMs: Date.now(),
      updatedAtUtc: new Date().toISOString(),
      durationSeconds,
      totalProbed: slots.length,
      pools: {
        pro: proResults,
        free: freeResults,
        unknown: unknownResults
      }
    };

    // Step 4: Atomic cache persistence
    if (options.saveCache !== false) {
      try {
        saveCacheAtomic(cachePath, payload);
      } catch (cacheErr) {
        console.error('[UsageScanner] Failed to write cache:', cacheErr.message);
      }
    }

    return {
      status: 'SUCCESS',
      payload
    };
  } finally {
    // Scoped cleanup: guarantees sandboxes are purged without touching process signals
    cleanupAllActiveSandboxesSync();
    isScanRunning = false;
  }
}

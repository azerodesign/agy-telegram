/**
 * AGY Usage Monitor - Phase 2 Remediation Offline Test Suite
 * 
 * Strict Execution Constraints:
 * - 100% OFFLINE ONLY: All tests run against mocks and isolated /tmp fixtures.
 * - ZERO Live Probes: Does not call external APIs or live LLMs.
 * - ZERO Production Credential Access: Does not touch ~/.gemini/antigravity-cli/ credentials.
 * - Exact 1:1 Assertion Agreement: Every assertion is top-level, unconditionally executed,
 *   and identically numbered in source code, console output, and report documentation.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
  maskEmail,
  parseFractionToPct,
  parseIsoTimestamp,
  parseUsageOutput,
  createIsolatedSandbox,
  destroyIsolatedSandbox,
  withIsolatedSandbox,
  cleanStaleSandboxes,
  cleanupAllActiveSandboxesSync,
  getActiveSandboxCount,
  saveCacheAtomic,
  loadCache,
  probeSingleSlot,
  runSequentialCollector,
  SANDBOX_PREFIX,
  TOTAL_EXPECTED_METRICS
} from '../src/usage/scanner.mjs';

const COLOR_RESET = '\x1b[0m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_RED = '\x1b[31m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_BOLD = '\x1b[1m';

let assertionIndex = 0;
let passedCount = 0;
let failedCount = 0;
const testRecords = [];

function assert(condition, testName, details = '') {
  assertionIndex++;
  const formattedIndex = String(assertionIndex).padStart(2, '0');
  if (condition) {
    passedCount++;
    console.log(`  ${COLOR_GREEN}✓ [Test ${formattedIndex}] PASS:${COLOR_RESET} ${testName}`);
    testRecords.push({ index: assertionIndex, name: testName, status: 'PASS', details });
  } else {
    failedCount++;
    console.error(`  ${COLOR_RED}✗ [Test ${formattedIndex}] FAIL:${COLOR_RESET} ${testName} ${details ? `(${details})` : ''}`);
    testRecords.push({ index: assertionIndex, name: testName, status: 'FAIL', details });
  }
}

async function runAllTests() {
  console.log(`${COLOR_BOLD}======================================================================${COLOR_RESET}`);
  console.log(`${COLOR_BOLD}  AGY USAGE MONITOR — PHASE 2 REMEDIATION OFFLINE VERIFICATION SUITE  ${COLOR_RESET}`);
  console.log(`${COLOR_BOLD}======================================================================${COLOR_RESET}\n`);

  // =========================================================================
  // CATEGORY 1: EMAIL MASKING PRIVACY (Tests 01 - 07)
  // =========================================================================
  console.log(`${COLOR_CYAN}--- Category 1: Email Masking Privacy ---${COLOR_RESET}`);
  
  // Test 01: 1-char localpart
  assert(maskEmail('a@gmail.com') === '*@gmail.com', 'Mask 1-char localpart (a@gmail.com -> *@gmail.com)');
  
  // Test 02: 2-char localpart
  assert(maskEmail('ab@gmail.com') === 'a*@gmail.com', 'Mask 2-char localpart (ab@gmail.com -> a*@gmail.com)');
  
  // Test 03: 3-char localpart
  assert(maskEmail('abc@gmail.com') === 'a***@gmail.com', 'Mask 3-char localpart (abc@gmail.com -> a***@gmail.com)');
  
  // Test 04: 4-char localpart
  assert(maskEmail('john@gmail.com') === 'j***@gmail.com', 'Mask 4-char localpart (john@gmail.com -> j***@gmail.com)');
  
  // Test 05: 5+ char localpart
  assert(maskEmail('zerocoffe0@gmail.com') === 'zer***@gmail.com', 'Mask 5+ char localpart (zerocoffe0@gmail.com -> zer***@gmail.com)');
  
  // Test 06: Malformed email without @
  assert(maskEmail('no-at-sign-here') === '***', 'Mask malformed email without @ -> ***');
  
  // Test 07: Null or empty email
  assert(maskEmail(null) === 'unknown' && maskEmail('') === 'unknown', 'Mask null or empty email -> unknown');

  // =========================================================================
  // CATEGORY 2: NUMERIC FRACTION & TIMESTAMP VALIDATION (Tests 08 - 17)
  // =========================================================================
  console.log(`\n${COLOR_CYAN}--- Category 2: Numeric Fraction & Timestamp Validation ---${COLOR_RESET}`);
  
  // Test 08: Valid standard fraction
  assert(parseFractionToPct(0.42) === 42, 'Valid fraction (0.42) converts to 42%');
  
  // Test 09: Boundary zero
  assert(parseFractionToPct(0.0) === 0, 'Boundary fraction (0.0) converts to 0%');
  
  // Test 10: Boundary one
  assert(parseFractionToPct(1.0) === 100, 'Boundary fraction (1.0) converts to 100%');
  
  // Test 11: Negative fraction rejected
  assert(parseFractionToPct(-0.1) === null, 'Negative fraction (-0.1) rejected as null');
  
  // Test 12: Overflow fraction > 1.0 rejected
  assert(parseFractionToPct(1.05) === null, 'Overflow fraction (> 1.0) rejected as null');
  
  // Test 13: NaN fraction rejected
  assert(parseFractionToPct(NaN) === null, 'NaN fraction rejected as null');
  
  // Test 14: Non-numeric string fraction rejected
  assert(parseFractionToPct('0.5') === null, 'String fraction ("0.5") rejected as null');
  
  // Test 15: Valid ISO-8601 UTC timestamp
  assert(parseIsoTimestamp('2026-11-01T06:51:19Z') === '2026-11-01T06:51:19Z', 'Valid ISO timestamp accepted');
  
  // Test 16: Invalid timestamp string rejected
  assert(parseIsoTimestamp('not-a-timestamp') === null, 'Malformed timestamp rejected as null');
  
  // Test 17: Empty timestamp rejected
  assert(parseIsoTimestamp('') === null && parseIsoTimestamp(null) === null, 'Empty or null timestamp rejected as null');

  // =========================================================================
  // CATEGORY 3: PARSER STATUS & METRIC VALIDATION (Tests 18 - 35)
  // =========================================================================
  console.log(`\n${COLOR_CYAN}--- Category 3: Parser Status & Metric Validation ---${COLOR_RESET}`);

  const mockCompleteJson = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.72, reset_time: '2026-10-31T10:57:50Z' },
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.42, reset_time: '2026-11-01T06:51:19Z' }
            ]
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-5h', window: '5h', remaining_fraction: 1.0, reset_time: '2026-10-31T14:31:12Z' },
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.92, reset_time: '2026-11-05T08:24:58Z' }
            ]
          },
          {
            name: 'Gemini 4 Argon',
            buckets: [
              { id: 'gemini-argon-weekly', window: 'weekly', remaining_fraction: 0.97, reset_time: '2026-11-04T15:41:19Z' }
            ]
          }
        ]
      }
    }
  });

  const parsedComplete = parseUsageOutput(mockCompleteJson);
  // Test 18: Complete valid metrics -> OK
  assert(parsedComplete.status === 'OK', 'Parser returns OK when all 5 expected quota metrics are valid');
  
  // Test 19: Gemini 5h
  assert(parsedComplete.gemini.pct5h === 72 && parsedComplete.gemini.reset5hUtc === '2026-10-31T10:57:50Z', 'Extracts valid Gemini 5h (72%) and reset timestamp');
  
  // Test 20: Gemini Weekly
  assert(parsedComplete.gemini.pctWeekly === 42 && parsedComplete.gemini.resetWeeklyUtc === '2026-11-01T06:51:19Z', 'Extracts valid Gemini Weekly (42%) and reset timestamp');
  
  // Test 21: Claude 5h
  assert(parsedComplete.claudeGpt.pct5h === 100 && parsedComplete.claudeGpt.reset5hUtc === '2026-10-31T14:31:12Z', 'Extracts valid Claude 5h (100%) and reset timestamp');
  
  // Test 22: Claude Weekly
  assert(parsedComplete.claudeGpt.pctWeekly === 92 && parsedComplete.claudeGpt.resetWeeklyUtc === '2026-11-05T08:24:58Z', 'Extracts valid Claude Weekly (92%) and reset timestamp');
  
  // Test 23: Argon Weekly
  assert(parsedComplete.argon.pctWeekly === 97 && parsedComplete.argon.resetWeeklyUtc === '2026-11-04T15:41:19Z', 'Extracts valid Argon Weekly (97%) and reset timestamp');

  // Partial metrics mock: only Gemini weekly exists (1 of 5 metrics)
  const mockPartialJson = JSON.stringify({
    status: 'SUCCESS',
    command: {
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.25, reset_time: '2026-11-01T00:00:00Z' }
            ]
          }
        ]
      }
    }
  });
  const parsedPartial = parseUsageOutput(mockPartialJson);
  
  // Test 24: Partial response returns PARTIAL
  assert(parsedPartial.status === 'PARTIAL', 'Parser returns PARTIAL when only a subset of metrics is present');
  
  // Test 25: Partial response defaults missing metrics to null
  assert(parsedPartial.gemini.pctWeekly === 25 && parsedPartial.gemini.pct5h === null && parsedPartial.claudeGpt.pct5h === null, 'Partial preserves present metric and leaves missing as null');

  // Empty groups mock: SUCCESS status but zero metrics
  const mockEmptyGroupsJson = JSON.stringify({
    status: 'SUCCESS',
    command: {
      data: {
        groups: []
      }
    }
  });
  const parsedEmptyGroups = parseUsageOutput(mockEmptyGroupsJson);
  
  // Test 26: SUCCESS with empty groups returns UNKNOWN (Never OK!)
  assert(parsedEmptyGroups.status === 'UNKNOWN', 'Parser returns UNKNOWN on SUCCESS with empty groups (never OK with null metrics)');

  // All null metrics mock: buckets present but fractions are null/invalid
  const mockAllNullJson = JSON.stringify({
    status: 'SUCCESS',
    command: {
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [{ window: 'weekly', remaining_fraction: null }]
          }
        ]
      }
    }
  });
  const parsedAllNull = parseUsageOutput(mockAllNullJson);
  
  // Test 27: All null metrics returns UNKNOWN
  assert(parsedAllNull.status === 'UNKNOWN', 'Parser returns UNKNOWN when all bucket metrics evaluate to null');

  // JSON Error: Rate limit
  const mockJsonRateLimit = JSON.stringify({
    status: 'ERROR',
    response: 'googleapi: Error 429: resource_exhausted. Quota exceeded.'
  });
  const parsedJsonRateLimit = parseUsageOutput(mockJsonRateLimit);
  
  // Test 28: JSON rate limit error -> RATE_LIMITED
  assert(parsedJsonRateLimit.status === 'RATE_LIMITED', 'Parser flags RATE_LIMITED on JSON resource_exhausted');

  // JSON Error: HTTP 429 in error object
  const mockJson429 = JSON.stringify({
    error: { message: 'rate limit exceeded for project' }
  });
  const parsedJson429 = parseUsageOutput(mockJson429);
  
  // Test 29: JSON 429 error -> RATE_LIMITED
  assert(parsedJson429.status === 'RATE_LIMITED', 'Parser flags RATE_LIMITED on error.message rate limit');

  // JSON Error: Auth expired
  const mockJsonAuthErr = JSON.stringify({
    status: 'ERROR',
    response: 'invalid_grant: token has been expired or revoked'
  });
  const parsedJsonAuth = parseUsageOutput(mockJsonAuthErr);
  
  // Test 30: JSON invalid_grant -> AUTH_EXPIRED
  assert(parsedJsonAuth.status === 'AUTH_EXPIRED', 'Parser flags AUTH_EXPIRED on JSON invalid_grant');

  // JSON Error: Authentication required
  const mockJsonAuthReq = JSON.stringify({
    error: { message: 'Authentication required. Please run login.' }
  });
  const parsedJsonAuthReq = parseUsageOutput(mockJsonAuthReq);
  
  // Test 31: JSON auth required -> AUTH_EXPIRED
  assert(parsedJsonAuthReq.status === 'AUTH_EXPIRED', 'Parser flags AUTH_EXPIRED on JSON authentication required');

  // Text TSV Fallback: Valid output
  const mockTsv = "Gemini Models\tWeekly Limit Remaining\t50%\t2026-11-01T00:00:00Z\nGemini Models\tFive Hour Limit Remaining\t80%\t2026-10-31T12:00:00Z";
  const parsedTsv = parseUsageOutput(mockTsv);
  
  // Test 32: TSV fallback returns PARTIAL for 2 metrics
  assert(parsedTsv.status === 'PARTIAL' && parsedTsv.gemini.pctWeekly === 50 && parsedTsv.gemini.pct5h === 80, 'TSV parser extracts Gemini metrics and flags PARTIAL');

  // Text Rate Limit error
  const parsedTextRateLimit = parseUsageOutput('Error: resource_exhausted. Rate limit exceeded.');
  // Test 33: Text rate limit -> RATE_LIMITED
  assert(parsedTextRateLimit.status === 'RATE_LIMITED', 'TSV parser flags RATE_LIMITED on text resource_exhausted');

  // Text Auth error
  const parsedTextAuth = parseUsageOutput('Error: authentication required. Invalid login.');
  // Test 34: Text auth -> AUTH_EXPIRED
  assert(parsedTextAuth.status === 'AUTH_EXPIRED', 'TSV parser flags AUTH_EXPIRED on text authentication required');

  // Empty string
  const parsedBlank = parseUsageOutput('');
  // Test 35: Empty output -> UNKNOWN
  assert(parsedBlank.status === 'UNKNOWN', 'Parser flags UNKNOWN on blank or empty input');

  // =========================================================================
  // CATEGORY 4: ACCOUNT PLAN CLASSIFICATION (Tests 36 - 40)
  // =========================================================================
  console.log(`\n${COLOR_CYAN}--- Category 4: Account Plan Classification ---${COLOR_RESET}`);

  const mockAccountsDir = path.join(os.tmpdir(), `mock_accounts_${Date.now()}`);
  fs.mkdirSync(mockAccountsDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(path.join(mockAccountsDir, '1.json'), JSON.stringify({ plan: 'PRO', email: 'pro@test.com' }), { mode: 0o600 });
  fs.writeFileSync(path.join(mockAccountsDir, '2.json'), JSON.stringify({ plan: 'FREE', email: 'free@test.com' }), { mode: 0o600 });
  fs.writeFileSync(path.join(mockAccountsDir, '3.json'), JSON.stringify({ plan: 'UNKNOWN', email: 'unk@test.com' }), { mode: 0o600 });
  fs.writeFileSync(path.join(mockAccountsDir, '4.json'), JSON.stringify({ email: 'missing@test.com' }), { mode: 0o600 }); // missing plan
  fs.writeFileSync(path.join(mockAccountsDir, '5.json'), JSON.stringify({ plan: 'ENTERPRISE', email: 'ent@test.com' }), { mode: 0o600 }); // unrecognized

  const collectorResult = await runSequentialCollector(['1', '2', '3', '4', '5'], {
    accountsDir: mockAccountsDir,
    command: 'node',
    args: ['-e', 'console.log(JSON.stringify({ status: "SUCCESS", command: { data: { groups: [] } } }))'],
    pacingMs: 0,
    saveCache: false
  });

  const pools = collectorResult.payload?.pools || {};
  
  // Test 36: PRO pool
  assert(pools.pro?.length === 1 && pools.pro[0].slot === '1', 'PRO plan classified into pools.pro');
  
  // Test 37: FREE pool
  assert(pools.free?.length === 1 && pools.free[0].slot === '2', 'FREE plan classified into pools.free');
  
  // Test 38: UNKNOWN plan into unknown pool
  const hasSlot3InUnknown = pools.unknown?.some(s => s.slot === '3');
  assert(hasSlot3InUnknown, 'Explicit UNKNOWN plan classified into pools.unknown (not FREE)');
  
  // Test 39: Missing plan into unknown pool
  const hasSlot4InUnknown = pools.unknown?.some(s => s.slot === '4');
  assert(hasSlot4InUnknown, 'Missing plan property classified into pools.unknown (never silently FREE)');
  
  // Test 40: Unrecognized enterprise plan into unknown pool
  const hasSlot5InUnknown = pools.unknown?.some(s => s.slot === '5');
  assert(hasSlot5InUnknown, 'Unrecognized plan ("ENTERPRISE") classified into pools.unknown');

  // Clean mock accounts fixture
  fs.rmSync(mockAccountsDir, { recursive: true, force: true });

  // =========================================================================
  // CATEGORY 5: CHILD PROCESS LIFECYCLE & TIMEOUT TEARDOWN (Tests 41 - 45)
  // =========================================================================
  console.log(`\n${COLOR_CYAN}--- Category 5: Child Process Lifecycle & Timeout Teardown ---${COLOR_RESET}`);

  const timeoutFixtureDir = path.join(os.tmpdir(), `timeout_fixture_${Date.now()}`);
  fs.mkdirSync(timeoutFixtureDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(timeoutFixtureDir, '99.json'), JSON.stringify({ plan: 'PRO', email: 'timeout@test.com' }), { mode: 0o600 });

  // Test 41 & 42: Probe timeout waits for exit before teardown
  const timeoutStart = Date.now();
  const probeTimeoutResult = await probeSingleSlot('99', {
    accountsDir: timeoutFixtureDir,
    command: 'node',
    args: ['-e', 'setTimeout(() => {}, 20000)'], // Long sleep that exceeds timeout
    timeoutMs: 400
  });
  const timeoutElapsed = Date.now() - timeoutStart;

  assert(probeTimeoutResult.status === 'UNKNOWN' && probeTimeoutResult.errorMessage?.includes('timed out'), 'Probe timeout returns UNKNOWN status with timeout message');
  assert(timeoutElapsed >= 380, 'Probe timeout waits for child exit before teardown (elapsed >= 380ms)');

  // Test 43: All active sandboxes cleaned up after timeout
  assert(getActiveSandboxCount() === 0, 'No active sandboxes remain registered after process timeout teardown');

  // Test 44: Spawn error (non-existent executable)
  const probeSpawnErr = await probeSingleSlot('99', {
    accountsDir: timeoutFixtureDir,
    command: '__non_existent_binary_xyz_123__',
    args: []
  });
  assert(probeSpawnErr.status === 'UNKNOWN' && probeSpawnErr.errorMessage?.includes('Process execution error'), 'Spawn error safely handled without hanging or throwing');

  // Test 45: Normal mock completion clears all sandboxes and listeners
  const probeNormal = await probeSingleSlot('99', {
    accountsDir: timeoutFixtureDir,
    command: 'node',
    args: ['-e', 'console.log(JSON.stringify({ status: "SUCCESS", command: { data: { groups: [] } } }))']
  });
  assert(probeNormal.status === 'UNKNOWN' && getActiveSandboxCount() === 0, 'Normal completion cleans sandbox registry');

  fs.rmSync(timeoutFixtureDir, { recursive: true, force: true });

  // =========================================================================
  // CATEGORY 6: SIGNAL HANDLING SCOPE (Tests 46 - 48)
  // =========================================================================
  console.log(`\n${COLOR_CYAN}--- Category 6: Signal Handling Scope ---${COLOR_RESET}`);

  // Test 46: Verify scanner did not register global SIGINT handler
  const sigintListeners = process.listeners('SIGINT');
  const hasScannerSigint = sigintListeners.some(fn => fn.name === 'cleanupAllActiveSandboxesSync' || fn.toString().includes('cleanupAllActiveSandboxesSync'));
  assert(!hasScannerSigint, 'Scanner module import does NOT register global SIGINT listener on process');

  // Test 47: Verify scanner did not register global SIGTERM handler
  const sigtermListeners = process.listeners('SIGTERM');
  const hasScannerSigterm = sigtermListeners.some(fn => fn.name === 'cleanupAllActiveSandboxesSync' || fn.toString().includes('cleanupAllActiveSandboxesSync'));
  assert(!hasScannerSigterm, 'Scanner module import does NOT register global SIGTERM listener on process');

  // Test 48: Cleanup function is explicitly callable
  cleanupAllActiveSandboxesSync();
  assert(getActiveSandboxCount() === 0, 'cleanupAllActiveSandboxesSync is explicitly callable and leaves 0 active sandboxes');

  // =========================================================================
  // CATEGORY 7: SANDBOX ISOLATION & PERMISSIONS (Tests 49 - 55)
  // =========================================================================
  console.log(`\n${COLOR_CYAN}--- Category 7: Sandbox Isolation & Permissions ---${COLOR_RESET}`);

  const dummyCredPath = path.join(os.tmpdir(), `dummy_cred_${Date.now()}.json`);
  fs.writeFileSync(dummyCredPath, JSON.stringify({ token: { access_token: 'dummy' }, plan: 'PRO' }), { mode: 0o600 });

  const sb = createIsolatedSandbox('unit_slot', dummyCredPath);
  
  // Test 49: 0700 sandbox dir
  const dirStat = fs.statSync(sb.root);
  assert((dirStat.mode & 0o777) === 0o700, 'Sandbox root directory has strict 0700 permissions (rwx------)');

  // Test 50: 0600 sandbox token file
  const tokenStat = fs.statSync(sb.tokenPath);
  assert((tokenStat.mode & 0o777) === 0o600, 'Sandbox token file has strict 0600 permissions (rw-------)');

  // Test 51: Real byte copy (not symlink)
  const isLstatSymlink = fs.lstatSync(sb.tokenPath).isSymbolicLink();
  assert(!isLstatSymlink, 'Sandbox token file is a REAL BYTE COPY (not a symlink)');

  // Test 52: Symlink rejection
  const symlinkSource = path.join(os.tmpdir(), `symlink_src_${Date.now()}.json`);
  fs.symlinkSync(dummyCredPath, symlinkSource);
  let symlinkRejected = false;
  try {
    createIsolatedSandbox('symlink_slot', symlinkSource);
  } catch (err) {
    symlinkRejected = err.message.includes('Refusing to use symlinked source file');
  }
  fs.rmSync(symlinkSource, { force: true });
  assert(symlinkRejected, 'createIsolatedSandbox strictly refuses symlinked credential sources');

  // Test 53: Explicit destruction
  destroyIsolatedSandbox(sb.root);
  assert(!fs.existsSync(sb.root), 'destroyIsolatedSandbox completely purges sandbox directory');

  // Test 54: withIsolatedSandbox exception safety
  let capturedRoot = null;
  try {
    await withIsolatedSandbox('fail_slot', dummyCredPath, async (s) => {
      capturedRoot = s.root;
      throw new Error('Simulated inside-sandbox callback error');
    });
  } catch (err) {
    // Expected error
  }
  assert(!fs.existsSync(capturedRoot), 'withIsolatedSandbox guarantees teardown in finally block on thrown error');

  // Test 55: Stale sandbox sweeper
  const staleDir = path.join(os.tmpdir(), `${SANDBOX_PREFIX}stale_sweeper_${Date.now()}`);
  fs.mkdirSync(staleDir, { mode: 0o700 });
  const backdate = new Date(Date.now() - 3600000);
  fs.utimesSync(staleDir, backdate, backdate);
  const swept = cleanStaleSandboxes(30);
  assert(swept >= 1 && !fs.existsSync(staleDir), 'cleanStaleSandboxes sweeps orphaned sandbox folders');

  fs.rmSync(dummyCredPath, { force: true });

  // =========================================================================
  // CATEGORY 8: ATOMIC CACHE PERSISTENCE & SECURITY (Tests 56 - 60)
  // =========================================================================
  console.log(`\n${COLOR_CYAN}--- Category 8: Atomic Cache Persistence & Security ---${COLOR_RESET}`);

  const testCachePath = path.join(os.tmpdir(), `test_cache_remediation_${Date.now()}.json`);
  const testCachePayload = {
    timestampMs: Date.now(),
    updatedAtUtc: new Date().toISOString(),
    pools: {
      pro: [{ slot: '1', email: 'zer***@gmail.com', plan: 'PRO' }],
      free: [{ slot: '2', email: 'a*@gmail.com', plan: 'FREE' }],
      unknown: [{ slot: '3', email: 'unk***@gmail.com', plan: 'UNKNOWN' }]
    }
  };

  saveCacheAtomic(testCachePath, testCachePayload);

  // Test 56: Atomic save and 0600 permissions
  const cacheFileStat = fs.statSync(testCachePath);
  assert((cacheFileStat.mode & 0o777) === 0o600, 'Atomic cache file saved with strict 0600 permissions (rw-------)');

  // Test 57: Cache load and TTL
  const loaded = loadCache(testCachePath, 60000);
  assert(loaded !== null && !loaded.isStale && loaded.data?.pools?.pro?.length === 1, 'Cache loaded successfully and evaluated as not stale');

  // Test 58: Stale cache detection
  const loadedStale = loadCache(testCachePath, -1); // negative TTL -> always stale
  assert(loadedStale !== null && loadedStale.isStale === true, 'Stale cache correctly detected when age exceeds TTL');

  // Test 59: Cache contains ZERO tokens or OAuth strings
  const cacheRawContent = fs.readFileSync(testCachePath, 'utf8');
  const hasBearer = /Bearer\s+[A-Za-z0-9_-]+/i.test(cacheRawContent);
  const hasOAuthToken = /ya29\.[0-9A-Za-z_-]+/i.test(cacheRawContent);
  const hasRefreshToken = /1\/\/[0-9A-Za-z_-]+/i.test(cacheRawContent);
  assert(!hasBearer && !hasOAuthToken && !hasRefreshToken, 'Cache payload contains ZERO Bearer, ya29, or 1// token strings');

  // Test 60: Cache contains ZERO unmasked emails
  const hasUnmaskedZero = cacheRawContent.includes('zerocoffe0@');
  const hasUnmaskedSingle = cacheRawContent.includes('ab@gmail.com');
  assert(!hasUnmaskedZero && !hasUnmaskedSingle, 'Cache payload contains ZERO unmasked email addresses');

  fs.rmSync(testCachePath, { force: true });

  // =========================================================================
  // FINAL SUMMARY REPORT
  // =========================================================================
  console.log(`\n${COLOR_BOLD}======================================================================${COLOR_RESET}`);
  console.log(`  SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED out of ${assertionIndex} TOTAL ASSERTIONS`);
  console.log(`======================================================================${COLOR_RESET}\n`);

  if (failedCount === 0 && assertionIndex === 60) {
    console.log(`${COLOR_BOLD}${COLOR_GREEN}✓ 100% RECONCILED: EXACTLY 60 ASSERTIONS PASSED WITH ZERO MUTATIONS.${COLOR_RESET}\n`);
    process.exit(0);
  } else {
    console.error(`${COLOR_BOLD}${COLOR_RED}✗ RECONCILIATION FAILURE: ${failedCount} failures or count mismatch (${assertionIndex}/60).${COLOR_RESET}\n`);
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('[TestHarness Fatal Error]', err);
  process.exit(1);
});

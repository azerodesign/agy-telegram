/**
 * Live 14-Account Sequential Usage Scan & Zero-Mutation Verification
 * 
 * Safety Guarantees:
 * - 100% Isolated Sandboxing per slot in /tmp/ (Byte-copy, mode 0700/0600, no symlinks).
 * - Pre- and Post-scan bit-for-bit SHA-256 and nanosecond mtime checks on all 17 production files.
 * - Zero write-back to production tokens or round-robin state.
 * - Service PID stability verification.
 * - Complete secret redaction.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

import {
  runSequentialCollector,
  DEFAULT_CACHE_PATH,
  PROD_ACCOUNTS_DIR,
  PROD_ACTIVE_TOKEN,
  PROD_STATE_FILE,
  SANDBOX_PREFIX
} from '../src/usage/scanner.mjs';

function getFileIntegrity(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, sha256: null, size: 0, mtimeNs: 0n };
  }
  const stat = fs.statSync(filePath, { bigint: true });
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return {
    exists: true,
    sha256: hash,
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs
  };
}

function captureProductionBaseline() {
  const snapshot = {
    accounts: {},
    activeToken: getFileIntegrity(PROD_ACTIVE_TOKEN),
    stateFile: getFileIntegrity(PROD_STATE_FILE),
    backupPrevious: null,
    servicePid: null
  };

  if (fs.existsSync(PROD_ACCOUNTS_DIR)) {
    for (let i = 1; i <= 14; i++) {
      const fileName = `${i}.json`;
      const filePath = path.join(PROD_ACCOUNTS_DIR, fileName);
      snapshot.accounts[fileName] = getFileIntegrity(filePath);
    }
    const backupFile = path.join(PROD_ACCOUNTS_DIR, 'backup_previous.json');
    if (fs.existsSync(backupFile)) {
      snapshot.backupPrevious = getFileIntegrity(backupFile);
    }
  }

  try {
    const pidStr = execSync('systemctl show agy-telegram --property=MainPID', { encoding: 'utf8' }).trim();
    snapshot.servicePid = pidStr.split('=')[1] || null;
  } catch (_) {
    snapshot.servicePid = null;
  }

  return snapshot;
}

async function main() {
  console.log('======================================================================');
  console.log('  AGY USAGE MONITOR — 14-ACCOUNT LIVE SEQUENTIAL SCAN                ');
  console.log('======================================================================\n');

  // Step 1: Pre-Scan Production Integrity Baseline
  console.log('>>> [1/4] Capturing Pre-Scan Production Baseline...');
  const preBaseline = captureProductionBaseline();
  console.log(`  - Production Accounts Monitored: ${Object.keys(preBaseline.accounts).length} files (1.json to 14.json)`);
  console.log(`  - Active Token SHA-256: ${preBaseline.activeToken.sha256?.slice(0, 16)}...`);
  console.log(`  - State File SHA-256:   ${preBaseline.stateFile.sha256?.slice(0, 16)}...`);
  console.log(`  - Backup File SHA-256:  ${preBaseline.backupPrevious?.sha256?.slice(0, 16)}...`);
  console.log(`  - agy-telegram Service PID: ${preBaseline.servicePid}\n`);

  // Step 2: Execute Live Sequential Collector
  console.log('>>> [2/4] Executing Sequential Scan on All 14 Accounts...');
  console.log('  - Sandboxing: Byte-copy to /tmp/ with mode 0700/0600');
  console.log('  - Inter-slot pacing: 400ms');
  console.log('  - Per-slot timeout: 15,000ms');
  console.log('  - Starting sequential probe loop...\n');

  const scanStart = Date.now();
  const scanResult = await runSequentialCollector(null, {
    pacingMs: 400,
    timeoutMs: 15000,
    saveCache: true
  });
  const totalDuration = ((Date.now() - scanStart) / 1000).toFixed(2);

  console.log(`\n>>> [2/4 Complete] Scan completed in ${totalDuration}s with status: ${scanResult.status}\n`);

  // Step 3: Post-Scan Production Integrity Comparison
  console.log('>>> [3/4] Verifying Post-Scan Production Integrity (Zero Mutation Proof)...');
  const postBaseline = captureProductionBaseline();

  let hasMutation = false;
  const comparisonResults = [];

  // 1. Check active token
  const tokenMatch = preBaseline.activeToken.sha256 === postBaseline.activeToken.sha256 &&
                     preBaseline.activeToken.mtimeNs === postBaseline.activeToken.mtimeNs;
  if (!tokenMatch) hasMutation = true;
  comparisonResults.push({ file: 'antigravity-oauth-token', unchanged: tokenMatch });

  // 2. Check state file
  const stateMatch = preBaseline.stateFile.sha256 === postBaseline.stateFile.sha256 &&
                     preBaseline.stateFile.mtimeNs === postBaseline.stateFile.mtimeNs;
  if (!stateMatch) hasMutation = true;
  comparisonResults.push({ file: 'round_robin_state.json', unchanged: stateMatch });

  // 3. Check backup previous
  if (preBaseline.backupPrevious && postBaseline.backupPrevious) {
    const backupMatch = preBaseline.backupPrevious.sha256 === postBaseline.backupPrevious.sha256 &&
                        preBaseline.backupPrevious.mtimeNs === postBaseline.backupPrevious.mtimeNs;
    if (!backupMatch) hasMutation = true;
    comparisonResults.push({ file: 'backup_previous.json', unchanged: backupMatch });
  }

  // 4. Check all 14 accounts
  for (let i = 1; i <= 14; i++) {
    const fn = `${i}.json`;
    const a = preBaseline.accounts[fn];
    const b = postBaseline.accounts[fn];
    const match = a.exists && b.exists && a.sha256 === b.sha256 && a.mtimeNs === b.mtimeNs;
    if (!match) hasMutation = true;
    comparisonResults.push({ file: `accounts/${fn}`, unchanged: match });
  }

  // 5. Check service PID
  const pidMatch = preBaseline.servicePid === postBaseline.servicePid && postBaseline.servicePid !== null;
  if (!pidMatch) hasMutation = true;

  console.log(`  - Total Production Files Checked: ${comparisonResults.length}`);
  console.log(`  - Unchanged Files: ${comparisonResults.filter(c => c.unchanged).length} / ${comparisonResults.length}`);
  console.log(`  - Service PID: ${postBaseline.servicePid} (${pidMatch ? 'STABLE' : 'CHANGED'})`);
  console.log(`  - Overall Production Mutation: ${hasMutation ? 'FAILED (MUTATION DETECTED!)' : 'ZERO MUTATION (100% UNCHANGED)'}\n`);

  if (hasMutation) {
    console.error('CRITICAL ERROR: Production files were modified during scan!');
    process.exit(1);
  }

  // Step 4: Sandbox & Cache Hygiene
  console.log('>>> [4/4] Verifying Sandbox & Cache Hygiene...');
  const lingeringSandboxes = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(SANDBOX_PREFIX));
  console.log(`  - Lingering Sandboxes in /tmp/: ${lingeringSandboxes.length} (Expected: 0)`);

  const cacheExists = fs.existsSync(DEFAULT_CACHE_PATH);
  const cacheStat = cacheExists ? fs.statSync(DEFAULT_CACHE_PATH) : null;
  const cacheMode = cacheStat ? (cacheStat.mode & 0o777).toString(8) : 'none';
  console.log(`  - Cache File Path: ${DEFAULT_CACHE_PATH}`);
  console.log(`  - Cache Permissions: ${cacheMode} (Expected: 600)`);

  let secretLeaked = false;
  if (cacheExists) {
    const cacheRaw = fs.readFileSync(DEFAULT_CACHE_PATH, 'utf8');
    const hasBearer = /Bearer\s+[A-Za-z0-9_-]+/i.test(cacheRaw);
    const hasOAuth = /ya29\.[0-9A-Za-z_-]+/i.test(cacheRaw);
    const hasRefresh = /1\/\/[0-9A-Za-z_-]+/i.test(cacheRaw);
    secretLeaked = hasBearer || hasOAuth || hasRefresh;
    console.log(`  - Secret Token Leakage in Cache: ${secretLeaked ? 'DETECTED!' : 'ZERO (CLEAN)'}`);
  }

  // Step 5: Format and Display Results Table
  console.log('\n======================================================================');
  console.log('  SCAN RESULTS — 14 ACCOUNTS BREAKDOWN                                ');
  console.log('======================================================================\n');

  const payload = scanResult.payload;
  const pools = payload.pools;

  console.log(`--- PRO POOL (${pools.pro.length} Accounts) ---`);
  for (const acc of pools.pro) {
    console.log(`Slot ${acc.slot.padStart(2)} [${acc.plan}] ${acc.email.padEnd(20)} | Status: ${acc.status.padEnd(8)}`);
    if (acc.status === 'OK' || acc.status === 'PARTIAL') {
      const g5h = acc.gemini.pct5h !== null ? `${acc.gemini.pct5h}%` : 'N/A';
      const gWk = acc.gemini.pctWeekly !== null ? `${acc.gemini.pctWeekly}%` : 'N/A';
      const c5h = acc.claudeGpt.pct5h !== null ? `${acc.claudeGpt.pct5h}%` : 'N/A';
      const cWk = acc.claudeGpt.pctWeekly !== null ? `${acc.claudeGpt.pctWeekly}%` : 'N/A';
      const arg = acc.argon.pctWeekly !== null ? `${acc.argon.pctWeekly}%` : 'N/A';
      console.log(`   Gemini: 5h=${g5h} (reset: ${acc.gemini.reset5hUtc || '-'}), Wk=${gWk} (reset: ${acc.gemini.resetWeeklyUtc || '-'})`);
      console.log(`   Claude: 5h=${c5h} (reset: ${acc.claudeGpt.reset5hUtc || '-'}), Wk=${cWk} (reset: ${acc.claudeGpt.resetWeeklyUtc || '-'})`);
      console.log(`   Argon:  Wk=${arg} (reset: ${acc.argon.resetWeeklyUtc || '-'})`);
    } else {
      console.log(`   Error: ${acc.errorMessage || 'No quota returned'}`);
    }
  }

  console.log(`\n--- FREE POOL (${pools.free.length} Accounts) ---`);
  for (const acc of pools.free) {
    console.log(`Slot ${acc.slot.padStart(2)} [${acc.plan}] ${acc.email.padEnd(20)} | Status: ${acc.status.padEnd(8)}`);
    if (acc.status === 'OK' || acc.status === 'PARTIAL') {
      const g5h = acc.gemini.pct5h !== null ? `${acc.gemini.pct5h}%` : 'N/A';
      const gWk = acc.gemini.pctWeekly !== null ? `${acc.gemini.pctWeekly}%` : 'N/A';
      const c5h = acc.claudeGpt.pct5h !== null ? `${acc.claudeGpt.pct5h}%` : 'N/A';
      const cWk = acc.claudeGpt.pctWeekly !== null ? `${acc.claudeGpt.pctWeekly}%` : 'N/A';
      const arg = acc.argon.pctWeekly !== null ? `${acc.argon.pctWeekly}%` : 'N/A';
      console.log(`   Gemini: 5h=${g5h} (reset: ${acc.gemini.reset5hUtc || '-'}), Wk=${gWk} (reset: ${acc.gemini.resetWeeklyUtc || '-'})`);
      console.log(`   Claude: 5h=${c5h} (reset: ${acc.claudeGpt.reset5hUtc || '-'}), Wk=${cWk} (reset: ${acc.claudeGpt.resetWeeklyUtc || '-'})`);
      console.log(`   Argon:  Wk=${arg} (reset: ${acc.argon.resetWeeklyUtc || '-'})`);
    } else {
      console.log(`   Error: ${acc.errorMessage || 'No quota returned'}`);
    }
  }

  if (pools.unknown && pools.unknown.length > 0) {
    console.log(`\n--- UNKNOWN POOL (${pools.unknown.length} Accounts) ---`);
    for (const acc of pools.unknown) {
      console.log(`Slot ${acc.slot.padStart(2)} [${acc.plan}] ${acc.email.padEnd(20)} | Status: ${acc.status}`);
    }
  }

  console.log('\n======================================================================');
  console.log(`  SCAN COMPLETE: Total Probed: ${payload.totalProbed} accounts | Duration: ${payload.durationSeconds}s`);
  console.log('======================================================================\n');
}

main().catch(err => {
  console.error('[RunFullScan Fatal Error]', err);
  process.exit(1);
});

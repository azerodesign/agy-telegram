/**
 * AGY Usage - Multi-Account JSON Validator & Importer
 * 
 * Supports validating and importing bulk Antigravity account JSON files:
 * 1. Parses raw JSON (array of { email, refresh_token }, slot objects, or keyed dictionaries)
 * 2. Probes account validity in isolated sandboxes using agy --output-format json -p /usage
 * 3. Identifies plan tiers (PRO vs FREE) and live quota metrics
 * 4. Safely imports valid accounts to ~/.gemini/antigravity-cli/accounts/<slot>.json
 *    with automatic backup of previous accounts.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  withIsolatedSandbox,
  parseUsageOutput,
  maskEmail,
  PROD_ACCOUNTS_DIR
} from './scanner.mjs';

const AGY_PATH = process.env.AGY_PATH || '/home/ubuntu/.local/bin/agy';
const KNOWN_PRO_SLOTS = [1, 5, 6, 7, 9, 10, 12];

/**
 * Escapes characters for Telegram HTML.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normalizes input JSON into a structured array of account candidates.
 */
export function parseAccountsJson(rawContentOrObject) {
  let data = rawContentOrObject;
  if (typeof rawContentOrObject === 'string') {
    try {
      data = JSON.parse(rawContentOrObject);
    } catch (err) {
      throw new Error(`Gagal membaca format JSON: ${err.message}`);
    }
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Data JSON kosong atau bukan objek/array yang valid.');
  }

  const rawList = [];
  if (Array.isArray(data)) {
    rawList.push(...data);
  } else {
    // Keyed object e.g. { "1": { ... }, "2": { ... } } or { accounts: [ ... ] }
    if (Array.isArray(data.accounts)) {
      rawList.push(...data.accounts);
    } else {
      const keys = Object.keys(data).sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      });
      for (const k of keys) {
        if (typeof data[k] === 'object' && data[k] !== null) {
          rawList.push({ slot: k, ...data[k] });
        }
      }
    }
  }

  if (rawList.length === 0) {
    throw new Error('Tidak ditemukan data akun dalam file JSON.');
  }

  const normalized = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') continue;

    const email = item.email || item.id_token_email || item.token?.id_token_email || 'unknown';
    const refreshToken = item.refresh_token || item.token?.refresh_token;

    if (!refreshToken) {
      throw new Error(`Akun #${i + 1} (${email}) tidak memiliki refresh_token valid.`);
    }

    const slotNum = item.slot ? parseInt(String(item.slot), 10) : (i + 1);
    const plan = (item.plan || (KNOWN_PRO_SLOTS.includes(slotNum) ? 'PRO' : 'FREE')).toUpperCase();

    normalized.push({
      index: i,
      slot: String(slotNum),
      email: String(email).trim(),
      refreshToken: String(refreshToken).trim(),
      plan,
      raw: item
    });
  }

  return normalized;
}

/**
 * Validates a single account in an isolated sandbox.
 */
export async function validateSingleAccount(accountItem, options = {}) {
  const timeoutMs = options.timeoutMs || 25000;
  const spawnCommand = options.command || AGY_PATH;
  const spawnArgs = options.args || ['--output-format', 'json', '-p', '/usage'];

  const tmpFile = path.join(
    os.tmpdir(),
    `probe_val_${accountItem.slot}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.json`
  );

  const initialTokenPayload = {
    token: {
      refresh_token: accountItem.refreshToken,
      token_type: 'Bearer'
    },
    auth_method: 'consumer',
    id_token_email: accountItem.email,
    plan: accountItem.plan || 'FREE'
  };

  fs.writeFileSync(tmpFile, JSON.stringify(initialTokenPayload, null, 2), { mode: 0o600 });

  const result = {
    index: accountItem.index,
    slot: accountItem.slot,
    email: accountItem.email,
    maskedEmail: maskEmail(accountItem.email),
    valid: false,
    status: 'UNKNOWN',
    plan: accountItem.plan || 'FREE',
    usage: null,
    refreshedToken: null,
    errorMessage: null,
    durationMs: 0
  };

  const startTime = Date.now();

  try {
    await withIsolatedSandbox(`val_${accountItem.slot}`, tmpFile, async (sandbox) => {
      let rawOutput = '';
      let exitCode = 0;

      if (typeof options.probeFn === 'function') {
        const probeRes = await options.probeFn(sandbox, accountItem);
        rawOutput = probeRes.output || '';
        exitCode = probeRes.code ?? 0;
      } else {
        const probeRes = await new Promise((resolve) => {
          let stdout = '';
          let stderr = '';
          let isTimedOut = false;

          const child = spawn(spawnCommand, spawnArgs, {
            env: {
              ...process.env,
              HOME: sandbox.root
            },
            stdio: ['ignore', 'pipe', 'pipe']
          });

          const timer = setTimeout(() => {
            isTimedOut = true;
            try { child.kill('SIGKILL'); } catch (_) {}
            resolve({ code: 124, out: stderr || 'Probe timed out after ' + timeoutMs + 'ms' });
          }, timeoutMs);

          child.stdout.on('data', d => { stdout += d.toString(); });
          child.stderr.on('data', d => { stderr += d.toString(); });

          child.on('close', code => {
            clearTimeout(timer);
            if (!isTimedOut) {
              resolve({ code: code ?? 0, out: stdout || stderr });
            }
          });

          child.on('error', err => {
            clearTimeout(timer);
            resolve({ code: 1, out: err.message });
          });
        });

        rawOutput = probeRes.out;
        exitCode = probeRes.code;
      }

      result.durationMs = Date.now() - startTime;

      // Parse usage output from agy
      const parsedUsage = parseUsageOutput(rawOutput);
      result.usage = {
        gemini: parsedUsage.gemini,
        claudeGpt: parsedUsage.claudeGpt,
        argon: parsedUsage.argon
      };

      if (parsedUsage.status === 'OK' || parsedUsage.status === 'PARTIAL') {
        result.valid = true;
        result.status = 'VALID';

        // Auto-detect PRO tier if Claude / Argon limits exist
        const hasProLimits =
          parsedUsage.claudeGpt.pct5h !== null ||
          parsedUsage.claudeGpt.pctWeekly !== null ||
          parsedUsage.argon.pctWeekly !== null;

        if (hasProLimits || KNOWN_PRO_SLOTS.includes(parseInt(accountItem.slot, 10))) {
          result.plan = 'PRO';
        } else {
          result.plan = 'FREE';
        }

        // Capture refreshed token from sandbox token file
        if (fs.existsSync(sandbox.tokenPath)) {
          try {
            const rawToken = fs.readFileSync(sandbox.tokenPath, 'utf8');
            result.refreshedToken = JSON.parse(rawToken);
            if (result.refreshedToken.id_token_email) {
              result.email = result.refreshedToken.id_token_email;
              result.maskedEmail = maskEmail(result.email);
            }
          } catch (_) {}
        }
      } else if (parsedUsage.status === 'AUTH_EXPIRED') {
        result.valid = false;
        result.status = 'EXPIRED';
        result.errorMessage = parsedUsage.errorMessage || 'Autentikasi kedaluwarsa atau ditolak';
      } else {
        result.valid = false;
        result.status = 'ERROR';
        result.errorMessage = parsedUsage.errorMessage || (exitCode !== 0 ? `Exit code ${exitCode}` : 'Gagal membaca kuota');
      }
    });
  } catch (err) {
    result.durationMs = Date.now() - startTime;
    result.valid = false;
    result.status = 'ERROR';
    result.errorMessage = err.message;
  } finally {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
  }

  return result;
}

/**
 * Validates a list of accounts sequentially with optional progress callback.
 */
export async function validateAccountsBatch(accountsList, options = {}) {
  const results = [];
  const total = accountsList.length;

  for (let i = 0; i < total; i++) {
    const acc = accountsList[i];
    if (typeof options.onProgress === 'function') {
      try {
        await options.onProgress(i, total, acc);
      } catch (_) {}
    }

    const res = await validateSingleAccount(acc, options);
    results.push(res);
  }

  const validCount = results.filter(r => r.valid).length;
  const expiredCount = results.filter(r => r.status === 'EXPIRED').length;
  const errorCount = results.filter(r => r.status === 'ERROR' || r.status === 'UNKNOWN').length;
  const proCount = results.filter(r => r.valid && r.plan === 'PRO').length;
  const freeCount = results.filter(r => r.valid && r.plan === 'FREE').length;

  return {
    total,
    validCount,
    expiredCount,
    errorCount,
    proCount,
    freeCount,
    results
  };
}

/**
 * Imports validated accounts into production accounts directory.
 * Safely creates a backup of existing accounts first.
 */
export async function importAccountsToSlots(validatedResults, options = {}) {
  const accountsDir = options.accountsDir || PROD_ACCOUNTS_DIR;
  if (!fs.existsSync(accountsDir)) {
    fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  }

  // 1. Create backup of current accounts
  const existingFiles = fs.readdirSync(accountsDir).filter(f => f.endsWith('.json') && !f.startsWith('backup_'));
  const backupData = {};
  for (const f of existingFiles) {
    try {
      const content = fs.readFileSync(path.join(accountsDir, f), 'utf8');
      backupData[f] = JSON.parse(content);
    } catch (_) {}
  }

  const backupTimestamp = Date.now();
  const backupFileName = `backup_${backupTimestamp}.json`;
  const backupLatestName = 'backup_previous.json';

  const backupPath = path.join(accountsDir, backupFileName);
  const backupLatestPath = path.join(accountsDir, backupLatestName);

  if (Object.keys(backupData).length > 0) {
    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), { mode: 0o600 });
    fs.writeFileSync(backupLatestPath, JSON.stringify(backupData, null, 2), { mode: 0o600 });
  }

  // 2. Write validated accounts into slot files
  let importedCount = 0;
  const importedSlots = [];

  for (let i = 0; i < validatedResults.length; i++) {
    const item = validatedResults[i];
    if (!item.valid && !options.includeInvalid) continue;

    const targetSlot = String(item.slot || (i + 1));
    const targetFile = path.join(accountsDir, `${targetSlot}.json`);

    const tokenPayload = item.refreshedToken?.token || {
      refresh_token: item.refreshToken,
      token_type: 'Bearer'
    };

    const finalAccount = {
      token: tokenPayload,
      auth_method: 'consumer',
      id_token_email: item.email,
      plan: item.plan || 'FREE',
      slot: targetSlot,
      updated_at: new Date().toISOString()
    };

    fs.writeFileSync(targetFile, JSON.stringify(finalAccount, null, 2), { mode: 0o600 });
    importedCount++;
    importedSlots.push(targetSlot);
  }

  return {
    success: true,
    importedCount,
    importedSlots,
    backupFile: Object.keys(backupData).length > 0 ? backupFileName : null,
    backupPath: Object.keys(backupData).length > 0 ? backupPath : null,
    targetDir: accountsDir
  };
}

/**
 * Formats a validation summary report into clean Telegram HTML.
 */
export function formatValidationReport(summary, sourceName = 'antigravity_accounts.json') {
  const { total, validCount, expiredCount, errorCount, proCount, freeCount, results } = summary;

  const header = `📋 <b>Hasil Validasi File Akun:</b> <code>${escapeHtml(sourceName)}</code>\n\n`;

  const statusOverview =
    `<b>Ringkasan Akun:</b>\n` +
    `• Total Diperiksa: <b>${total} akun</b>\n` +
    `• 🟢 Valid & Aktif: <b>${validCount}</b> (⭐ PRO: ${proCount} | 🆓 FREE: ${freeCount})\n` +
    (expiredCount > 0 ? `• 🔴 Kedaluwarsa: <b>${expiredCount}</b>\n` : '') +
    (errorCount > 0 ? `• ⚠️ Error: <b>${errorCount}</b>\n` : '') +
    `\n`;

  const slotLines = results.map(r => {
    const icon = r.valid ? '🟢' : (r.status === 'EXPIRED' ? '🔴' : '⚠️');
    const planBadge = r.valid ? `[${r.plan}]` : `[${r.status}]`;
    let usageSnippet = '';
    if (r.usage?.gemini?.pct5h !== null) {
      usageSnippet = ` <i>(Gemini: ${r.usage.gemini.pct5h}%)</i>`;
    }
    return `${icon} <b>Slot ${r.slot}:</b> <code>${r.maskedEmail}</code> ${planBadge}${usageSnippet}`;
  });

  const slotsList = `<b>Detail Kredensial Tiap Slot:</b>\n${slotLines.join('\n')}\n\n`;

  let recommendation = '';
  if (validCount === total) {
    recommendation = `<i>Semua ${total} akun terverifikasi sehat dan siap diimpor ke sistem round-robin.</i>`;
  } else if (validCount > 0) {
    recommendation = `<i>Ditemukan ${validCount} akun sehat dari total ${total}. Akun valid dapat langsung diimpor ke slot terkait.</i>`;
  } else {
    recommendation = `<i>Seluruh token akun kedaluwarsa atau tidak valid. Harap periksa kembali file JSON Anda.</i>`;
  }

  return header + statusOverview + slotsList + recommendation;
}

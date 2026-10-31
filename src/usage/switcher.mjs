/**
 * AGY Usage Monitor - Account Switcher & Failover Module
 * 
 * Provides:
 * - Direct slot switching via ag-acc
 * - Smart auto-failover on quota exhaustion (429 / resource_exhausted)
 * - Interactive inline slot selector keypad for Telegram
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import * as tgRich from 'tg-rich-messages';

import { loadCache, DEFAULT_CACHE_PATH } from './scanner.mjs';

const AG_ACC_BIN = process.env.AG_ACC_BIN || '/home/ubuntu/.local/bin/ag-acc';
const PROD_STATE_FILE = '/home/ubuntu/.gemini/antigravity-cli/accounts/round_robin_state.json';
const PROD_ACCOUNTS_DIR = '/home/ubuntu/.gemini/antigravity-cli/accounts';

/**
 * Regex to detect quota exhaustion / rate limiting from AGY stdout/stderr.
 */
export const QUOTA_ERROR_REGEX = /resource_exhausted|quota exceeded|rate limit exceeded|rate_limited|context_failure_kind_rate_limited|error_failed_rate_limit|model API overloaded|RESOURCE_EXHAUSTED/i;

/**
 * Checks whether an error message or log string indicates quota exhaustion.
 */
export function isQuotaExhaustedError(text) {
  if (!text || typeof text !== 'string') return false;
  return QUOTA_ERROR_REGEX.test(text);
}

/**
 * Switches the active Google Account to a specific slot number (1 - 14).
 */
export async function switchToSlot(slot) {
  const slotStr = String(slot).trim();
  const slotNum = parseInt(slotStr, 10);
  if (Number.isNaN(slotNum) || slotNum < 1 || slotNum > 14) {
    return {
      success: false,
      message: `❌ Nomor slot tidak valid: "${slot}". Harap pilih antara Slot 1 s/d 14.`
    };
  }

  const slotFile = path.join(PROD_ACCOUNTS_DIR, `${slotNum}.json`);
  if (!fs.existsSync(slotFile)) {
    return {
      success: false,
      message: `❌ Slot ${slotNum} belum terisi atau file akun tidak ditemukan.`
    };
  }

  return new Promise((resolve) => {
    execFile(AG_ACC_BIN, [String(slotNum)], (err, stdout, stderr) => {
      if (err) {
        return resolve({
          success: false,
          message: `❌ Gagal beralih ke Slot ${slotNum}: ${stderr || err.message}`
        });
      }

      // Read account metadata
      let email = 'Unknown';
      let plan = 'UNKNOWN';
      try {
        const raw = fs.readFileSync(slotFile, 'utf8');
        const parsed = JSON.parse(raw);
        email = parsed.id_token_email || parsed.email || 'Unknown';
        plan = parsed.plan || 'UNKNOWN';
      } catch (_) {}

      resolve({
        success: true,
        slot: String(slotNum),
        email,
        plan,
        output: stdout.trim(),
        message: `✅ Berhasil beralih ke <b>Slot ${slotNum}</b>!\n• Email: <code>${email}</code>\n• Tier: <b>${plan}</b>`
      });
    });
  });
}

/**
 * Rotates to the next available healthy PRO account (marking quota cooldown on current).
 */
export async function rotateToNextHealthySlot(reason = 'quota') {
  return new Promise((resolve) => {
    const cmdArg = reason === 'quota' ? 'rotate-quota' : 'pro';
    execFile(AG_ACC_BIN, [cmdArg], (err, stdout, stderr) => {
      if (err) {
        return resolve({
          success: false,
          message: `❌ Gagal rotasi akun: ${stderr || err.message}`
        });
      }

      // Read new state
      let currentSlot = '1';
      try {
        if (fs.existsSync(PROD_STATE_FILE)) {
          const raw = fs.readFileSync(PROD_STATE_FILE, 'utf8');
          const state = JSON.parse(raw);
          currentSlot = String(state.current_slot || '1');
        }
      } catch (_) {}

      resolve({
        success: true,
        slot: currentSlot,
        output: stdout.trim(),
        message: `🔄 <b>Auto-Failover Berhasil!</b>\nGiliran dialihkan ke <b>Slot ${currentSlot}</b>.\n\n${stdout.trim()}`
      });
    });
  });
}

/**
 * Builds an interactive slot selection view with inline buttons.
 */
export function buildSlotSelectorView(activeSlot = '1') {
  const cacheResult = loadCache(DEFAULT_CACHE_PATH);
  const pools = cacheResult?.data?.pools || { pro: [], free: [] };

  const inlineKeyboard = [];
  let row = [];

  // 1. PRO Pool buttons
  const proList = pools.pro.length > 0
    ? pools.pro
    : [1, 5, 6, 7, 9, 10, 12].map(s => ({ slot: String(s), plan: 'PRO', status: 'OK' }));

  for (const acc of proList) {
    const isCurrent = String(acc.slot) === String(activeSlot);
    const marker = isCurrent ? '🟢 ' : '';
    const label = `${marker}Slot ${acc.slot} (PRO)`;
    row.push({
      text: label,
      callback_data: `action:switch_slot:${acc.slot}`
    });
    if (row.length === 2) {
      inlineKeyboard.push(row);
      row = [];
    }
  }
  if (row.length > 0) {
    inlineKeyboard.push(row);
    row = [];
  }

  // 2. FREE Pool buttons
  const freeList = pools.free.length > 0
    ? pools.free
    : [2, 3, 4, 8, 11, 13, 14].map(s => ({ slot: String(s), plan: 'FREE', status: 'OK' }));

  for (const acc of freeList) {
    const isCurrent = String(acc.slot) === String(activeSlot);
    const marker = isCurrent ? '🟢 ' : '';
    const label = `${marker}Slot ${acc.slot} (FREE)`;
    row.push({
      text: label,
      callback_data: `action:switch_slot:${acc.slot}`
    });
    if (row.length === 2) {
      inlineKeyboard.push(row);
      row = [];
    }
  }
  if (row.length > 0) {
    inlineKeyboard.push(row);
    row = [];
  }

  // Navigation button
  inlineKeyboard.push([
    { text: '« Kembali ke Quota Monitor', callback_data: 'view:agusage' }
  ]);

  const doc = tgRich.doc(
    tgRich.heading(2, '⚡ Pilih Slot Akun Google Auth'),
    tgRich.paragraph([
      'Slot aktif saat ini: ', tgRich.bold(`Slot ${activeSlot} 🟢 [AKTIF]`), '\n\n',
      'Pilih salah satu tombol slot di bawah untuk langsung beralih ke akun tersebut.'
    ]),
    tgRich.blockquote('Pergantian slot dilakukan secara atomik dan aman tanpa memutus sesi bot.')
  );

  return {
    doc,
    keyboard: { inline_keyboard: inlineKeyboard }
  };
}

/**
 * AGY Usage Monitor - Telegram UI & Presentation Module (Phase 3.1 Redesign)
 * 
 * Features:
 * - Professional Telegram Dashboard formatting with clear visual hierarchy.
 * - Bold headings, monospaced quota percentages and slots, structured block separators.
 * - PRO and FREE pool segregation with distinct health metrics.
 * - Displays Gemini (5h/Wk), Claude (5h/Wk), and Argon (Wk) with human-readable reset countdowns.
 * - Degraded accounts display diagnostic reasons without 0% or synthetic metrics.
 * - FREE pool displays available metrics honestly (Argon and 5h as N/A).
 * - Interactive inline Refresh button with 60-second cooldown and concurrency lock.
 * - Preserves existing 9Router analytics cleanly without cross-contamination.
 * - 100% HTML injection safe via escapeHtml.
 */

import path from 'node:path';
import * as tgRich from 'tg-rich-messages';

import {
  loadCache,
  runSequentialCollector,
  DEFAULT_CACHE_PATH,
  DEFAULT_CACHE_TTL_MS
} from './scanner.mjs';

// Cooldown between manual user refreshes (60 seconds)
export const REFRESH_COOLDOWN_MS = 60000;

let isScanActive = false;
let lastScanCompletedMs = 0;

/**
 * Escapes characters for Telegram HTML.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a realtime execution progress update into safe Telegram HTML.
 */
export function formatProgressText(update = {}) {
  const tools = update.tools || [];
  if (tools.length === 0) {
    const thought = update.text || update.lastLog || '';
    const thoughtDisplay = thought
      ? `\n\n💭 <i>${escapeHtml(thought.slice(0, 120))}</i>`
      : '\n<i>Menyiapkan workspace & menganalisis prompt...</i>';
    return `⏳ <b>AGY Sedang Berpikir...</b>${thoughtDisplay}`;
  }

  const cleanParam = (val) => {
    if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"') && val.length > 1) {
      try { return JSON.parse(val); } catch (_) {}
    }
    return val;
  };

  const recent = tools.slice(-4);
  const lines = recent.map((t) => {
    const icon = t.status === 'running' ? '⚙️' : '✅';
    let detail = '';
    if (t.name === 'run_command') {
      const cmd = cleanParam(t.params?.CommandLine || t.parameters?.CommandLine || '');
      detail = `: <code>${escapeHtml(String(cmd).slice(0, 36))}</code>`;
    } else if (t.name === 'edit_file' || t.name === 'write_file' || t.name === 'read_file') {
      const p = cleanParam(t.params?.Path || t.parameters?.Path || '');
      detail = `: <code>${escapeHtml(path.basename(String(p || '')))}</code>`;
    }
    const dur = t.duration ? ` <i>(${t.duration}s)</i>` : '';
    return `${icon} <b>${escapeHtml(t.name)}</b>${detail}${dur}`;
  });

  let liveLogSnippet = '';
  if (update.lastLog) {
    const cleanSnippet = escapeHtml(String(update.lastLog).trim().slice(0, 80));
    if (cleanSnippet) {
      liveLogSnippet = `\n📝 <code>${cleanSnippet}</code>`;
    }
  }

  return `⏳ <b>AGY Sedang Bekerja...</b>\n\n${lines.join('\n')}${liveLogSnippet}\n\n<i>Total ${tools.length} aksi dijalankan</i>`;
}

/**
 * Checks if a scan is currently active.
 */
export function getIsScanActive() {
  return isScanActive;
}

/**
 * Calculates remaining cooldown in seconds (0 if cooldown elapsed).
 */
export function getCooldownRemainingSeconds(nowMs = Date.now()) {
  const elapsed = nowMs - lastScanCompletedMs;
  if (elapsed >= REFRESH_COOLDOWN_MS) return 0;
  return Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000);
}

/**
 * Sets the last scan completion timestamp (useful for testing).
 */
export function setLastScanCompletedMs(ms) {
  lastScanCompletedMs = ms;
}

/**
 * Formats an ISO-8601 UTC timestamp into a human-readable countdown e.g. "1h 22m" or "6d 14h".
 */
export function formatCountdown(isoTimestamp, nowMs = Date.now()) {
  if (!isoTimestamp || typeof isoTimestamp !== 'string') return null;
  const targetMs = Date.parse(isoTimestamp.trim());
  if (Number.isNaN(targetMs)) return null;

  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'segera reset';

  const totalMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;

  if (days > 0) {
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

/**
 * Formats a metric percentage and optional reset countdown.
 */
export function formatMetric(pct, resetUtc, nowMs = Date.now()) {
  if (pct === null || pct === undefined) return 'N/A';
  const cd = formatCountdown(resetUtc, nowMs);
  return cd ? `${pct}% (${cd})` : `${pct}%`;
}

/**
 * Formats account status into a Telegram-friendly icon and badge text.
 */
export function formatStatusBadge(status) {
  switch ((status || '').toUpperCase()) {
    case 'OK':
      return '🟢 OK';
    case 'PARTIAL':
      return '🟡 PARTIAL';
    case 'RATE_LIMITED':
      return '⏳ RATE_LIMITED';
    case 'AUTH_EXPIRED':
      return '🔴 AUTH_EXPIRED';
    case 'TIMEOUT':
      return '⏱️ TIMEOUT';
    case 'UNKNOWN':
    default:
      return '⚪ UNKNOWN';
  }
}

/**
 * Formats clear, actionable diagnostic reasons for degraded or problem accounts.
 */
export function formatErrorReason(status, rawError) {
  const err = (rawError || '').toLowerCase();
  const st = (status || '').toUpperCase();

  if (st === 'AUTH_EXPIRED' || err.includes('auth') || err.includes('invalid_grant') || err.includes('login') || err.includes('error')) {
    return 'Auth Lapsed: Token kadaluarsa / perlu re-login';
  }
  if (st === 'RATE_LIMITED' || err.includes('rate') || err.includes('exhausted') || err.includes('429')) {
    return 'Rate Limited: Batas frekuensi Google Cloud Code tercapai';
  }
  if (st === 'TIMEOUT' || err.includes('timeout') || err.includes('timed out')) {
    return 'Timeout: Respon probe melebihi batas 15 detik';
  }
  return `Status: ${status || 'UNKNOWN'}${rawError ? ` (${rawError})` : ''}`;
}

/**
 * Computes health summary statistics from cache pools.
 */
export function computePoolHealth(pools = {}) {
  const proList = pools.pro || [];
  const freeList = pools.free || [];
  const unknownList = pools.unknown || [];

  const proHealthy = proList.filter(a => a.status === 'OK' || a.status === 'PARTIAL').length;
  const proProblem = proList.length - proHealthy;

  const freeHealthy = freeList.filter(a => a.status === 'OK' || a.status === 'PARTIAL').length;
  const freeProblem = freeList.length - freeHealthy;

  const totalHealthy = proHealthy + freeHealthy;
  const totalProblem = proProblem + freeProblem + unknownList.length;

  return {
    proTotal: proList.length,
    proHealthy,
    proProblem,
    freeTotal: freeList.length,
    freeHealthy,
    freeProblem,
    totalHealthy,
    totalProblem,
    totalAccounts: proList.length + freeList.length + unknownList.length,
    unknownCount: unknownList.length
  };
}

/**
 * Builds the Telegram HTML & Inline Keyboard for `/agusage` (Dashboard Format).
 */
export function buildAgUsageView(options = {}) {
  const cachePath = options.cachePath || DEFAULT_CACHE_PATH;
  const ttlMs = options.ttlMs !== undefined ? options.ttlMs : DEFAULT_CACHE_TTL_MS;
  const activeSlot = String(options.activeSlot || '1');
  const nowMs = options.nowMs || Date.now();

  const cacheResult = loadCache(cachePath, ttlMs, nowMs);

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh Kuota', callback_data: 'action:refresh_agusage' },
        { text: '⚡ Ganti Akun', callback_data: 'view:switch_slot_menu' }
      ],
      [
        { text: '🌐 Detail 9Router', callback_data: 'view:9usage' },
        { text: '« Ringkasan (/usage)', callback_data: 'view:usage' }
      ]
    ]
  };

  // Condition 1: Cache is missing / empty
  if (!cacheResult || !cacheResult.data || !cacheResult.data.pools) {
    const doc = tgRich.doc(
      tgRich.heading(2, '🔑 Google Multi-Auth Quota Monitor'),
      tgRich.paragraph('⚠️ <i>Data cache kuota akun belum tersedia di server.</i>\n\nKlik tombol <b>Refresh Kuota</b> di bawah untuk memulai pemindaian background 14 akun.'),
      tgRich.blockquote('Pemindaian berjalan secara aman di sandbox tanpa memutus sesi bot yang sedang aktif.')
    );
    return { doc, keyboard, isCacheAvailable: false, isStale: true };
  }

  const { data, isStale, ageSeconds } = cacheResult;
  const pools = data.pools || { pro: [], free: [], unknown: [] };
  const health = computePoolHealth(pools);

  const blocks = [];

  // 1. Header
  blocks.push(tgRich.heading(2, '🔑 Google Multi-Auth Quota Monitor'));

  // 2. Summary Card
  const activeSlotFormatted = `Slot ${activeSlot.padStart(2, '0')}`;
  blocks.push(
    tgRich.paragraph([
      tgRich.bold('Ringkasan Pool:\n'),
      `• Total Akun: `, tgRich.bold(`${health.totalAccounts} Akun`), ` (`, tgRich.code(`${health.proTotal} PRO`), ` │ `, tgRich.code(`${health.freeTotal} FREE`), `)\n`,
      `• Status Pool: `, tgRich.bold(`${health.totalHealthy} Sehat`), ` • `, tgRich.bold(`${health.totalProblem} Bermasalah`), `\n`,
      `• Slot Aktif: `, tgRich.code(activeSlotFormatted), ` 🟢 `, tgRich.bold('[AKTIF]')
    ])
  );

  // Stale cache banner
  if (isStale) {
    const ageMins = Math.round(ageSeconds / 60);
    blocks.push(
      tgRich.blockquote([
        '⚠️ ', tgRich.bold('Data Kedaluwarsa:'), ` Usia cache ${ageMins}m lalu. Tekan `, tgRich.bold('Refresh Kuota'), ' untuk pembaruan.'
      ])
    );
  }

  // 3. PRO Pool Section
  blocks.push(
    tgRich.heading(3, `🌟 PRO POOL (${health.proTotal} Akun) — ${health.proHealthy} Sehat, ${health.proProblem} Bermasalah`),
    tgRich.paragraph('────────────────────')
  );

  const proAccounts = pools.pro || [];
  if (proAccounts.length === 0) {
    blocks.push(tgRich.paragraph('<i>(Tidak ada akun terdaftar di PRO pool)</i>'));
  } else {
    for (const a of proAccounts) {
      const isCurrent = String(a.slot) === activeSlot;
      const slotMarker = isCurrent ? ' 🟢 [AKTIF]' : '';
      const badge = tgRich.bold(formatStatusBadge(a.status));
      const slotStr = `Slot ${String(a.slot).padStart(2, '0')}`;

      if (a.status === 'OK' || a.status === 'PARTIAL') {
        const g5h = a.gemini?.pct5h !== null ? tgRich.code(`${a.gemini.pct5h}%`) : 'N/A';
        const g5hCd = formatCountdown(a.gemini?.reset5hUtc, nowMs);
        const g5hStr = g5hCd ? [g5h, ` (5h: ${g5hCd})`] : [g5h, ' (5h)'];

        const gWk = a.gemini?.pctWeekly !== null ? tgRich.code(`${a.gemini.pctWeekly}%`) : 'N/A';
        const gWkCd = formatCountdown(a.gemini?.resetWeeklyUtc, nowMs);
        const gWkStr = gWkCd ? [gWk, ` (Wk: ${gWkCd})`] : [gWk, ' (Wk)'];

        const c5h = a.claudeGpt?.pct5h !== null ? tgRich.code(`${a.claudeGpt.pct5h}%`) : 'N/A';
        const c5hCd = formatCountdown(a.claudeGpt?.reset5hUtc, nowMs);
        const c5hStr = c5hCd ? [c5h, ` (5h: ${c5hCd})`] : [c5h, ' (5h)'];

        const cWk = a.claudeGpt?.pctWeekly !== null ? tgRich.code(`${a.claudeGpt.pctWeekly}%`) : 'N/A';
        const cWkCd = formatCountdown(a.claudeGpt?.resetWeeklyUtc, nowMs);
        const cWkStr = cWkCd ? [cWk, ` (Wk: ${cWkCd})`] : [cWk, ' (Wk)'];

        const argWk = a.argon?.pctWeekly !== null ? tgRich.code(`${a.argon.pctWeekly}%`) : 'N/A';
        const argCd = formatCountdown(a.argon?.resetWeeklyUtc, nowMs);
        const argStr = argCd ? [argWk, ` (Wk: ${argCd})`] : [argWk, ' (Wk)'];

        blocks.push(
          tgRich.paragraph([
            tgRich.bold(slotStr), ' ', tgRich.code(a.email), isCurrent ? tgRich.bold(slotMarker) : '', ' — ', badge, '\n',
            '• Gemini: ', ...g5hStr, ' │ ', ...gWkStr, '\n',
            '• Claude: ', ...c5hStr, ' │ ', ...cWkStr, '\n',
            '• Argon:  ', ...argStr
          ])
        );
      } else {
        const reason = formatErrorReason(a.status, a.errorMessage);
        blocks.push(
          tgRich.paragraph([
            tgRich.bold(slotStr), ' ', tgRich.code(a.email), isCurrent ? tgRich.bold(slotMarker) : '', ' — ', badge, '\n',
            '• ', tgRich.italic(reason)
          ])
        );
      }
    }
  }

  // 4. FREE Pool Section
  blocks.push(
    tgRich.heading(3, `🆓 FREE POOL (${health.freeTotal} Akun) — ${health.freeHealthy} Sehat, ${health.freeProblem} Bermasalah`),
    tgRich.paragraph('────────────────────')
  );

  const freeAccounts = pools.free || [];
  if (freeAccounts.length === 0) {
    blocks.push(tgRich.paragraph('<i>(Tidak ada akun terdaftar di FREE pool)</i>'));
  } else {
    for (const a of freeAccounts) {
      const isCurrent = String(a.slot) === activeSlot;
      const slotMarker = isCurrent ? ' 🟢 [AKTIF]' : '';
      const badge = tgRich.bold(formatStatusBadge(a.status));
      const slotStr = `Slot ${String(a.slot).padStart(2, '0')}`;

      if (a.status === 'OK' || a.status === 'PARTIAL') {
        const gWk = a.gemini?.pctWeekly !== null ? tgRich.code(`${a.gemini.pctWeekly}%`) : 'N/A';
        const gWkCd = formatCountdown(a.gemini?.resetWeeklyUtc, nowMs);
        const gWkStr = gWkCd ? [gWk, ` (Wk: ${gWkCd})`] : [gWk, ' (Wk)'];

        const cWk = a.claudeGpt?.pctWeekly !== null ? tgRich.code(`${a.claudeGpt.pctWeekly}%`) : 'N/A';
        const cWkCd = formatCountdown(a.claudeGpt?.resetWeeklyUtc, nowMs);
        const cWkStr = cWkCd ? [cWk, ` (Wk: ${cWkCd})`] : [cWk, ' (Wk)'];

        blocks.push(
          tgRich.paragraph([
            tgRich.bold(slotStr), ' ', tgRich.code(a.email), isCurrent ? tgRich.bold(slotMarker) : '', ' — ', badge, '\n',
            '• Gemini: ', ...gWkStr, '\n',
            '• Claude: ', ...cWkStr, '\n',
            '• Argon:  ', tgRich.italic('N/A (Free Tier)')
          ])
        );
      } else {
        const reason = formatErrorReason(a.status, a.errorMessage);
        blocks.push(
          tgRich.paragraph([
            tgRich.bold(slotStr), ' ', tgRich.code(a.email), isCurrent ? tgRich.bold(slotMarker) : '', ' — ', badge, '\n',
            '• ', tgRich.italic(reason)
          ])
        );
      }
    }
  }

  // 5. UNKNOWN Pool Section (if any unrecognized plan found)
  if (pools.unknown && pools.unknown.length > 0) {
    blocks.push(
      tgRich.heading(3, `❓ UNKNOWN POOL (${pools.unknown.length} Akun)`),
      tgRich.paragraph('────────────────────')
    );
    for (const a of pools.unknown) {
      const isCurrent = String(a.slot) === activeSlot;
      const slotMarker = isCurrent ? ' 🟢 [AKTIF]' : '';
      const badge = tgRich.bold(formatStatusBadge(a.status));
      const slotStr = `Slot ${String(a.slot).padStart(2, '0')}`;
      const reason = formatErrorReason(a.status, a.errorMessage);
      blocks.push(
        tgRich.paragraph([
          tgRich.bold(slotStr), ' ', tgRich.code(a.email), isCurrent ? tgRich.bold(slotMarker) : '', ' [', a.plan || 'UNKNOWN', '] — ', badge, '\n',
          '• ', tgRich.italic(reason)
        ])
      );
    }
  }

  // 6. Footer Block
  const lastUpdatedStr = data.updatedAtUtc ? new Date(data.updatedAtUtc).toISOString().slice(11, 19) + ' UTC' : '-';
  const ageMins = Math.round(ageSeconds / 60);
  const cacheStatusText = isStale ? `⚠️ Kedaluwarsa (${ageMins}m lalu)` : `✅ Segar (${ageMins}m lalu)`;

  blocks.push(
    tgRich.paragraph('━━━━━━━━━━━━━━━━━━━━'),
    tgRich.paragraph([
      '🕒 ', tgRich.bold('Status Cache: '), tgRich.code(cacheStatusText), ' │ Pindai: ', tgRich.code(lastUpdatedStr), ` (${data.durationSeconds || 0}s)\n`,
      tgRich.italic('🟢 = Slot aktif digunakan oleh bot saat ini')
    ])
  );

  return {
    doc: tgRich.doc(...blocks),
    keyboard,
    isCacheAvailable: true,
    isStale
  };
}

/**
 * Builds the AGY summary section for the combined `/usage` overview.
 * Keeps 9Router metrics completely untouched and separate.
 */
export function buildUsageOverviewSection(cacheResult, agMeta = {}) {
  const activeSlot = String(agMeta.activeSlot || '1').padStart(2, '0');
  const rotations = agMeta.rotations || 0;

  if (!cacheResult || !cacheResult.data || !cacheResult.data.pools) {
    return tgRich.paragraph([
      tgRich.bold('🔑 AGY Google Multi-Auth Quota:\n'),
      '• Total Akun: ', tgRich.bold('14 Akun'), ' (', tgRich.code('7 PRO'), ' │ ', tgRich.code('7 FREE'), ')\n',
      '• Slot Aktif: ', tgRich.code(`Slot ${activeSlot}`), ' 🟢\n',
      '• Status Kuota: ', tgRich.italic('⚠️ Belum Dipindai'), '\n',
      '• Total Rotasi: ', tgRich.code(`${rotations}x putaran`)
    ]);
  }

  const { data, isStale, ageSeconds } = cacheResult;
  const health = computePoolHealth(data.pools);
  const ageMins = Math.round(ageSeconds / 60);
  const cacheStatusText = isStale ? `⚠️ Kedaluwarsa (${ageMins}m lalu)` : `✅ Segar (${ageMins}m lalu)`;

  return tgRich.paragraph([
    tgRich.bold('🔑 AGY Google Multi-Auth Quota:\n'),
    '• Total Akun: ', tgRich.bold('14 Akun'), ' (', tgRich.code('7 PRO'), ' │ ', tgRich.code('7 FREE'), ')\n',
    '• Slot Aktif: ', tgRich.code(`Slot ${activeSlot}`), ' 🟢\n',
    '• Status Pool: ', tgRich.bold(`${health.totalHealthy} Sehat`), ' • ', tgRich.bold(`${health.totalProblem} Bermasalah`), '\n',
    '• Cache Kuota: ', tgRich.code(cacheStatusText), ` (${data.durationSeconds || 0}s)\n`,
    '• Total Rotasi: ', tgRich.code(`${rotations}x putaran`)
  ]);
}

/**
 * Handler for the interactive inline "Refresh Kuota" button.
 * Enforces concurrency lock and 60-second cooldown.
 */
export async function triggerManualRefresh(options = {}) {
  const nowMs = options.nowMs || Date.now();

  // 1. Concurrency Check
  if (isScanActive) {
    return {
      success: false,
      reason: 'IN_PROGRESS',
      message: '⚠️ Pemindaian kuota sedang berjalan di background. Mohon tunggu sejenak.'
    };
  }

  // 2. Cooldown Check
  const remainingSec = getCooldownRemainingSeconds(nowMs);
  if (remainingSec > 0 && options.bypassCooldown !== true) {
    return {
      success: false,
      reason: 'COOLDOWN',
      remainingSeconds: remainingSec,
      message: `⏳ Cooldown aktif. Silakan coba lagi dalam ${remainingSec} detik.`
    };
  }

  // 3. Initiate Scan with Safety Lock
  isScanActive = true;
  const collectorPromise = (options.scanFn || runSequentialCollector)(null, {
    pacingMs: 400,
    timeoutMs: 15000,
    saveCache: true,
    cachePath: options.cachePath || DEFAULT_CACHE_PATH
  });

  // Track completion asynchronously
  collectorPromise
    .then(() => {
      lastScanCompletedMs = options.nowMs || Date.now();
    })
    .catch((err) => {
      console.error('[UsageUI] Manual refresh scan error:', err.message);
    })
    .finally(() => {
      isScanActive = false;
    });

  return {
    success: true,
    message: '🔄 Memulai pemindaian 14 akun di background (~45s)...'
  };
}

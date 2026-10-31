/**
 * AGY Usage - Interactive OAuth Login Wizard
 * 
 * Enables remote re-authentication of Google Accounts directly via Telegram:
 * 1. Spawns isolated agy session in headless mode
 * 2. Extracts OAuth URL and sends to Telegram
 * 3. Awaits authorization code from user chat
 * 4. Passes code to stdin and saves resulting token to designated slot
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const AGY_PATH = process.env.AGY_PATH || '/home/ubuntu/.local/bin/agy';
const PROD_ACCOUNTS_DIR = '/home/ubuntu/.gemini/antigravity-cli/accounts';

// Map of active login sessions: chatId -> SessionObject
export const activeLoginSessions = new Map();

/**
 * Checks if a chat currently has an active login session.
 */
export function hasActiveLoginSession(chatId) {
  return activeLoginSessions.has(String(chatId));
}

/**
 * Cancels an active login session.
 */
export function cancelLoginSession(chatId) {
  const session = activeLoginSessions.get(String(chatId));
  if (!session) return false;

  try {
    if (session.child && !session.child.killed) {
      session.child.kill('SIGKILL');
    }
  } catch (_) {}

  try {
    if (session.sandboxDir && fs.existsSync(session.sandboxDir)) {
      fs.rmSync(session.sandboxDir, { recursive: true, force: true });
    }
  } catch (_) {}

  if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
  activeLoginSessions.delete(String(chatId));
  return true;
}

/**
 * Initiates a login flow for a target slot.
 * Calls onUrlReady(oauthUrl) when URL is captured.
 * Calls onComplete(result) when token is generated or error occurs.
 */
export async function startLoginFlow(chatId, slot, { onUrlReady, onComplete }) {
  const slotNum = parseInt(String(slot).trim(), 10);
  if (Number.isNaN(slotNum) || slotNum < 1 || slotNum > 14) {
    return {
      success: false,
      message: `❌ Nomor slot tidak valid: "${slot}". Harap pilih antara Slot 1 s/d 14.`
    };
  }

  // Cancel any existing session for this chat
  cancelLoginSession(chatId);

  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `agy_login_s${slotNum}_`));
  let child;
  try {
    child = spawn(AGY_PATH, ['-p', 'hello'], {
      env: {
        ...process.env,
        HOME: sandboxDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    return {
      success: false,
      message: `❌ Gagal memulai proses login: ${err.message}`
    };
  }

  const sessionObj = {
    chatId: String(chatId),
    slot: String(slotNum),
    sandboxDir,
    child,
    urlSent: false,
    onComplete,
    startTime: Date.now(),
    timeoutTimer: null
  };

  // 3-minute timeout
  sessionObj.timeoutTimer = setTimeout(() => {
    if (activeLoginSessions.has(String(chatId))) {
      cancelLoginSession(chatId);
      if (onComplete) {
        onComplete({
          success: false,
          message: `⏱️ Sesi login untuk Slot ${slotNum} kedaluwarsa (batas waktu 3 menit). Silakan coba lagi.`
        });
      }
    }
  }, 180000);

  activeLoginSessions.set(String(chatId), sessionObj);

  let stdoutBuf = '';
  child.stdout.on('data', (d) => {
    const chunk = d.toString();
    stdoutBuf += chunk;

    // Detect OAuth URL
    if (!sessionObj.urlSent) {
      const match = stdoutBuf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/);
      if (match) {
        sessionObj.urlSent = true;
        const oauthUrl = match[0];
        if (onUrlReady) onUrlReady(oauthUrl, String(slotNum));
      }
    }
  });

  child.stderr.on('data', (d) => {
    stdoutBuf += d.toString();
  });

  child.on('close', (code) => {
    if (!activeLoginSessions.has(String(chatId))) return; // Already cleaned up

    clearTimeout(sessionObj.timeoutTimer);
    activeLoginSessions.delete(String(chatId));

    // Check generated token
    const tokenFile = path.join(sandboxDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    if (fs.existsSync(tokenFile)) {
      try {
        const tokenContent = fs.readFileSync(tokenFile, 'utf8');
        const tokenJson = JSON.parse(tokenContent);
        const email = tokenJson.id_token_email || tokenJson.email || 'Unknown';

        // Read existing plan if present
        let plan = 'FREE';
        const targetSlotFile = path.join(PROD_ACCOUNTS_DIR, `${slotNum}.json`);
        if (fs.existsSync(targetSlotFile)) {
          try {
            const oldData = JSON.parse(fs.readFileSync(targetSlotFile, 'utf8'));
            if (oldData.plan) plan = oldData.plan;
          } catch (_) {}
        } else if ([1, 5, 6, 7, 9, 10, 12].includes(slotNum)) {
          plan = 'PRO';
        }

        const finalAccountData = {
          ...tokenJson,
          plan,
          slot: String(slotNum),
          updated_at: new Date().toISOString()
        };

        fs.writeFileSync(targetSlotFile, JSON.stringify(finalAccountData, null, 2), { mode: 0o600 });

        // Clean sandbox
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}

        if (onComplete) {
          onComplete({
            success: true,
            slot: String(slotNum),
            email,
            plan,
            message: `✅ <b>Login Berhasil untuk Slot ${slotNum}!</b>\n• Email: <code>${email}</code>\n• Tier: <b>${plan}</b>\n\nToken kredensial telah disimpan dan slot kini kembali sehat!`
          });
        }
        return;
      } catch (saveErr) {
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
        if (onComplete) {
          onComplete({
            success: false,
            message: `❌ Gagal menyimpan token ke Slot ${slotNum}: ${saveErr.message}`
          });
        }
        return;
      }
    }

    // Token file not found
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    if (onComplete) {
      onComplete({
        success: false,
        message: `❌ Proses login keluar (kode ${code}) tanpa menghasilkan token.\nOutput: ${stdoutBuf.slice(-200)}`
      });
    }
  });

  return { success: true };
}

/**
 * Delivers the authorization code from user input to the waiting child process.
 */
export function submitAuthCode(chatId, rawInput) {
  const session = activeLoginSessions.get(String(chatId));
  if (!session) return false;

  let code = String(rawInput || '').trim();
  // If user pasted redirect URL e.g. https://antigravity.google/oauth-callback?code=...
  if (code.includes('code=')) {
    try {
      const parsedUrl = new URL(code);
      const extracted = parsedUrl.searchParams.get('code');
      if (extracted) code = extracted;
    } catch (_) {
      const match = code.match(/code=([^&]+)/);
      if (match) code = decodeURIComponent(match[1]);
    }
  }

  try {
    session.child.stdin.write(code + '\n');
    return true;
  } catch (err) {
    console.error('[LOGIN-WIZARD] Failed to write auth code to child stdin:', err.message);
    return false;
  }
}

import fs from 'fs';
import path from 'path';
import { spawn, exec, execFile, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import * as tgRich from 'tg-rich-messages';
import {
  buildAgUsageView as buildAgUsageRichView,
  buildUsageOverviewSection,
  triggerManualRefresh,
  formatProgressText
} from './src/usage/ui.mjs';
import { loadCache, DEFAULT_CACHE_PATH, DEFAULT_CACHE_TTL_MS } from './src/usage/scanner.mjs';
import {
  switchToSlot,
  rotateToNextHealthySlot,
  buildSlotSelectorView,
  isQuotaExhaustedError
} from './src/usage/switcher.mjs';
import { processVoiceNote } from './src/voice/stt.mjs';
import {
  startLoginFlow,
  submitAuthCode,
  hasActiveLoginSession,
  cancelLoginSession
} from './src/usage/login-wizard.mjs';
import {
  getGitStatus,
  getGitDiff,
  gitCommitAndPush,
  gitPull
} from './src/git/git-ops.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not defined in .env or environment.');
  process.exit(1);
}

let ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

let ALLOWED_TOPICS = (process.env.ALLOWED_TOPICS || '7')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => !isNaN(n));

// Active processes map: sessionKey -> { child, startTime, cancel: () => void }
const activeProcesses = new Map();

// Active cloudflare tunnels: port -> { child, url, startTime }
const activeTunnels = new Map();

// Active background watchers: id -> { target, intervalMinutes, timer, lastStatus, chatId, threadId, startTime }
const activeWatchers = new Map();
let watcherSeq = 1;

// Quick Keyboard Shortcuts for Mobile
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Status' }, { text: '📈 Usage' }, { text: '⚡ 9Router' }],
    [{ text: '👥 AG Akun' }, { text: '📂 File (ls)' }, { text: '🌐 Preview' }],
    [{ text: '🔄 New Session' }, { text: '🛑 Stop' }, { text: '🎙️ Voice' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

const AGY_PATH = process.env.AGY_PATH || '/home/ubuntu/.local/bin/agy';
const DEFAULT_DIR = process.env.DEFAULT_WORKING_DIR || '/home/ubuntu';
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// Session persistence
let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) {
  try {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    // Startup sanity recovery: tandai pengiriman in_progress/sending menjadi paused_unknown
    let recoveredCount = 0;
    for (const [sKey, sVal] of Object.entries(sessions)) {
      if (sVal && sVal.pendingDelivery) {
        const pd = sVal.pendingDelivery;
        if (pd.status === 'in_progress' || pd.currentChunkStatus === 'sending') {
          pd.status = 'paused_unknown';
          pd.currentChunkStatus = 'unknown';
          if (Array.isArray(pd.chunkStatuses) && pd.currentChunkIndex >= 0 && pd.chunkStatuses[pd.currentChunkIndex] === 'sending') {
            pd.chunkStatuses[pd.currentChunkIndex] = 'unknown';
          }
          pd.lastError = 'Service restart saat chunk dalam status sending';
          pd.updatedAt = Date.now();
          recoveredCount++;
        }
      }
    }
    if (recoveredCount > 0) {
      console.warn(`[STARTUP-RECOVERY] ${recoveredCount} sesi dengan pending delivery in_progress ditandai paused_unknown.`);
      saveSessions();
    }
  } catch (e) {
    console.error('Failed to read sessions.json, initializing empty:', e);
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save sessions:', e);
    return false;
  }
}

function getSession(userId) {
  const key = String(userId);
  if (!sessions[key]) {
    sessions[key] = {
      conversationId: null,
      mode: 'auto',
      model: null,
      effort: null,
      agent: null,
      voiceReply: false,
      workingDir: DEFAULT_DIR,
      lastTools: [],
      lastTurn: null,
      pendingDelivery: null
    };
    saveSessions();
  } else {
    if (!sessions[key].workingDir) sessions[key].workingDir = DEFAULT_DIR;
    if (!sessions[key].mode) sessions[key].mode = 'auto';
    if (sessions[key].model === undefined) sessions[key].model = null;
    if (sessions[key].effort === undefined) sessions[key].effort = null;
    if (sessions[key].agent === undefined) sessions[key].agent = null;
    if (sessions[key].voiceReply === undefined) sessions[key].voiceReply = false;
    if (!sessions[key].lastTools) sessions[key].lastTools = [];
    if (sessions[key].lastTurn === undefined) sessions[key].lastTurn = null;
    if (sessions[key].pendingDelivery === undefined) sessions[key].pendingDelivery = null;
  }
  return sessions[key];
}

// Active Background Watchers: id -> { type, target, chatId, threadId, timer, lastState }
const watchers = new Map();

// Helper 9Router Usage
function get9RouterUsage() {
  try {
    const DB_PATH = '/home/ubuntu/.9router/db/data.sqlite';
    if (!fs.existsSync(DB_PATH)) return null;
    const db = new DatabaseSync(DB_PATH);
    const rows = db.prepare('SELECT dateKey, data FROM usageDaily ORDER BY dateKey DESC LIMIT 7').all();
    if (!rows || rows.length === 0) return null;

    const todayRow = rows[0];
    const today = JSON.parse(todayRow.data || '{}');

    let totalReq7d = 0;
    let totalPrompt7d = 0;
    let totalComp7d = 0;
    let totalCost7d = 0;

    for (const r of rows) {
      const d = JSON.parse(r.data || '{}');
      totalReq7d += d.requests || 0;
      totalPrompt7d += d.promptTokens || 0;
      totalComp7d += d.completionTokens || 0;
      totalCost7d += d.cost || 0;
    }

    return {
      latestDate: todayRow.dateKey,
      today: {
        requests: today.requests || 0,
        promptTokens: today.promptTokens || 0,
        completionTokens: today.completionTokens || 0,
        cachedTokens: today.cachedTokens || 0,
        cost: today.cost || 0,
        byModel: today.byModel || {},
        byProvider: today.byProvider || {}
      },
      sevenDays: {
        requests: totalReq7d,
        promptTokens: totalPrompt7d,
        completionTokens: totalComp7d,
        cost: totalCost7d
      }
    };
  } catch (err) {
    console.error('get9RouterUsage error:', err);
    return null;
  }
}

// Helper AGY Google Auth Accounts Usage
function getAgyAccountsUsage() {
  try {
    const dir = '/home/ubuntu/.gemini/antigravity-cli/accounts';
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'round_robin_state.json');
    files.sort((a,b) => parseInt(a) - parseInt(b));

    let state = { last_pro_slot: '1', last_rotated_at: null, rotation_count: 0 };
    const stateFile = path.join(dir, 'round_robin_state.json');
    if (fs.existsSync(stateFile)) {
      try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (_) {}
    }

    let proCount = 0;
    let freeCount = 0;

    const accounts = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const isPro = (data.plan || '').toUpperCase() === 'PRO';
      if (isPro) proCount++; else freeCount++;
      const slot = f.replace('.json', '');

      let rawEmail = data.id_token_email || 'akun';
      let maskedEmail = rawEmail;
      const atIdx = rawEmail.indexOf('@');
      if (atIdx > 3) {
        maskedEmail = rawEmail.slice(0, 3) + '***' + rawEmail.slice(atIdx);
      }

      return {
        slot,
        email: maskedEmail,
        plan: isPro ? 'PRO' : 'FREE',
        isActive: String(slot) === String(state.last_pro_slot)
      };
    });

    return {
      total: files.length,
      proCount,
      freeCount,
      activeSlot: state.last_pro_slot,
      lastRotated: state.last_rotated_at,
      rotations: state.rotation_count,
      accounts
    };
  } catch (err) {
    console.error('getAgyAccountsUsage error:', err);
    return null;
  }
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Eksekusi dibatalkan saat menunggu jeda'));
    }
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error('Eksekusi dibatalkan saat menunggu jeda'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
  });
}

// Shared Telegram Rate Limit Cooldown State
const telegramRateLimitState = {
  cooldownUntil: 0,
  lastRetryAfter: 0,
  setCooldown(retryAfterSec) {
    const sec = Math.min(Math.max(Number(retryAfterSec) || 5, 1), 60);
    const marginMs = 1000;
    const until = Date.now() + (sec * 1000) + marginMs;
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      this.lastRetryAfter = sec;
    }
    return until;
  },
  isCoolingDown() {
    return Date.now() < this.cooldownUntil;
  },
  getRemainingWaitMs() {
    return Math.max(0, this.cooldownUntil - Date.now());
  },
  reset() {
    this.cooldownUntil = 0;
    this.lastRetryAfter = 0;
  }
};

async function tgRequest(method, body = {}) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data;
  try {
    data = await res.json();
  } catch (jsonErr) {
    const err = new Error(`Telegram API ${method} non-JSON response (HTTP ${res.status}): ${jsonErr.message}`);
    err.error_code = res.status;
    err.status = res.status;
    throw err;
  }
  if (!data.ok) {
    const err = new Error(`Telegram API ${method} error: ${JSON.stringify(data)}`);
    err.error_code = data.error_code || res.status;
    err.description = data.description;
    err.parameters = data.parameters;
    let retryAfter = data.parameters?.retry_after;
    if (!retryAfter && data.description) {
      const m = data.description.match(/retry after (\d+)/i);
      if (m) retryAfter = parseInt(m[1], 10);
    }
    if (retryAfter) {
      err.retry_after = Number(retryAfter);
    }
    if (err.error_code === 429) {
      telegramRateLimitState.setCooldown(err.retry_after || 5);
    }
    throw err;
  }
  return data.result;
}

async function sendChatActionGlobal(chatId, action = 'typing', threadId = null) {
  if (telegramRateLimitState.isCoolingDown()) return;
  try {
    const body = { chat_id: chatId, action };
    if (threadId) body.message_thread_id = threadId;
    await tgRequest('sendChatAction', body);
  } catch (_) {}
}
const sendChatAction = sendChatActionGlobal;

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  try {
    await tgRequest('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert
    });
  } catch (err) {
    console.error('answerCallbackQuery error:', err.message);
  }
}

// Convert markdown text to tgRich.RichDocument
function parseInlineText(text) {
  if (!text) return [];
  const parts = [];
  const regex = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\|\|[^|]+\|\||\[[^\]]+\]\([^\)]+\))/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('***') && token.endsWith('***')) {
      parts.push(tgRich.bold(tgRich.italic(token.slice(3, -3))));
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(tgRich.bold(token.slice(2, -2)));
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(tgRich.italic(token.slice(1, -1)));
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(tgRich.code(token.slice(1, -1)));
    } else if (token.startsWith('||') && token.endsWith('||')) {
      parts.push(tgRich.spoiler(token.slice(2, -2)));
    } else if (token.startsWith('[') && token.endsWith(')')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
      if (linkMatch) {
        const label = linkMatch[1];
        const url = linkMatch[2].trim();
        if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('tg://')) {
          parts.push(tgRich.link(label, url));
        } else {
          parts.push(label);
        }
      } else {
        parts.push(token);
      }
    } else {
      parts.push(token);
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts.length > 0 ? parts : [text];
}

function markdownToRichDoc(md) {
  if (!md) return tgRich.doc(tgRich.paragraph('(Kosong)'));
  const blocks = [];
  const lines = md.split('\n');
  let currentParagraph = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines = [];

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      const fullText = currentParagraph.join('\n');
      blocks.push(tgRich.paragraph(parseInlineText(fullText)));
      currentParagraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        blocks.push(tgRich.pre(codeLines.join('\n'), codeLang || undefined));
        inCodeBlock = false;
        codeLines = [];
        codeLang = '';
      } else {
        flushParagraph();
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headers (h1 - h6)
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      flushParagraph();
      const level = headerMatch[1].length;
      let title = headerMatch[2].trim();
      // Bersihkan file link dan duplikasi bold di dalam heading
      title = cleanHeadingContent(title);
      blocks.push(tgRich.heading(Math.min(level, 6), parseInlineText(title)));
      continue;
    }

    // Dividers
    if (line.trim() === '---' || line.trim() === '***') {
      flushParagraph();
      blocks.push(tgRich.divider());
      continue;
    }

    // Quotes
    if (line.startsWith('> ')) {
      flushParagraph();
      blocks.push(tgRich.blockquote(parseInlineText(line.slice(2).trim())));
      continue;
    }

    // Empty lines flush paragraph
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    // List item bullet conversion
    let lineText = line;
    if (/^[\*\-]\s+/.test(lineText)) {
      lineText = lineText.replace(/^[\*\-]\s+/, '• ');
    }
    currentParagraph.push(lineText);
  }

  if (inCodeBlock && codeLines.length > 0) {
    blocks.push(tgRich.pre(codeLines.join('\n'), codeLang || undefined));
  } else {
    flushParagraph();
  }

  return blocks.length > 0 ? tgRich.doc(...blocks) : tgRich.doc(tgRich.paragraph('(Kosong)'));
}

function cleanHeadingContent(text) {
  if (!text) return '';
  return text
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/<\/?(?:b|strong)>/gi, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .trim();
}

const VALID_TELEGRAM_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote', 'tg-emoji'
]);

// Sanitize, balance and escape HTML tags strictly according to Telegram entity rules
function sanitizeTelegramHtml(rawHtml) {
  if (!rawHtml) return '';
  let text = String(rawHtml);

  // Structural conversions
  text = text.replace(/<hr\s*\/?>/gi, '────────────────────\n\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  text = text.replace(/<\/?p[^>]*>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  const tokenRegex = /(<\/?[a-zA-Z0-9_-]+(?:\s+[^>]*?)?>|&[a-zA-Z0-9#]+;)/g;

  let result = '';
  let lastIdx = 0;
  const tagStack = [];

  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      const slice = text.slice(lastIdx, match.index);
      result += slice.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    lastIdx = tokenRegex.lastIndex;

    const token = match[0];
    if (token.startsWith('&')) {
      result += token;
      continue;
    }

    const isClosing = token.startsWith('</');
    const tagMatch = token.match(/^<\/?([a-zA-Z0-9_-]+)/);
    const tagName = tagMatch ? tagMatch[1].toLowerCase() : '';

    if (!VALID_TELEGRAM_TAGS.has(tagName)) {
      result += token.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      continue;
    }

    if (!isClosing) {
      tagStack.push(tagName);
      result += token;
    } else {
      if (tagStack.length === 0) {
        continue;
      }
      const top = tagStack[tagStack.length - 1];
      if (top === tagName) {
        tagStack.pop();
        result += `</${tagName}>`;
      } else {
        const pos = tagStack.lastIndexOf(tagName);
        if (pos !== -1) {
          while (tagStack.length > pos) {
            const popped = tagStack.pop();
            result += `</${popped}>`;
          }
        } else {
          continue;
        }
      }
    }
  }

  if (lastIdx < text.length) {
    const slice = text.slice(lastIdx);
    result += slice.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  while (tagStack.length > 0) {
    const popped = tagStack.pop();
    result += `</${popped}>`;
  }

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function stripTelegramTags(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function toTelegramHTML(docOrHtml) {
  if (!docOrHtml) return '';
  let html = typeof docOrHtml === 'string'
    ? docOrHtml
    : (docOrHtml.toHTML ? docOrHtml.toHTML() : String(docOrHtml));

  // Konversi table HTML ke format teks cantik yang didukung Telegram
  html = html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (m, tableContent) => {
    const rows = [];
    const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const r of rowMatches) {
      const cells = [];
      const cellMatches = r.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) || [];
      for (const c of cellMatches) {
        const text = c.replace(/^<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>$/i, '$1').trim();
        cells.push(text);
      }
      if (cells.length === 2) {
        rows.push(`• <b>${cells[0]}:</b> ${cells[1]}`);
      } else if (cells.length > 0) {
        rows.push(cells.join(' | '));
      }
    }
    return rows.length > 0 ? rows.join('\n') + '\n\n' : '';
  });

  // Konversi <h1..6> ke <b>...</b> tanpa kedouble bold
  html = html.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (m, content) => {
    const cleaned = cleanHeadingContent(content);
    return `<b>${cleaned}</b>\n\n`;
  });

  // Konversi divider / hr
  html = html.replace(/<hr\s*\/?>/gi, '────────────────────\n\n');

  // Konversi p
  html = html.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  return sanitizeTelegramHtml(html);
}

// Unicode code points counter & slicer
function getCodePointLength(str) {
  if (!str) return 0;
  return Array.from(str).length;
}

function sliceCodePoints(str, start, end) {
  if (!str) return '';
  return Array.from(str).slice(start, end).join('');
}

// Split a single long line exceeding maxLen without breaking words or URLs if avoidable
function splitLongLine(line, maxLen, inCodeBlock) {
  const parts = [];
  let remaining = line;

  while (getCodePointLength(remaining) > maxLen) {
    const pts = Array.from(remaining);
    let splitIdx = maxLen;

    if (!inCodeBlock) {
      let spaceIdx = -1;
      const searchStart = Math.max(0, maxLen - 200);
      for (let j = maxLen - 1; j >= searchStart; j--) {
        if (pts[j] === ' ') {
          spaceIdx = j;
          break;
        }
      }
      if (spaceIdx > 0) {
        splitIdx = spaceIdx;
      }
    }

    const chunkStr = pts.slice(0, splitIdx).join('');
    if (chunkStr.length > 0) {
      parts.push(chunkStr);
    }
    remaining = pts.slice(splitIdx).join('').replace(/^ /, '');
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

// Tokenize HTML for safe splitting preserving tags and entities
function tokenizeHtml(str) {
  const tokenRegex = /(<\/?[a-zA-Z0-9_-]+(?:\s+[^>]*?)?>|&[a-zA-Z0-9#]+;)/g;
  const tokens = [];
  let lastIdx = 0;
  let match;
  while ((match = tokenRegex.exec(str)) !== null) {
    if (match.index > lastIdx) {
      tokens.push({ type: 'text', value: str.slice(lastIdx, match.index) });
    }
    const val = match[0];
    if (val.startsWith('&')) {
      tokens.push({ type: 'entity', value: val });
    } else if (val.startsWith('</')) {
      const nameMatch = val.match(/^<\/([a-zA-Z0-9_-]+)/);
      tokens.push({ type: 'closeTag', value: val, name: nameMatch ? nameMatch[1].toLowerCase() : '' });
    } else {
      const nameMatch = val.match(/^<([a-zA-Z0-9_-]+)/);
      tokens.push({ type: 'openTag', value: val, name: nameMatch ? nameMatch[1].toLowerCase() : '' });
    }
    lastIdx = tokenRegex.lastIndex;
  }
  if (lastIdx < str.length) {
    tokens.push({ type: 'text', value: str.slice(lastIdx) });
  }
  return tokens;
}

// Split a single HTML line into balanced chunks <= maxLen code points without dropping characters
function splitHtmlLine(line, maxLen = 4000) {
  if (getCodePointLength(line) <= maxLen) {
    return [line];
  }

  const tokens = tokenizeHtml(line);
  const chunks = [];
  let currentChunk = '';
  let currentLen = 0;
  const openTags = []; // stack of { name, tag }

  function getCloseStr() {
    return openTags.slice().reverse().map(t => '</' + t.name + '>').join('');
  }
  function getReopenStr() {
    return openTags.map(t => t.tag).join('');
  }

  function flush(closeActive = true) {
    if (!currentChunk) return;
    let finalChunk = currentChunk;
    if (closeActive && openTags.length > 0) {
      finalChunk += getCloseStr();
    }
    if (finalChunk.trim().length > 0) {
      chunks.push(finalChunk);
    }
    currentChunk = closeActive && openTags.length > 0 ? getReopenStr() : '';
    currentLen = getCodePointLength(currentChunk);
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'text') {
      let remainingText = tok.value;
      while (remainingText.length > 0) {
        const closeCost = getCodePointLength(getCloseStr());
        const available = maxLen - currentLen - closeCost;
        const pts = Array.from(remainingText);

        if (pts.length <= available) {
          currentChunk += remainingText;
          currentLen += pts.length;
          remainingText = '';
        } else {
          if (available <= 0) {
            flush(true);
            continue;
          }
          let splitIdx = available;
          let spaceIdx = -1;
          const searchStart = Math.max(0, splitIdx - 100);
          for (let s = splitIdx - 1; s >= searchStart; s--) {
            if (pts[s] === ' ') {
              spaceIdx = s;
              break;
            }
          }
          if (spaceIdx > 0) {
            splitIdx = spaceIdx + 1;
          }
          const takeText = pts.slice(0, splitIdx).join('');
          currentChunk += takeText;
          currentLen += getCodePointLength(takeText);
          remainingText = pts.slice(splitIdx).join('');
          flush(true);
        }
      }
    } else {
      const tokPoints = getCodePointLength(tok.value);
      const closeCost = getCodePointLength(getCloseStr());

      if (currentLen + tokPoints + closeCost > maxLen && currentChunk.length > 0) {
        flush(true);
      }

      currentChunk += tok.value;
      currentLen += tokPoints;

      if (tok.type === 'openTag') {
        openTags.push({ name: tok.name, tag: tok.value });
      } else if (tok.type === 'closeTag') {
        const idx = openTags.map(t => t.name).lastIndexOf(tok.name);
        if (idx !== -1) {
          openTags.splice(idx, 1);
        }
      }
    }
  }

  if (currentChunk.length > 0) {
    if (openTags.length > 0) {
      currentChunk += getCloseStr();
    }
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk);
    }
  }

  return chunks.filter(c => c && c.length > 0);
}

// Split rich markdown by Unicode code points (Telegram Bot API limit: conservative default 30000)
// Preserves code blocks (closing and reopening fences with language), structure, and prevents empty chunks
function splitRichMarkdown(md, maxLen = 30000) {
  if (!md) return [];
  const totalLen = getCodePointLength(md);
  if (totalLen <= maxLen) {
    return md.length > 0 ? [md] : [];
  }

  const rawLines = md.split('\n');
  const chunks = [];
  let currentLines = [];
  let currentLen = 0;
  let inCodeBlock = false;
  let codeLang = '';
  let fenceChars = '```';

  const flushChunk = () => {
    if (currentLines.length === 0) return;
    if (inCodeBlock) {
      currentLines.push(fenceChars);
    }
    const chunkText = currentLines.join('\n');
    if (chunkText.trim().length > 0) {
      chunks.push(chunkText);
    }
    currentLines = [];
    currentLen = 0;
    if (inCodeBlock) {
      const openTag = `${fenceChars}${codeLang}`;
      currentLines.push(openTag);
      currentLen = getCodePointLength(openTag) + 1;
    }
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const fenceMatch = line.match(/^(`{3,})([a-zA-Z0-9_-]*)/);

    // Single line exceeds maxLen
    const linePoints = getCodePointLength(line);
    if (linePoints > maxLen) {
      flushChunk();
      const subLines = splitLongLine(line, maxLen - 50, inCodeBlock);
      for (let s = 0; s < subLines.length; s++) {
        const sub = subLines[s];
        const subLen = getCodePointLength(sub) + 1;
        if (currentLen + subLen > maxLen && currentLines.length > 0) {
          flushChunk();
        }
        currentLines.push(sub);
        currentLen += subLen;
      }
      if (fenceMatch) {
        if (inCodeBlock) {
          inCodeBlock = false;
          codeLang = '';
          fenceChars = '```';
        } else {
          inCodeBlock = true;
          fenceChars = fenceMatch[1];
          codeLang = fenceMatch[2] || '';
        }
      }
      continue;
    }

    const lineLen = linePoints + 1;

    if (currentLen + lineLen > maxLen && currentLines.length > 0) {
      flushChunk();
    }

    if (fenceMatch) {
      if (inCodeBlock) {
        inCodeBlock = false;
        codeLang = '';
        fenceChars = '```';
      } else {
        inCodeBlock = true;
        fenceChars = fenceMatch[1];
        codeLang = fenceMatch[2] || '';
      }
    }

    currentLines.push(line);
    currentLen += lineLen;
  }

  if (currentLines.length > 0) {
    const remainingText = currentLines.join('\n');
    if (remainingText.trim().length > 0) {
      chunks.push(remainingText);
    }
  }

  return chunks.filter(c => c && c.length > 0);
}

// Classification of Telegram API & network errors:
// A. Definitive Rejection: Telegram returned an HTTP 4xx status (e.g. 400 Bad Request, 403 Forbidden, 404, 422).
//    The server definitively rejected the request; it was NOT delivered or posted.
// B. Ambiguous Transport Failure: Timeout, connection reset, socket hangup, or 5xx proxy error.
//    We cannot determine whether Telegram received and posted the message. Do NOT duplicate-send!
function classifyTelegramError(err) {
  if (!err) {
    return { isDefinitive: false, isAmbiguous: false, category: 'UNKNOWN' };
  }

  const errorCode = err.error_code || (typeof err.status === 'number' ? err.status : null);

  // Rate limit 429 rejection (definitive refusal with retry wait)
  if (errorCode === 429) {
    return {
      isDefinitive: true,
      isAmbiguous: false,
      isRateLimit: true,
      category: 'RATE_LIMIT',
      errorCode: 429,
      retryAfter: err.retry_after || 5,
      description: err.description || err.message
    };
  }

  // Definitive 4xx client rejections from Telegram API
  if (errorCode && errorCode >= 400 && errorCode < 500) {
    return {
      isDefinitive: true,
      isAmbiguous: false,
      category: 'DEFINITIVE_REJECTION',
      errorCode,
      description: err.description || err.message
    };
  }

  // Ambiguous Transport Failures
  const msg = String(err.message || '').toLowerCase();
  const name = String(err.name || '').toLowerCase();
  const causeCode = err.cause && err.cause.code ? String(err.cause.code).toUpperCase() : '';

  const isTimeout =
    name === 'aborterror' ||
    name === 'timeouterror' ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'ESOCKETTIMEDOUT' ||
    causeCode === 'UND_ERR_CONNECT_TIMEOUT';

  const isConnReset =
    causeCode === 'ECONNRESET' ||
    causeCode === 'ECONNABORTED' ||
    causeCode === 'EPIPE' ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset');

  const isNetworkFailure =
    msg.includes('fetch failed') ||
    causeCode === 'ENOTFOUND' ||
    causeCode === 'EAI_AGAIN' ||
    causeCode === 'ENETUNREACH';

  const isServerTransport5xx = errorCode && (errorCode === 500 || errorCode === 502 || errorCode === 503 || errorCode === 504);

  if (isTimeout || isConnReset || isNetworkFailure || isServerTransport5xx) {
    return {
      isDefinitive: false,
      isAmbiguous: true,
      category: 'AMBIGUOUS_TRANSPORT',
      reason: isTimeout ? 'TIMEOUT' : isConnReset ? 'CONN_RESET' : isServerTransport5xx ? `HTTP_${errorCode}` : 'NETWORK_FAILURE',
      description: err.description || err.message
    };
  }

  // Default safely to ambiguous to prevent duplicate sends
  return {
    isDefinitive: false,
    isAmbiguous: true,
    category: 'AMBIGUOUS_TRANSPORT',
    reason: 'UNKNOWN_TRANSPORT',
    description: err.message
  };
}

function isDefinitiveRichMessageRejection(err) {
  return classifyTelegramError(err).isDefinitive;
}

function isAmbiguousTransportFailure(err) {
  return classifyTelegramError(err).isAmbiguous;
}

// Send Native Telegram Bot API 10.1+ Rich Message (rich_message.markdown)
async function sendRichMessageNative(chatId, rawMarkdown, options = {}) {
  const text = String(rawMarkdown || '');
  const threadOpt = options.message_thread_id ? { message_thread_id: options.message_thread_id } : {};
  const chunks = splitRichMarkdown(text, 30000);

  const sendSingleChunk = async (chunkText, replyMarkup) => {
    const payload = {
      chat_id: chatId,
      rich_message: {
        markdown: chunkText
      },
      ...threadOpt
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    return await tgRequest('sendRichMessage', payload);
  };

  let lastRes = null;
  const MAX_429_RETRIES = 2;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunkText = chunks[i];
    const markup = isLast ? options.reply_markup : undefined;

    // Respect active cooldown from previous chunk or parallel call
    if (telegramRateLimitState.isCoolingDown()) {
      const waitMs = telegramRateLimitState.getRemainingWaitMs();
      console.warn(`[RATE-LIMIT] Menunggu cooldown Telegram ${Math.ceil(waitMs / 1000)}s sebelum mengirim chunk [${i + 1}/${chunks.length}]...`);
      await sleepWithAbort(waitMs, options.abortSignal);
    } else if (i > 0) {
      // Pacing antar-chunk untuk mencegah Telegram 429 flood control
      await sleepWithAbort(800, options.abortSignal);
    }

    let chunkSent = false;
    let retries429 = 0;
    let retriesNetwork = 0;

    while (!chunkSent) {
      try {
        lastRes = await sendSingleChunk(chunkText, markup);
        chunkSent = true;
      } catch (err) {
        const errClass = classifyTelegramError(err);

        // 1. Penanganan khusus HTTP 429 Too Many Requests (retry_after)
        if (errClass.isRateLimit) {
          telegramRateLimitState.setCooldown(errClass.retryAfter || 5);
          if (retries429 < MAX_429_RETRIES) {
            retries429++;
            const waitMs = telegramRateLimitState.getRemainingWaitMs();
            console.warn(
              `[RATE-LIMIT] Telegram 429 diterima pada chunk [${i + 1}/${chunks.length}]. Menunggu cooldown ${Math.ceil(waitMs / 1000)}s (percobaan ${retries429}/${MAX_429_RETRIES})...`
            );
            await sleepWithAbort(waitMs, options.abortSignal);
            continue; // coba kirim ulang chunk ini
          }

          // Kuota retry 429 telah habis! JANGAN fallback ke sendMessage selama rate limit masih aktif!
          console.error(
            `[RATE-LIMIT-EXHAUSTED] Kuota retry HTTP 429 habis (${retries429}/${MAX_429_RETRIES}). Menghentikan pengiriman untuk mencegah request berulang ke Telegram.`
          );
          const exhaustedErr = new Error(`Telegram rate limit (HTTP 429) berlanjut setelah ${MAX_429_RETRIES}x percobaan retry.`);
          exhaustedErr.isRateLimitExhausted = true;
          exhaustedErr.error_code = 429;
          exhaustedErr.retry_after = errClass.retryAfter || 5;
          exhaustedErr.classification = errClass;
          throw exhaustedErr;
        }

        // 2. Definitive rejection (4xx client error selain 429, misal 400 Bad Request):
        if (errClass.isDefinitive) {
          console.warn(
            `sendRichMessage native definitively rejected (code ${errClass.errorCode}: ${errClass.description}). Falling back safely to chunked legacy delivery...`
          );
          const remainingText = chunks.slice(i).join('\n\n');
          return await sendFallbackChunked(chatId, remainingText, {
            ...options,
            reply_markup: markup
          });
        }

        // 3. Ambiguous Transport Failure (timeout, socket hangup, ETIMEDOUT, 5xx):
        // Do NOT execute fallback to prevent sending duplicate answers!
        console.error(
          `sendRichMessage failed with ambiguous transport failure (${errClass.reason}: ${err.message}). Suppressing duplicate-send fallback.`
        );
        err.isAmbiguousTransport = true;
        err.classification = errClass;
        throw err;
      }
    }
  }

  return lastRes;
}

// Execute resumable partial delivery with persistent state transitions in sessions.json
async function executeResumableDelivery(session, chatId, options = {}) {
  const pd = session.pendingDelivery;
  if (!pd || !Array.isArray(pd.chunks) || pd.chunks.length === 0) {
    return { ok: false, message: 'Tidak ada pengiriman pesan yang tertunda.' };
  }

  if (pd.status === 'completed') {
    return { ok: true, message: 'Pengiriman pesan sudah selesai sebelumnya.', deliveredCount: pd.deliveredCount, skippedCount: pd.skippedCount || 0 };
  }

  const threadOpt = options.message_thread_id ? { message_thread_id: options.message_thread_id } : {};
  const chunks = pd.chunks;
  const replyMarkup = options.reply_markup || pd.replyMarkup || undefined;
  const MAX_429_RETRIES = 2;

  // Normalisasi chunkStatuses dan skippedCount jika belum terinisialisasi
  if (!Array.isArray(pd.chunkStatuses) || pd.chunkStatuses.length !== chunks.length) {
    pd.chunkStatuses = new Array(chunks.length).fill('pending');
    for (let idx = 0; idx < (pd.deliveredCount || 0); idx++) {
      pd.chunkStatuses[idx] = 'delivered';
    }
  }
  if (typeof pd.skippedCount !== 'number') {
    pd.skippedCount = pd.chunkStatuses.filter(s => s === 'skipped_unknown').length;
  }

  // Cek apakah chunk saat ini unknown dan membutuhkan konfirmasi eksplisit dari pengguna
  if (pd.currentChunkStatus === 'unknown' && !options.forceUnknown && !options.skipUnknown) {
    const unknownIdx = pd.currentChunkIndex >= 0 ? pd.currentChunkIndex : pd.deliveredCount;
    return {
      ok: false,
      needsConfirmation: true,
      unknownIndex: unknownIdx,
      deliveredCount: pd.deliveredCount || 0,
      skippedCount: pd.skippedCount || 0,
      totalChunks: chunks.length,
      message: `⚠️ <b>Konfirmasi Pengiriman Ulang:</b>\nBagian ke-${unknownIdx + 1} dari ${chunks.length} berstatus unknown akibat kendala koneksi sebelumnya.`
    };
  }

  // Tangani skip unknown chunk secara eksplisit
  if (options.skipUnknown && pd.currentChunkStatus === 'unknown') {
    const unknownIdx = pd.currentChunkIndex >= 0 ? pd.currentChunkIndex : pd.deliveredCount;
    if (unknownIdx < chunks.length) {
      pd.chunkStatuses[unknownIdx] = 'skipped_unknown';
    }
    pd.skippedCount = (pd.skippedCount || 0) + 1;
    pd.currentChunkStatus = 'skipped_unknown';
    pd.updatedAt = Date.now();

    // Cek apakah chunk terakhir yang dilewati menyelesaikan seluruh pengiriman
    const isAllResolved = ((pd.deliveredCount || 0) + pd.skippedCount) >= chunks.length;
    if (isAllResolved) {
      pd.status = 'completed';
      if (!saveSessions()) {
        throw new Error('Gagal menyimpan status completed setelah skip unknown.');
      }
      const backupPd = { ...pd };
      session.pendingDelivery = null;
      if (!saveSessions()) {
        session.pendingDelivery = backupPd;
        throw new Error('Gagal membersihkan pending delivery setelah completed (state di-rollback).');
      }
      return {
        ok: true,
        completed: true,
        deliveredCount: pd.deliveredCount,
        skippedCount: pd.skippedCount,
        totalChunks: chunks.length,
        message: 'Chunk unknown dilewati. Seluruh pengiriman selesai.'
      };
    }

    pd.currentChunkIndex = unknownIdx + 1;
    pd.currentChunkStatus = 'pending';
    pd.status = 'in_progress';
    if (!saveSessions()) {
      throw new Error('Gagal menyimpan transisi state skip unknown ke sessions.json.');
    }
  }

  // Tangani force unknown retry
  if (options.forceUnknown && pd.currentChunkStatus === 'unknown') {
    const unknownIdx = pd.currentChunkIndex >= 0 ? pd.currentChunkIndex : pd.deliveredCount;
    if (unknownIdx < chunks.length) {
      pd.chunkStatuses[unknownIdx] = 'pending';
    }
    pd.currentChunkStatus = 'pending';
    pd.status = 'in_progress';
    pd.updatedAt = Date.now();
    if (!saveSessions()) {
      throw new Error('Gagal menyimpan transisi force retry unknown ke sessions.json.');
    }
  }

  pd.status = 'in_progress';
  pd.updatedAt = Date.now();
  if (!saveSessions()) {
    throw new Error('Gagal menyimpan status in_progress ke sessions.json.');
  }

  let lastRes = null;

  for (let i = 0; i < chunks.length; i++) {
    // Lewati chunk yang sudah berstatus 'delivered' atau 'skipped_unknown'
    if (pd.chunkStatuses[i] === 'delivered' || pd.chunkStatuses[i] === 'skipped_unknown') {
      continue;
    }

    const isLast = (i === chunks.length - 1);
    const chunkText = chunks[i];
    const markup = isLast ? replyMarkup : undefined;

    // Hormati rate limit cooldown Telegram
    if (telegramRateLimitState.isCoolingDown()) {
      const waitMs = telegramRateLimitState.getRemainingWaitMs();
      console.warn(`[RATE-LIMIT] Menunggu cooldown Telegram ${Math.ceil(waitMs / 1000)}s sebelum mengirim chunk [${i + 1}/${chunks.length}]...`);
      await sleepWithAbort(waitMs, options.abortSignal);
    } else if (i > 0 && pd.deliveredCount > 0) {
      await sleepWithAbort(800, options.abortSignal);
    }

    // 1. Strict Persistence Barrier: Simpan status sending SEBELUM request HTTP ke Telegram
    pd.currentChunkIndex = i;
    pd.currentChunkStatus = 'sending';
    pd.chunkStatuses[i] = 'sending';
    pd.status = 'in_progress';
    pd.updatedAt = Date.now();
    if (!saveSessions()) {
      pd.currentChunkStatus = 'pending';
      pd.chunkStatuses[i] = 'pending';
      pd.status = 'paused_error';
      pd.lastError = `Persistence barrier failure: gagal menyimpan status sending chunk [${i + 1}/${chunks.length}]`;
      throw new Error(pd.lastError);
    }

    let chunkSent = false;
    let retries429 = 0;
    let retriesNetwork = 0;

    while (!chunkSent) {
      try {
        const payload = {
          chat_id: chatId,
          rich_message: { markdown: chunkText },
          ...threadOpt
        };
        if (markup) payload.reply_markup = markup;

        lastRes = await tgRequest('sendRichMessage', payload);
        chunkSent = true;

        // 2. Tandai delivered setelah Telegram memberikan konfirmasi sukses (ACK)
        pd.currentChunkStatus = 'delivered';
        pd.chunkStatuses[i] = 'delivered';
        pd.deliveredCount = (pd.deliveredCount || 0) + 1;
        pd.lastError = null;
        pd.updatedAt = Date.now();

        const isAllResolved = ((pd.deliveredCount || 0) + (pd.skippedCount || 0)) >= chunks.length;
        if (isAllResolved) {
          pd.status = 'completed';
        }
        if (!saveSessions()) {
          throw new Error(`Gagal menyimpan status delivered chunk [${i + 1}/${chunks.length}] ke sessions.json`);
        }
      } catch (err) {
        const errClass = classifyTelegramError(err);

        // A. HTTP 429 Too Many Requests
        if (errClass.isRateLimit) {
          telegramRateLimitState.setCooldown(errClass.retryAfter || 5);
          if (retries429 < MAX_429_RETRIES) {
            retries429++;
            const waitMs = telegramRateLimitState.getRemainingWaitMs();
            console.warn(
              `[RATE-LIMIT] Telegram 429 diterima pada chunk [${i + 1}/${chunks.length}]. Menunggu cooldown ${Math.ceil(waitMs / 1000)}s (percobaan ${retries429}/${MAX_429_RETRIES})...`
            );
            await sleepWithAbort(waitMs, options.abortSignal);
            continue;
          }

          // Retry habis
          pd.currentChunkStatus = 'rejected';
          pd.chunkStatuses[i] = 'rejected';
          pd.status = 'paused_rate_limit';
          pd.lastError = `Rate limit 429 berlanjut setelah ${MAX_429_RETRIES}x retry: ${err.message}`;
          pd.updatedAt = Date.now();
          saveSessions();

          const exhaustedErr = new Error(`Telegram rate limit (HTTP 429) berlanjut setelah ${MAX_429_RETRIES}x percobaan retry.`);
          exhaustedErr.isRateLimitExhausted = true;
          exhaustedErr.error_code = 429;
          exhaustedErr.retry_after = errClass.retryAfter || 5;
          exhaustedErr.classification = errClass;
          throw exhaustedErr;
        }

        // B. Definitive Rejection (4xx selain 429, misal 400 Bad Request)
        if (errClass.isDefinitive) {
          console.warn(`sendRichMessage native definitively rejected (code ${errClass.errorCode}: ${errClass.description}). Mencoba fallback chunked legacy...`);
          try {
            lastRes = await sendRichMessageLegacy(chatId, chunkText, {
              ...options,
              reply_markup: markup,
              ...threadOpt
            });
            chunkSent = true;
            pd.currentChunkStatus = 'delivered';
            pd.chunkStatuses[i] = 'delivered';
            pd.deliveredCount = (pd.deliveredCount || 0) + 1;
            pd.lastError = null;
            pd.updatedAt = Date.now();
            const isAllResolved = ((pd.deliveredCount || 0) + (pd.skippedCount || 0)) >= chunks.length;
            if (isAllResolved) {
              pd.status = 'completed';
            }
            if (!saveSessions()) {
              throw new Error(`Gagal menyimpan status delivered legacy chunk [${i + 1}/${chunks.length}] ke sessions.json`);
            }
            break;
          } catch (legacyErr) {
            pd.currentChunkStatus = 'rejected';
            pd.chunkStatuses[i] = 'rejected';
            pd.status = 'paused_error';
            pd.lastError = legacyErr.message;
            pd.updatedAt = Date.now();
            saveSessions();
            throw legacyErr;
          }
        }

        // C. Ambiguous Transport Failure (Timeout / Connection Reset / 5xx)
        if (errClass.isAmbiguous) {
          retriesNetwork++;
          if (retriesNetwork <= 3) {
            console.warn(
              `[NETWORK-RETRY] Ambiguous transport error on chunk [${i + 1}/${chunks.length}]: ${err.message}. Retrying in ${retriesNetwork * 1500}ms (attempt ${retriesNetwork}/3)...`
            );
            await sleepWithAbort(retriesNetwork * 1500, options.abortSignal);
            continue;
          }
        }
        console.error(`sendRichMessage failed with ambiguous transport failure (${errClass.reason}: ${err.message}). Menandai status unknown.`);
        pd.currentChunkStatus = 'unknown';
        pd.chunkStatuses[i] = 'unknown';
        pd.status = 'paused_unknown';
        pd.lastError = err.message;
        pd.updatedAt = Date.now();
        saveSessions();

        err.isAmbiguousTransport = true;
        err.classification = errClass;
        throw err;
      }
    }
  }

  // 4. Completed State Persistence & Cleanup with In-Memory Rollback
  if (pd.status === 'completed') {
    const backupPd = { ...pd };
    session.pendingDelivery = null;
    if (!saveSessions()) {
      session.pendingDelivery = backupPd;
      throw new Error('Gagal membersihkan pending delivery setelah completed (state di-rollback).');
    }
  }

  return {
    ok: true,
    deliveredCount: pd.deliveredCount,
    skippedCount: pd.skippedCount || 0,
    totalChunks: chunks.length,
    lastRes
  };
}

// Send Rich Message Legacy using Telegram Bot API sendMessage + HTML
async function sendRichMessageLegacy(chatId, docOrMarkdown, options = {}) {
  let richDoc;
  if (typeof docOrMarkdown === 'string') {
    richDoc = markdownToRichDoc(docOrMarkdown);
  } else {
    richDoc = docOrMarkdown;
  }

  const telegramHtml = toTelegramHTML(richDoc);
  const CHUNK_SIZE = 4000;
  const threadOpt = options.message_thread_id ? { message_thread_id: options.message_thread_id } : {};

  if (getCodePointLength(telegramHtml) <= CHUNK_SIZE) {
    try {
      return await tgRequest('sendMessage', {
        chat_id: chatId,
        text: telegramHtml,
        parse_mode: 'HTML',
        reply_markup: options.reply_markup,
        ...threadOpt
      });
    } catch (err) {
      console.warn('sendMessage HTML failed, trying fallback plain text:', err.message);
      return await tgRequest('sendMessage', {
        chat_id: chatId,
        text: stripTelegramTags(telegramHtml),
        reply_markup: options.reply_markup,
        ...threadOpt
      });
    }
  } else {
    // Potong per paragraf / baris jika pesan panjang
    const chunks = [];
    let cur = '';
    const rawParagraphs = telegramHtml.split('\n\n');
    for (const p of rawParagraphs) {
      if (getCodePointLength(p) > CHUNK_SIZE) {
        if (cur) { chunks.push(cur); cur = ''; }
        const lines = p.split('\n');
        for (const l of lines) {
          if (getCodePointLength(l) > CHUNK_SIZE) {
            if (cur) { chunks.push(cur); cur = ''; }
            const subChunks = splitHtmlLine(l, CHUNK_SIZE);
            for (let scIdx = 0; scIdx < subChunks.length; scIdx++) {
              if (scIdx === subChunks.length - 1) {
                cur = subChunks[scIdx];
              } else {
                chunks.push(subChunks[scIdx]);
              }
            }
          } else if (getCodePointLength(cur ? `${cur}\n${l}` : l) > CHUNK_SIZE) {
            if (cur) chunks.push(cur);
            cur = l;
          } else {
            cur = cur ? `${cur}\n${l}` : l;
          }
        }
      } else if (getCodePointLength(cur ? `${cur}\n\n${p}` : p) > CHUNK_SIZE) {
        if (cur) chunks.push(cur);
        cur = p;
      } else {
        cur = cur ? `${cur}\n\n${p}` : p;
      }
    }
    if (cur) chunks.push(cur);

    // Balance open tags across chunks so code blocks and styles continue seamlessly
    const balancedChunks = [];
    let openTags = [];
    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i];
      if (openTags.length > 0) {
        chunk = openTags.map(t => `<${t}>`).join('') + chunk;
      }
      const tagMatches = chunk.match(/<\/?([a-zA-Z0-9_-]+)[^>]*>/g) || [];
      const currentStack = [];
      for (const tag of tagMatches) {
        const isClosing = tag.startsWith('</');
        const nameMatch = tag.match(/^<\/?([a-zA-Z0-9_-]+)/);
        const name = nameMatch ? nameMatch[1].toLowerCase() : '';
        if (!VALID_TELEGRAM_TAGS.has(name)) continue;
        if (!isClosing) {
          currentStack.push(name);
        } else {
          const idx = currentStack.lastIndexOf(name);
          if (idx !== -1) currentStack.splice(idx, 1);
        }
      }
      openTags = [...currentStack];
      balancedChunks.push(sanitizeTelegramHtml(chunk));
    }

    let lastRes = null;
    for (let i = 0; i < balancedChunks.length; i++) {
      if (telegramRateLimitState.isCoolingDown()) {
        await sleepWithAbort(telegramRateLimitState.getRemainingWaitMs(), options.abortSignal);
      } else if (i > 0) {
        await sleepWithAbort(600, options.abortSignal);
      }
      const isLast = i === balancedChunks.length - 1;
      const chunkHtml = balancedChunks[i];
      try {
        lastRes = await tgRequest('sendMessage', {
          chat_id: chatId,
          text: chunkHtml,
          parse_mode: 'HTML',
          reply_markup: isLast ? options.reply_markup : undefined,
          ...threadOpt
        });
      } catch (err) {
        console.warn('sendMessage chunk HTML failed, trying fallback plain text:', err.message);
        lastRes = await tgRequest('sendMessage', {
          chat_id: chatId,
          text: stripTelegramTags(chunkHtml),
          reply_markup: isLast ? options.reply_markup : undefined,
          ...threadOpt
        });
      }
    }
    return lastRes;
  }
}

// Send fallback chunked delivery when native rich message fails definitively
async function sendFallbackChunked(chatId, rawMarkdown, options = {}) {
  const text = String(rawMarkdown || '');
  if (!text) return null;

  // Split into conservative chunks fitting sendMessage limit (<= 4000 code points)
  // splitRichMarkdown ensures valid fenced code blocks, preserved newlines, and no empty chunks
  const chunks = splitRichMarkdown(text, 4000);
  const threadOpt = options.message_thread_id ? { message_thread_id: options.message_thread_id } : {};
  let lastRes = null;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunkText = chunks[i];
    const markup = isLast ? options.reply_markup : undefined;

    if (telegramRateLimitState.isCoolingDown()) {
      await sleepWithAbort(telegramRateLimitState.getRemainingWaitMs(), options.abortSignal);
    } else if (i > 0) {
      await sleepWithAbort(800, options.abortSignal);
    }

    try {
      lastRes = await sendRichMessageLegacy(chatId, chunkText, {
        ...options,
        reply_markup: markup
      });
    } catch (err) {
      console.error(`[FALLBACK-CHUNK-ERROR] Failed to send fallback chunk ${i + 1}/${chunks.length}:`, err.message);
      // If at least one chunk succeeded, notify user of partial delivery without re-sending all chunks
      if (i > 0) {
        try {
          if (!telegramRateLimitState.isCoolingDown()) {
            await tgRequest('sendMessage', {
              chat_id: chatId,
              text: `⚠️ <i>Pesan terhenti di bagian ${i + 1} dari ${chunks.length} karena kendala koneksi Telegram (${escapeHtml(err.message)}).</i>`,
              parse_mode: 'HTML',
              ...threadOpt
            });
          }
        } catch (_) {}
      }
      throw err;
    }
  }

  return lastRes;
}

// Preserve legacy naming for existing UI menus/dashboards
const sendRichMessage = sendRichMessageLegacy;
const sendRich = sendRichMessageLegacy;

// Edit message helper supporting native rich_message parameter (Telegram Bot API 10.1+)
async function editRichMessageNative(chatId, messageId, rawMarkdown, options = {}) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    rich_message: {
      markdown: rawMarkdown
    },
    ...(options.reply_markup ? { reply_markup: options.reply_markup } : {})
  };
  return await tgRequest('editMessageText', payload);
}

// Edit existing message using Telegram HTML
async function editRich(chatId, messageId, docOrHtml, options = {}) {
  let richDoc;
  if (typeof docOrHtml === 'string') {
    richDoc = markdownToRichDoc(docOrHtml);
  } else {
    richDoc = docOrHtml;
  }

  const telegramHtml = toTelegramHTML(richDoc);

  try {
    return await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: telegramHtml,
      parse_mode: 'HTML',
      reply_markup: options.reply_markup
    });
  } catch (err) {
    if (err.message && (
      err.message.includes('message is not modified') ||
      err.message.includes('message to edit not found')
    )) {
      return null;
    }
    console.warn('editRich HTML failed, trying fallback plain text:', err.message);
    try {
      return await tgRequest('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: stripTelegramTags(telegramHtml),
        reply_markup: options.reply_markup
      });
    } catch (fallbackErr) {
      if (fallbackErr.message && (
        fallbackErr.message.includes('message is not modified') ||
        fallbackErr.message.includes('message to edit not found')
      )) {
        return null;
      }
      console.error('editRich fallback failed:', fallbackErr.message);
    }
  }
}

// Send file/document from server to Telegram
async function sendDocument(chatId, filePath, caption = '', threadId = null) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File tidak ditemukan: ${filePath}`);
  }
  const stats = fs.statSync(filePath);
  if (stats.size > 50 * 1024 * 1024) {
    throw new Error('Ukuran file melebihi batas 50MB Telegram.');
  }

  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([fileBuffer]), fileName);

  const res = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: 'POST',
    body: form
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Gagal mengirim dokumen');
  return data.result;
}

// Send photo to Telegram
async function sendPhoto(chatId, filePathOrBuffer, caption = '', threadId = null) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  const fileBuffer = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : fs.readFileSync(filePathOrBuffer);
  form.append('photo', new Blob([fileBuffer]), 'preview.png');

  const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Gagal mengirim foto');
  return data.result;
}

// Send voice note to Telegram
async function sendVoice(chatId, filePath, caption = '', threadId = null) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  const fileBuffer = fs.readFileSync(filePath);
  form.append('voice', new Blob([fileBuffer]), 'voice.mp3');

  const res = await fetch(`${TELEGRAM_API}/sendVoice`, {
    method: 'POST',
    body: form
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Gagal mengirim voice note');
  return data.result;
}

// Download file uploaded by user
async function downloadTelegramFile(fileId, destDir, originalName) {
  const fileInfo = await tgRequest('getFile', { file_id: fileId });
  const downloadUrl = `${TELEGRAM_FILE_API}/${fileInfo.file_path}`;
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} saat mengunduh file.`);
  
  const buffer = Buffer.from(await res.arrayBuffer());
  const fileName = originalName || path.basename(fileInfo.file_path);
  const targetPath = path.join(destDir, fileName);
  fs.writeFileSync(targetPath, buffer);
  return { path: targetPath, size: buffer.length, name: fileName };
}

// Text to Speech using edge-tts (Natural Indonesian Voice)
async function generateSpeech(text, voice = 'id-ID-ArdiNeural') {
  let cleanText = text
    .replace(/<pre[\s\S]*?<\/pre>/gi, '')
    .replace(/<code[\s\S]*?<\/code>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, 'link web')
    .replace(/[#*`_~]/g, '')
    .trim();

  if (cleanText.length > 300) {
    const periodIdx = cleanText.indexOf('.', 200);
    if (periodIdx !== -1 && periodIdx < 350) {
      cleanText = cleanText.slice(0, periodIdx + 1);
    } else {
      cleanText = cleanText.slice(0, 300) + '...';
    }
  }

  if (!cleanText) cleanText = 'Perintah berhasil diselesaikan.';

  const outPath = `/tmp/tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
  await new Promise((resolve, reject) => {
    execFile('edge-tts', ['--text', cleanText, '--write-media', outPath, '--voice', voice], (err) => {
      if (err) reject(err);
      else resolve(outPath);
    });
  });
  return { path: outPath, text: cleanText };
}

// Keyboards and Rich UI Views
// Session History & Resume Helpers
function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.slice(0, 16);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month} ${hours}:${minutes}`;
  } catch (_) {
    return isoStr.slice(0, 16);
  }
}

function getRecentConversations(limit = 6) {
  try {
    const dbPath = path.join(process.env.HOME || '/home/ubuntu', '.gemini/antigravity-cli/conversation_summaries.db');
    if (!fs.existsSync(dbPath)) return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time 
        FROM conversation_summaries 
        WHERE nesting_depth = 0
        ORDER BY last_modified_time DESC 
        LIMIT ?
      `).all(limit);
      return rows;
    } finally {
      db.close();
    }
  } catch (e) {
    console.error('getRecentConversations error:', e);
    return [];
  }
}

function findConversation(search) {
  if (!search) return null;
  const q = String(search).trim();
  const recent = getRecentConversations(10);
  if (/^[1-9]\d*$/.test(q)) {
    const idx = parseInt(q, 10) - 1;
    if (recent[idx]) return recent[idx];
  }
  if (q.toLowerCase() === 'latest' || q.toLowerCase() === 'last') {
    return recent[0] || null;
  }

  const dbPath = path.join(process.env.HOME || '/home/ubuntu', '.gemini/antigravity-cli/conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return null;

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // 1. Exact match on conversation_id
      let row = db.prepare('SELECT conversation_id, title, preview, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id = ?').get(q);
      if (row) return row;

      // 2. Prefix match on conversation_id
      row = db.prepare('SELECT conversation_id, title, preview, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id LIKE ? ORDER BY last_modified_time DESC LIMIT 1').get(`${q}%`);
      if (row) return row;

      // 3. Substring match on title or preview
      row = db.prepare('SELECT conversation_id, title, preview, step_count, last_modified_time FROM conversation_summaries WHERE nesting_depth = 0 AND (title LIKE ? OR preview LIKE ?) ORDER BY last_modified_time DESC LIMIT 1').get(`%${q}%`, `%${q}%`);
      return row || null;
    } finally {
      db.close();
    }
  } catch (e) {
    console.error('findConversation error:', e);
    return null;
  }
}

function buildResumeView(currentConvId) {
  const recent = getRecentConversations(6);
  if (recent.length === 0) {
    const doc = tgRich.doc(
      tgRich.heading(2, '▶️ Resume Sesi Percakapan'),
      tgRich.paragraph('Belum ada riwayat sesi percakapan yang tersimpan di sistem.'),
      tgRich.divider()
    );
    const keyboard = {
      inline_keyboard: [
        [{ text: '« Kembali ke Dashboard', callback_data: 'view:status' }]
      ]
    };
    return { doc, keyboard };
  }

  const tableRows = [
    [{ content: 'No', header: true }, { content: 'Judul Sesi', header: true }, { content: 'Waktu', header: true }]
  ];

  recent.forEach((c, idx) => {
    const isActive = c.conversation_id === currentConvId;
    const numStr = `${idx + 1}${isActive ? ' 🟢' : ''}`;
    const titleStr = c.title || c.preview || c.conversation_id.slice(0, 8);
    const truncatedTitle = titleStr.length > 22 ? titleStr.slice(0, 19) + '...' : titleStr;
    const timeStr = formatTime(c.last_modified_time);
    tableRows.push([
      { content: numStr },
      { content: truncatedTitle },
      { content: timeStr }
    ]);
  });

  const richDoc = tgRich.doc(
    tgRich.heading(2, '▶️ Riwayat & Resume Sesi Percakapan'),
    tgRich.table(tableRows, { bordered: true }),
    tgRich.blockquote('Klik salah satu tombol sesi di bawah untuk melanjutkan, atau ketik /resume <nomor|ID|keyword>.'),
    tgRich.divider()
  );

  const keyboardRows = [];
  for (let i = 0; i < recent.length; i += 2) {
    const row = [];
    const c1 = recent[i];
    const isC1 = c1.conversation_id === currentConvId;
    const title1 = c1.title || c1.preview || c1.conversation_id.slice(0, 8);
    const label1 = `${isC1 ? '✅ ' : ''}${i + 1}. ${title1.slice(0, 14)}`;
    row.push({
      text: label1,
      callback_data: `resume:${c1.conversation_id}`
    });

    if (i + 1 < recent.length) {
      const c2 = recent[i + 1];
      const isC2 = c2.conversation_id === currentConvId;
      const title2 = c2.title || c2.preview || c2.conversation_id.slice(0, 8);
      const label2 = `${isC2 ? '✅ ' : ''}${i + 2}. ${title2.slice(0, 14)}`;
      row.push({
        text: label2,
        callback_data: `resume:${c2.conversation_id}`
      });
    }
    keyboardRows.push(row);
  }

  keyboardRows.push([
    { text: '⚡ Lanjutkan Terakhir', callback_data: 'resume:latest' },
    { text: '🔄 Reset Sesi', callback_data: 'action:reset' }
  ]);
  keyboardRows.push([
    { text: '« Kembali ke Dashboard', callback_data: 'view:status' }
  ]);

  return { doc: richDoc, keyboard: { inline_keyboard: keyboardRows } };
}

function buildResumeConfirmation(conv) {
  const titleStr = conv.title || '(Tanpa Judul)';
  const richDoc = tgRich.doc(
    tgRich.heading(2, '✅ Sesi Berhasil Dilanjutkan!'),
    tgRich.table([
      [{ content: 'Properti', header: true }, { content: 'Detail', header: true }],
      [{ content: 'Judul' }, { content: tgRich.bold(titleStr) }],
      [{ content: 'ID Sesi' }, { content: tgRich.code(conv.conversation_id) }],
      [{ content: 'Langkah' }, { content: `${conv.step_count || 0} langkah` }],
      [{ content: 'Terakhir' }, { content: formatTime(conv.last_modified_time) }]
    ], { bordered: true }),
    tgRich.blockquote(conv.preview ? `Preview: ${conv.preview}` : 'Memori sesi ini telah aktif. Ketik pesan Anda untuk melanjutkan diskusi.'),
    tgRich.divider()
  );

  const keyboard = {
    inline_keyboard: [
      [
        { text: '⚙️ Buka Dashboard', callback_data: 'view:status' },
        { text: '▶️ Pilih Sesi Lain', callback_data: 'view:resume' }
      ],
      [
        { text: '🔄 Reset Sesi', callback_data: 'action:reset' }
      ]
    ]
  };

  return { doc: richDoc, keyboard };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safePre(text, lang = 'bash') {
  return tgRich.pre(String(text ?? '').trim() || '(kosong)', lang);
}

function cleanParam(val) {
  if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"') && val.length > 1) {
    try { return JSON.parse(val); } catch (_) {}
  }
  return val;
}

function isGitRepository(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  let cur = path.resolve(dir);
  while (cur) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      return true;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

function getConversationLogs(convId, maxTools = 10) {
  if (!convId) return [];
  const transPath = path.join(process.env.HOME || '/home/ubuntu', '.gemini/antigravity-cli/brain', convId, '.system_generated/logs/transcript.jsonl');
  if (!fs.existsSync(transPath)) return [];
  try {
    const lines = fs.readFileSync(transPath, 'utf8').trim().split('\n');
    const toolSteps = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const data = JSON.parse(lines[i]);
        if (data.tool_calls && Array.isArray(data.tool_calls)) {
          for (const tc of data.tool_calls) {
            toolSteps.push({
              step: data.step_index,
              time: data.created_at,
              name: tc.name,
              args: tc.args || {},
              output: null
            });
          }
        }
        if (data.type === 'GENERIC' && data.content && toolSteps.length > 0) {
          const last = toolSteps[toolSteps.length - 1];
          if (last && !last.output) {
            last.output = data.content;
          }
        }
      } catch (_) {}
    }
    return toolSteps.slice(-maxTools);
  } catch (err) {
    console.error('getConversationLogs error:', err);
    return [];
  }
}

async function getBotServiceLogs(lines = 30) {
  try {
    const res = await executeShell(`journalctl -u agy-telegram -n ${lines} --no-pager`);
    if (res.output && res.output !== '(No output)') {
      return res.output;
    }
  } catch (_) {}
  const logFile = path.join(__dirname, 'bot.log');
  if (fs.existsSync(logFile)) {
    const content = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    return content.slice(-lines).join('\n') || '(Log file kosong)';
  }
  return '(Tidak ada catatan log ditemukan)';
}

function buildLogsMenuView(session) {
  const convId = session.conversationId;
  const shortId = convId ? convId.slice(0, 8) : '(Belum ada sesi)';
  const lastToolCount = (session.lastTurn?.tools || session.lastTools || []).length;

  const doc = tgRich.doc(
    tgRich.heading(2, '📜 AGY Logs Hub'),
    tgRich.table([
      [{ content: 'Kategori Log', header: true }, { content: 'Status / Detail', header: true }],
      [{ content: '💬 Sesi Aktif' }, { content: tgRich.code(shortId) }],
      [{ content: '⚡ Aksi Turn Terakhir' }, { content: `${lastToolCount} tool/kode` }],
      [{ content: '🖥️ Status Service' }, { content: 'Active (systemd)' }]
    ], { bordered: true }),
    tgRich.blockquote('Pilih kategori log di bawah untuk meninjau perintah kode yang dijalankan atau riwayat service bot.'),
    tgRich.divider()
  );

  const keyboard = {
    inline_keyboard: [
      [
        { text: `⚡ Log Kode Terakhir (${lastToolCount})`, callback_data: 'view:turn_logs' }
      ],
      [
        { text: '📋 Log Sesi Lengkap (Transcript)', callback_data: 'view:conv_logs' }
      ],
      [
        { text: '🖥️ Log Bot Service (Systemd)', callback_data: 'view:bot_logs' }
      ],
      [
        { text: '⚙️ Buka Dashboard', callback_data: 'view:status' }
      ]
    ]
  };

  return { doc, keyboard };
}

function buildCodeLogsView(tools, convId, meta = {}) {
  if (!tools || tools.length === 0) {
    const doc = tgRich.doc(
      tgRich.heading(2, '📜 Logs Eksekusi Kode'),
      tgRich.paragraph('Tidak ada kode atau perintah tool yang dijalankan pada turn ini.'),
      tgRich.blockquote('Agent memberikan jawaban langsung tanpa memanggil tool eksekusi.'),
      tgRich.divider()
    );
    return {
      doc,
      keyboard: {
        inline_keyboard: [
          [{ text: '« Kembali ke Respons', callback_data: 'view:last_response' }],
          [{ text: '📋 Log Sesi Lengkap', callback_data: 'view:conv_logs' }],
          [{ text: '⚙️ Dashboard', callback_data: 'view:status' }]
        ]
      }
    };
  }

  const blocks = [
    tgRich.heading(2, '📜 Logs Eksekusi Kode & Tool'),
    tgRich.table([
      [{ content: 'Total Aksi', header: true }, { content: 'Durasi', header: true }, { content: 'Sesi', header: true }],
      [{ content: `${tools.length} tool` }, { content: `${meta.duration ? Number(meta.duration).toFixed(1) : '0'}s` }, { content: tgRich.code((convId || '').slice(0, 8) || '-') }]
    ], { bordered: true }),
    tgRich.blockquote('Berikut rincian kode, perintah terminal, dan aksi yang dieksekusi agent:')
  ];

  const displayTools = tools.slice(-5);
  for (let i = 0; i < displayTools.length; i++) {
    const t = displayTools[i];
    const name = t.name || 'tool';
    const num = tools.length > 5 ? (tools.length - 5 + i + 1) : (i + 1);

    if (name === 'run_command') {
      let cmd = cleanParam(t.params?.CommandLine || t.parameters?.CommandLine || '');
      let summary = cleanParam(t.params?.toolSummary || t.parameters?.toolSummary || '');
      let out = t.output || '';
      if (out.length > 400) out = out.slice(0, 380) + '\n... (output dipotong)';

      const title = summary ? `${num}. ⚡ Terminal: ${summary}` : `${num}. ⚡ run_command`;
      blocks.push(
        tgRich.heading(3, title),
        safePre(cmd, 'bash')
      );
      if (out.trim()) {
        blocks.push(safePre(out.trim(), 'bash'));
      }
    } else if (name === 'edit_file' || name === 'write_file') {
      let filePath = cleanParam(t.params?.Path || t.parameters?.Path || '');
      const icon = name === 'edit_file' ? '✏️' : '📝';
      blocks.push(
        tgRich.heading(3, `${num}. ${icon} ${name}: ${path.basename(String(filePath || '')) || filePath}`),
        tgRich.code(String(filePath || ''))
      );
    } else if (name === 'read_file') {
      let filePath = cleanParam(t.params?.Path || t.parameters?.Path || '');
      blocks.push(
        tgRich.heading(3, `${num}. 📖 read_file: ${path.basename(String(filePath || '')) || filePath}`),
        tgRich.code(String(filePath || ''))
      );
    } else {
      blocks.push(
        tgRich.heading(3, `${num}. 🛠️ ${name}`),
        tgRich.code(JSON.stringify(t.params || t.parameters || {}).slice(0, 150))
      );
    }
  }

  blocks.push(tgRich.divider());

  const keyboard = {
    inline_keyboard: [
      [
        { text: '« Kembali ke Respons', callback_data: 'view:last_response' },
        { text: '📋 Log Sesi Lengkap', callback_data: 'view:conv_logs' }
      ],
      [
        { text: '🖥️ Log Bot Service', callback_data: 'view:bot_logs' },
        { text: '⚙️ Dashboard', callback_data: 'view:status' }
      ]
    ]
  };

  return { doc: tgRich.doc(...blocks), keyboard };
}

function buildConvLogsView(logs, convId) {
  if (!logs || logs.length === 0) {
    const doc = tgRich.doc(
      tgRich.heading(2, '📋 Log Sesi Lengkap'),
      tgRich.paragraph('Belum ada catatan eksekusi tool/kode pada sesi percakapan ini.'),
      tgRich.divider()
    );
    return {
      doc,
      keyboard: {
        inline_keyboard: [
          [{ text: '« Hub Log', callback_data: 'view:logs' }],
          [{ text: '⚙️ Dashboard', callback_data: 'view:status' }]
        ]
      }
    };
  }

  const blocks = [
    tgRich.heading(2, '📋 Log Riwayat Sesi (Transcript)'),
    tgRich.table([
      [{ content: 'Sesi' }, { content: tgRich.code((convId || '').slice(0, 8)) }],
      [{ content: 'Total Langkah' }, { content: `${logs.length} aksi terekam` }]
    ], { bordered: true }),
    tgRich.blockquote('Daftar perintah terminal dan manipulasi file dari percakapan aktif:')
  ];

  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    const name = l.name;
    const timeStr = formatTime(l.time);

    if (name === 'run_command') {
      let cmd = cleanParam(l.args?.CommandLine || '');
      let summary = cleanParam(l.args?.toolSummary || '');
      blocks.push(
        tgRich.heading(3, `${i + 1}. ⚡ run_command (${timeStr})`),
        safePre(cmd, 'bash')
      );
      if (summary) {
        blocks.push(tgRich.blockquote(`Tujuan: ${summary}`));
      }
    } else if (name === 'edit_file' || name === 'write_file') {
      let p = cleanParam(l.args?.Path || '');
      blocks.push(
        tgRich.heading(3, `${i + 1}. 📝 ${name} (${timeStr})`),
        tgRich.code(String(p || ''))
      );
    } else {
      blocks.push(
        tgRich.heading(3, `${i + 1}. 🛠️ ${name} (${timeStr})`),
        tgRich.code(JSON.stringify(l.args || {}).slice(0, 150))
      );
    }
  }

  blocks.push(tgRich.divider());

  const keyboard = {
    inline_keyboard: [
      [
        { text: '⚡ Log Turn Terakhir', callback_data: 'view:turn_logs' },
        { text: '🖥️ Log Bot Service', callback_data: 'view:bot_logs' }
      ],
      [
        { text: '« Hub Log', callback_data: 'view:logs' },
        { text: '⚙️ Dashboard', callback_data: 'view:status' }
      ]
    ]
  };

  return { doc: tgRich.doc(...blocks), keyboard };
}

function buildBotLogsView(logsText) {
  let displayLogs = logsText || '(Log kosong)';
  if (displayLogs.length > 2500) {
    displayLogs = displayLogs.slice(-2500);
  }

  const doc = tgRich.doc(
    tgRich.heading(2, '🖥️ Systemd Bot Service Logs'),
    tgRich.blockquote('Output log langsung dari service `agy-telegram`:'),
    safePre(displayLogs, 'bash'),
    tgRich.divider()
  );

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh Log Service', callback_data: 'view:bot_logs' },
        { text: '⚡ Log Kode Terakhir', callback_data: 'view:turn_logs' }
      ],
      [
        { text: '« Hub Log', callback_data: 'view:logs' },
        { text: '⚙️ Dashboard', callback_data: 'view:status' }
      ]
    ]
  };

  return { doc, keyboard };
}

function buildUsageView() {
  const u = get9RouterUsage();
  const ag = getAgyAccountsUsage();

  const blocks = [
    tgRich.heading(2, '📊 Ringkasan Penggunaan AI (Overview)')
  ];

  if (u) {
    blocks.push(
      tgRich.heading(3, '🌐 9Router Gateway:'),
      tgRich.table([
        [{ content: 'Request Hari Ini' }, { content: tgRich.bold(String(u.today.requests)) }],
        [{ content: 'Total Tokens' }, { content: Number(u.today.promptTokens + u.today.completionTokens).toLocaleString() }],
        [{ content: 'Biaya Hari Ini' }, { content: tgRich.code(`$${Number(u.today.cost).toFixed(4)}`) }]
      ], { bordered: true })
    );
  }

  if (ag) {
    const cacheResult = loadCache(DEFAULT_CACHE_PATH, DEFAULT_CACHE_TTL_MS);
    blocks.push(
      tgRich.heading(3, '🔑 AGY Google Multi-Auth:'),
      buildUsageOverviewSection(cacheResult, ag)
    );
  }

  blocks.push(tgRich.blockquote('Pilih tombol di bawah untuk melihat detail statistik masing-masing:'));

  return {
    doc: tgRich.doc(...blocks),
    keyboard: {
      inline_keyboard: [
        [
          { text: '🌐 Detail 9Router (/9usage)', callback_data: 'view:9usage' },
          { text: '🔑 Detail Akun AGY (/agusage)', callback_data: 'view:agusage' }
        ],
        [{ text: '« Kembali ke Dashboard', callback_data: 'view:status' }]
      ]
    }
  };
}

function build9UsageView() {
  const u = get9RouterUsage();
  if (!u) {
    return {
      doc: tgRich.doc(tgRich.paragraph('❌ <i>Database statistik 9Router tidak ditemukan atau kosong.</i>')),
      keyboard: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'view:usage' }]] }
    };
  }
  const t = u.today;
  const reqFormatted = Number(t.requests).toLocaleString();
  const promptFormatted = Number(t.promptTokens).toLocaleString();
  const compFormatted = Number(t.completionTokens).toLocaleString();
  const costFormatted = `$${Number(t.cost).toFixed(4)}`;

  const modelsList = Object.entries(t.byModel).map(([k, v]) => {
    const name = k.split('|')[0];
    return `• <code>${escapeHtml(name)}</code>: ${v.requests} req (${Number(v.promptTokens + v.completionTokens).toLocaleString()} tok)`;
  }).slice(0, 5).join('\n') || '<i>(Tidak ada aktivitas model hari ini)</i>';

  const doc = tgRich.doc(
    tgRich.heading(2, '🌐 9Router Usage Analytics'),
    tgRich.blockquote(`Periode: ${u.latestDate}`),
    tgRich.table([
      [{ content: 'Total Request' }, { content: tgRich.bold(reqFormatted) }],
      [{ content: 'Prompt Tokens' }, { content: promptFormatted }],
      [{ content: 'Completion Tokens' }, { content: compFormatted }],
      [{ content: 'Estimasi Biaya' }, { content: tgRich.code(costFormatted) }]
    ], { bordered: true }),
    tgRich.heading(3, 'Top Model Digunakan:'),
    tgRich.paragraph(modelsList),
    tgRich.blockquote(`7 Hari Terakhir: ${Number(u.sevenDays.requests).toLocaleString()} req • $${Number(u.sevenDays.cost).toFixed(2)} total`)
  );

  return {
    doc,
    keyboard: {
      inline_keyboard: [
        [{ text: '🔑 Lihat Akun AGY (/agusage)', callback_data: 'view:agusage' }],
        [{ text: '« Ringkasan (/usage)', callback_data: 'view:usage' }]
      ]
    }
  };
}

function buildAgUsageView() {
  const ag = getAgyAccountsUsage();
  return buildAgUsageRichView({
    activeSlot: ag ? ag.activeSlot : '1'
  });
}

function buildDashboardView(session, userId) {
  const modelStr = session.model ? session.model : 'Default Sistem';
  const effortStr = session.effort ? session.effort.toUpperCase() : 'Default';
  const modeStr = session.mode;

  let convStr = '(Belum aktif)';
  if (session.conversationId) {
    const activeConv = findConversation(session.conversationId);
    const shortId = session.conversationId.slice(0, 8);
    if (activeConv && activeConv.title) {
      const truncatedTitle = activeConv.title.length > 18 ? activeConv.title.slice(0, 15) + '...' : activeConv.title;
      convStr = `${shortId} (${truncatedTitle})`;
    } else {
      convStr = `${shortId}...`;
    }
  }

  const docElements = [
    tgRich.heading(2, '🚀 AGY Dashboard (Bot API 10.3)'),
    tgRich.table([
      [{ content: 'Pengaturan', header: true }, { content: 'Nilai Aktif', header: true }],
      [{ content: '🧠 Model' }, { content: tgRich.code(modelStr) }],
      [{ content: '⚡ Effort' }, { content: tgRich.bold(effortStr) }],
      [{ content: '🎯 Mode' }, { content: tgRich.code(modeStr) }],
      [{ content: '🎙️ Voice Reply' }, { content: session.voiceReply ? tgRich.bold('AKTIF (ON)') : 'NONAKTIF' }],
      [{ content: '📂 Folder' }, { content: tgRich.code(session.workingDir) }],
      [{ content: '💬 Sesi' }, { content: tgRich.code(convStr) }]
    ], { bordered: true })
  ];

  if (session.pendingDelivery && session.pendingDelivery.status !== 'completed') {
    const pd = session.pendingDelivery;
    const skippedTxt = pd.skippedCount > 0 ? `, ${pd.skippedCount} dilewati` : '';
    docElements.push(
      tgRich.blockquote(`⚠️ <b>Pengiriman Tertunda:</b> Terdapat jawaban belum lengkap (${pd.deliveredCount}/${pd.chunks.length} bagian${skippedTxt}). Gunakan tombol di bawah atau ketik <code>/retry_delivery</code>.`)
    );
  }

  docElements.push(
    tgRich.blockquote('Gunakan tombol di bawah untuk mengubah pengaturan atau ketik instruksi coding Anda langsung.'),
    tgRich.divider()
  );

  const richDoc = tgRich.doc(...docElements);

  const keyboardRows = [
    [
      { text: '🧠 Ganti Model', callback_data: 'view:models' },
      { text: '⚡ Ganti Effort', callback_data: 'view:effort' }
    ],
    [
      { text: '🎯 Mode Agent', callback_data: 'view:mode' },
      { text: session.voiceReply ? '🎙️ Voice: ON' : '🎙️ Voice: OFF', callback_data: 'toggle:voice' }
    ],
    [
      { text: '📊 Usage Analytics', callback_data: 'view:usage' },
      { text: '▶️ Resume Sesi', callback_data: 'view:resume' }
    ],
    [
      { text: '📜 Logs Kode', callback_data: 'view:logs' },
      { text: '📂 Lihat File Folder', callback_data: 'action:ls' }
    ],
    [
      { text: '🔄 Reset Sesi', callback_data: 'action:reset' },
      { text: '🔄 Refresh Status', callback_data: 'view:status' }
    ]
  ];

  if (session.pendingDelivery && session.pendingDelivery.status !== 'completed') {
    const pd = session.pendingDelivery;
    keyboardRows.unshift([
      { text: `🔄 Lanjutkan Pengiriman (${pd.deliveredCount}/${pd.chunks.length} Bagian)`, callback_data: 'action:retry_delivery' }
    ]);
  }

  const keyboard = { inline_keyboard: keyboardRows };

  return { doc: richDoc, keyboard };
}

function getModelsKeyboard(currentModel) {
  const models = [
    { id: 'gemini-3.8-flash-high', name: '⚡ Gemini 3.8 Flash' },
    { id: 'gemini-4-argon-high', name: '💎 Gemini 4 Argon' },
    { id: 'claude-sonnet-5-5-high', name: '🚀 Claude Sonnet 5.5' },
    { id: 'claude-opus-5-5-high', name: '👑 Claude Opus 5.5' },
    { id: 'gpt-oss-120b-medium', name: '🤖 GPT-OSS 120B' },
    { id: 'default', name: '⚪ Default Sistem' }
  ];

  const rows = [];
  for (let i = 0; i < models.length; i += 2) {
    const row = [];
    const m1 = models[i];
    const isM1 = (m1.id === 'default' && !currentModel) || (m1.id === currentModel);
    row.push({
      text: `${isM1 ? '✅ ' : ''}${m1.name}`,
      callback_data: `set_model:${m1.id}`
    });

    if (i + 1 < models.length) {
      const m2 = models[i + 1];
      const isM2 = (m2.id === 'default' && !currentModel) || (m2.id === currentModel);
      row.push({
        text: `${isM2 ? '✅ ' : ''}${m2.name}`,
        callback_data: `set_model:${m2.id}`
      });
    }
    rows.push(row);
  }

  rows.push([{ text: '« Kembali ke Dashboard', callback_data: 'view:status' }]);
  return { inline_keyboard: rows };
}

function getEffortKeyboard(currentEffort) {
  const efforts = [
    { id: 'low', name: '🟢 Low (Cepat)' },
    { id: 'medium', name: '🟡 Medium (Seimbang)' },
    { id: 'high', name: '🔴 High (Mendalam)' },
    { id: 'max', name: '🟣 Max (Maksimal)' },
    { id: 'default', name: '⚪ Default Sistem' }
  ];

  const rows = [];
  for (let i = 0; i < efforts.length; i += 2) {
    const row = [];
    const e1 = efforts[i];
    const isE1 = (e1.id === 'default' && !currentEffort) || (e1.id === currentEffort);
    row.push({
      text: `${isE1 ? '✅ ' : ''}${e1.name}`,
      callback_data: `set_effort:${e1.id}`
    });

    if (i + 1 < efforts.length) {
      const e2 = efforts[i + 1];
      const isE2 = (e2.id === 'default' && !currentEffort) || (e2.id === currentEffort);
      row.push({
        text: `${isE2 ? '✅ ' : ''}${e2.name}`,
        callback_data: `set_effort:${e2.id}`
      });
    }
    rows.push(row);
  }

  rows.push([{ text: '« Kembali ke Dashboard', callback_data: 'view:status' }]);
  return { inline_keyboard: rows };
}

function getModeKeyboard(currentMode) {
  const modes = [
    { id: 'auto', name: '🚀 Auto (Otonom)' },
    { id: 'plan', name: '📋 Plan (Rencana)' },
    { id: 'accept-edits', name: '✏️ Accept-Edits' }
  ];

  const rows = modes.map(m => [{
    text: `${m.id === currentMode ? '✅ ' : ''}${m.name}`,
    callback_data: `set_mode:${m.id}`
  }]);

  rows.push([{ text: '« Kembali ke Dashboard', callback_data: 'view:status' }]);
  return { inline_keyboard: rows };
}

// Execute agy CLI turn with streaming tool tracking
function runAgy(prompt, session, onProgress = null, sessionKey = null, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions'
    ];

    if (session.conversationId) args.push('--conversation', session.conversationId);
    if (session.mode) args.push('--mode', session.mode);
    if (session.model) args.push('--model', session.model);
    if (session.effort) args.push('--effort', session.effort);
    if (session.agent) args.push('--agent', session.agent);

    args.push('-p', prompt);

    const cwd = session.workingDir && fs.existsSync(session.workingDir)
      ? session.workingDir
      : DEFAULT_DIR;

    const child = spawn(AGY_PATH, args, {
      cwd,
      env: { ...process.env, HOME: '/home/ubuntu' }
    });

    const abortController = options.abortController || new AbortController();
    let procEntry = null;
    if (sessionKey) {
      procEntry = {
        child,
        sessionKey,
        abortController,
        startTime: Date.now(),
        stopping: false,
        killTimer: null,
        cancel: () => {
          if (procEntry) procEntry.stopping = true;
          try {
            abortController.abort();
          } catch (_) {}
          try {
            child.kill('SIGINT');
          } catch (_) {}
          const killTimer = setTimeout(() => {
            try {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
              }
            } catch (_) {}
          }, 3000);
          if (killTimer.unref) killTimer.unref();
          if (procEntry) procEntry.killTimer = killTimer;
        }
      };
      activeProcesses.set(sessionKey, procEntry);
    }

    let stdoutBuffer = '';
    let stderr = '';
    const executedTools = [];
    let finalResult = null;

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const ev = data.event;

          if (ev === 'init') {
            if (data.conversation_id) {
              session.conversationId = data.conversation_id;
              saveSessions();
            }
          } else if (ev === 'step_update') {
            const su = data.step_update || {};
            if (su.step_type === 'tool') {
              const toolName = su.tool_name || su.tool_info?.name || 'tool';
              if (su.state === 'ACTIVE') {
                const entry = {
                  name: toolName,
                  params: su.tool_info?.parameters || {},
                  status: 'running',
                  output: null,
                  duration: null,
                  startTime: Date.now()
                };
                executedTools.push(entry);
                if (onProgress) onProgress({
                  event: 'tool_start',
                  tool: entry,
                  tools: executedTools,
                  lastLog: `Menjalankan ${toolName}...`
                });
              } else if (su.state === 'DONE') {
                let outputSnippet = null;
                if (su.tool_info?.output) {
                  const outStr = typeof su.tool_info.output === 'string'
                    ? su.tool_info.output
                    : JSON.stringify(su.tool_info.output);
                  outputSnippet = outStr.trim().split('\n')[0].slice(0, 80);
                }
                const last = executedTools.slice().reverse().find(t => t.name === toolName && t.status === 'running');
                if (last) {
                  last.status = 'done';
                  if (su.tool_info?.output) last.output = su.tool_info.output;
                  if (su.duration_seconds) last.duration = su.duration_seconds;
                } else {
                  executedTools.push({
                    name: toolName,
                    params: su.tool_info?.parameters || {},
                    status: 'done',
                    output: su.tool_info?.output || null,
                    duration: su.duration_seconds || null,
                    startTime: Date.now()
                  });
                }
                if (onProgress) onProgress({
                  event: 'tool_done',
                  tool: last || executedTools[executedTools.length - 1],
                  tools: executedTools,
                  lastLog: outputSnippet || `Selesai ${toolName}`
                });
              }
            } else if (su.step_type === 'agent_response') {
              const thoughtText = su.content || su.text || su.thought || '';
              if (onProgress) onProgress({
                event: 'thinking',
                text: thoughtText,
                tools: executedTools,
                lastLog: thoughtText ? (thoughtText.length > 100 ? thoughtText.slice(0, 100) + '…' : thoughtText) : null
              });
            }
          } else if (ev === 'result') {
            finalResult = data.result;
            if (finalResult.conversation_id) {
              session.conversationId = finalResult.conversation_id;
              saveSessions();
            }
          }
        } catch (_) {
          const trimmed = line.trim();
          if (trimmed && onProgress) {
            onProgress({
              event: 'log',
              text: trimmed,
              tools: executedTools,
              lastLog: trimmed
            });
          }
        }
      }
    });

    child.stderr.on('data', d => {
      const str = d.toString();
      stderr += str;
      const errLines = str.trim().split('\n').filter(Boolean);
      if (errLines.length > 0 && onProgress) {
        const lastLine = errLines[errLines.length - 1].trim();
        if (lastLine) {
          onProgress({
            event: 'stderr',
            text: lastLine,
            tools: executedTools,
            lastLog: lastLine
          });
        }
      }
    });

    child.on('close', code => {
      if (stdoutBuffer && stdoutBuffer.trim()) {
        try {
          const data = JSON.parse(stdoutBuffer.trim());
          if (data.event === 'result') {
            finalResult = data.result;
          }
        } catch (_) {}
      }

      if (procEntry && procEntry.killTimer) {
        clearTimeout(procEntry.killTimer);
        procEntry.killTimer = null;
      }

      if (sessionKey && activeProcesses.get(sessionKey)?.child === child) {
        activeProcesses.delete(sessionKey);
      }

      if (child.killed) {
        reject(new Error('🛑 Eksekusi dibatalkan oleh pengguna.'));
        return;
      }

      if (finalResult) {
        if (finalResult.conversation_id) {
          session.conversationId = finalResult.conversation_id;
          saveSessions();
        }
        resolve({
          response: finalResult.response || '(No response text returned)',
          tools: executedTools,
          duration: finalResult.duration_seconds || 0,
          usage: finalResult.usage || null,
          conversationId: session.conversationId
        });
      } else {
        if (code !== 0) {
          if (isQuotaExhaustedError(stderr)) {
            rotateToNextHealthySlot('quota').then(rotateRes => {
              console.log(`[Auto-Failover] Quota exhausted: rotated to Slot ${rotateRes.slot}`);
            }).catch(() => {});
            reject(new Error(`⏳ <b>Batas Kuota / Rate Limit Terdeteksi!</b>\nGiliran otomatis dialihkan ke akun PRO berikutnya.\n\n<i>Silakan kirim ulang prompt Anda untuk melanjutkan dengan kuota segar.</i>`));
            return;
          }
          reject(new Error(`agy exited with code ${code}.\n${stderr}`));
        } else {
          resolve({
            response: stderr || '(Done with no output)',
            tools: executedTools,
            duration: 0,
            usage: null,
            conversationId: session.conversationId
          });
        }
      }
    });

    child.on('error', err => {
      if (procEntry && procEntry.killTimer) {
        clearTimeout(procEntry.killTimer);
        procEntry.killTimer = null;
      }
      if (sessionKey && activeProcesses.get(sessionKey)?.child === child) {
        activeProcesses.delete(sessionKey);
      }
      reject(err);
    });
  });
}

// Shell executor
function executeShell(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: cwd || DEFAULT_DIR,
      env: { ...process.env, HOME: '/home/ubuntu' },
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr ? (stdout ? '\n' : '') + stderr : '');
      resolve({
        success: !err,
        code: err ? (err.code || 1) : 0,
        output: output.trim() || '(No output)'
      });
    });
  });
}

// Callback Query Handler (Inline Keyboard)
async function handleCallback(cb) {
  const queryId = cb.id;
  const data = cb.data || '';
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const userId = String(cb.from?.id);

  let isCallbackAnswered = false;
  const safeAnswer = async (text = '', alert = false) => {
    if (isCallbackAnswered) return;
    isCallbackAnswered = true;
    await answerCallbackQuery(queryId, text, alert);
  };

  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    await safeAnswer('⛔ Akses ditolak.', true);
    return;
  }

  const isGroup = cb.message?.chat?.type === 'group' || cb.message?.chat?.type === 'supergroup';
  const threadId = cb.message?.message_thread_id || null;
  const sessionKey = isGroup ? `topic:${chatId}:${threadId}` : userId;
  const session = getSession(sessionKey);

  // 0. Action Stop / Cancel
  if (data.startsWith('action:stop')) {
    const parts = data.split(':');
    const targetKey = parts.length > 2 ? parts.slice(2).join(':') : sessionKey;
    if (activeProcesses.has(targetKey)) {
      const proc = activeProcesses.get(targetKey);
      proc.cancel();
      await answerCallbackQuery(queryId, '🛑 Proses dihentikan!', true);
      try {
        await editRich(chatId, messageId, '🛑 <b>Eksekusi AGY dibatalkan oleh pengguna.</b>');
      } catch (_) {}
    } else {
      await answerCallbackQuery(queryId, 'ℹ️ Tidak ada proses aktif.', false);
    }
    return;
  }

  // 0.1 Action Retry Delivery & Discard (Resumable Partial Delivery)
  if (data.startsWith('action:retry_delivery')) {
    const pd = session.pendingDelivery;
    if (!pd || pd.status === 'completed') {
      await answerCallbackQuery(queryId, 'ℹ️ Tidak ada pengiriman jawaban yang tertunda.', true);
      return;
    }

    if (data === 'action:retry_delivery_discard') {
      await answerCallbackQuery(queryId, '⚠️ Konfirmasi pembuangan');
      try {
        await editRich(chatId, messageId,
          `⚠️ <b>Konfirmasi Pembuangan Jawaban Tertunda:</b>\n\n` +
          `Apakah Anda yakin ingin membuang sisa jawaban yang belum terkirim (${pd.deliveredCount || 0}/${pd.chunks?.length || 0} bagian)? Tindakan ini tidak dapat dibatalkan.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🗑️ Ya, Buang Jawaban Ini', callback_data: 'action:retry_delivery_discard_confirm' },
                  { text: '❌ Batal', callback_data: 'action:retry_delivery_discard_cancel' }
                ]
              ]
            }
          }
        );
      } catch (_) {}
      return;
    }

    if (data === 'action:retry_delivery_discard_confirm') {
      session.pendingDelivery = null;
      saveSessions();
      await answerCallbackQuery(queryId, '🗑️ Jawaban tertunda telah dibuang.');
      try {
        await editRich(chatId, messageId, '🗑️ <b>Jawaban tertunda telah dihapus.</b> Anda sekarang dapat mengirimkan instruksi baru.');
      } catch (_) {}
      return;
    }

    if (data === 'action:retry_delivery_discard_cancel') {
      await answerCallbackQuery(queryId, 'Dibatalkan');
      const deliv = pd ? pd.deliveredCount || 0 : 0;
      const tot = pd ? pd.chunks?.length || 0 : 0;
      try {
        await editRich(chatId, messageId,
          `ℹ️ Pembuangan dibatalkan. Jawaban tetap tersimpan. Gunakan <code>/retry_delivery</code> untuk melanjutkan.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: `🔄 Lanjutkan Pengiriman (${deliv}/${tot})`, callback_data: 'action:retry_delivery' }]
              ]
            }
          }
        );
      } catch (_) {}
      return;
    }

    if (data === 'action:retry_delivery_cancel') {
      await answerCallbackQuery(queryId, '🛑 Pengiriman dibatalkan.');
      try {
        await editRich(chatId, messageId, '🛑 <b>Pengiriman jawaban dibatalkan.</b> Gunakan <code>/retry_delivery</code> kapan saja jika ingin melanjutkan.');
      } catch (_) {}
      return;
    }

    const force = data === 'action:retry_delivery_force';
    const skip = data === 'action:retry_delivery_skip';
    await answerCallbackQuery(queryId, '⏳ Melanjutkan pengiriman jawaban...');

    try {
      const res = await executeResumableDelivery(session, chatId, {
        message_thread_id: threadId,
        forceUnknown: force,
        skipUnknown: skip
      });
      if (res && res.ok) {
        const skippedTxt = res.skippedCount > 0 ? ` (${res.skippedCount} dilewati)` : '';
        try {
          await editRich(chatId, messageId, `✅ <b>Pengiriman Selesai!</b> Seluruh <b>${res.totalChunks || res.deliveredCount}</b> bagian jawaban telah diproses${skippedTxt}.`);
        } catch (_) {}
      }
    } catch (err) {
      const waitSec = Math.ceil(telegramRateLimitState.getRemainingWaitMs() / 1000) || 5;
      const errClass = classifyTelegramError(err);
      let errMsg = `❌ Pengiriman tertunda: ${err.message}`;
      if (errClass.isRateLimit || err.isRateLimitExhausted) {
        errMsg = `⚠️ Rate limit Telegram (HTTP 429) masih aktif (${waitSec}s). Silakan gunakan /retry_delivery beberapa saat lagi.`;
      }
      try {
        await editRich(chatId, messageId, errMsg, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Coba Lagi', callback_data: 'action:retry_delivery' }],
              [{ text: '🗑️ Buang Jawaban Lama', callback_data: 'action:retry_delivery_discard' }]
            ]
          }
        });
      } catch (_) {}
    }
    return;
  }

  // 1. Dashboard View
  if (data === 'view:status') {
    const view = buildDashboardView(session, userId);
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    await answerCallbackQuery(queryId, 'Dashboard diperbarui');
    return;
  }

  // 1.1 Toggle Voice Reply
  if (data === 'toggle:voice') {
    session.voiceReply = !session.voiceReply;
    saveSessions();
    await answerCallbackQuery(queryId, `🎙️ Voice Reply: ${session.voiceReply ? 'ON' : 'OFF'}`);
    const view = buildDashboardView(session, userId);
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 1.2 View Usage (Combined)
  if (data === 'view:usage') {
    const view = buildUsageView();
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    await answerCallbackQuery(queryId);
    return;
  }

  // 1.3 View 9Usage
  if (data === 'view:9usage') {
    const view = build9UsageView();
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    await answerCallbackQuery(queryId);
    return;
  }

  // 1.4 View AgUsage
  if (data === 'view:agusage') {
    const view = buildAgUsageView();
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    await answerCallbackQuery(queryId);
    return;
  }

  // 1.5 Action Unwatch
  if (data.startsWith('action:unwatch:')) {
    const id = parseInt(data.split(':')[2], 10);
    if (activeWatchers.has(id)) {
      clearInterval(activeWatchers.get(id).timer);
      activeWatchers.delete(id);
      await answerCallbackQuery(queryId, `Watcher #${id} dihentikan!`);
      await editRich(chatId, messageId, `✅ Watcher #${id} berhasil dihentikan.`);
    } else {
      await answerCallbackQuery(queryId, 'Watcher tidak ditemukan.');
    }
    return;
  }

  // 1.2 View Usage Overview
  if (data === 'view:usage') {
    const u = get9RouterUsage();
    const ag = getAgyAccountsUsage();

    const blocks = [
      tgRich.heading(2, '📊 Ringkasan Penggunaan AI (Overview)')
    ];

    if (u) {
      blocks.push(
        tgRich.heading(3, '🌐 9Router Gateway:'),
        tgRich.table([
          [{ content: 'Request Hari Ini' }, { content: tgRich.bold(String(u.today.requests)) }],
          [{ content: 'Total Tokens' }, { content: Number(u.today.promptTokens + u.today.completionTokens).toLocaleString() }],
          [{ content: 'Biaya Hari Ini' }, { content: tgRich.code(`$${Number(u.today.cost).toFixed(4)}`) }]
        ], { bordered: true })
      );
    }

    if (ag) {
      blocks.push(
        tgRich.heading(3, '🔑 AGY Google Multi-Auth:'),
        tgRich.table([
          [{ content: 'Total Akun Google' }, { content: `${ag.total} akun (${ag.proCount} PRO)` }],
          [{ content: 'Slot Aktif' }, { content: `Slot ${ag.activeSlot} 🟢` }],
          [{ content: 'Status Rotasi' }, { content: `${ag.rotations}x putaran` }]
        ], { bordered: true })
      );
    }

    blocks.push(tgRich.blockquote('Pilih tombol di bawah untuk melihat detail statistik masing-masing:'));

    const richDoc = tgRich.doc(...blocks);
    await editRich(chatId, messageId, richDoc, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🌐 Detail 9Router', callback_data: 'view:9usage' },
            { text: '🔑 Detail Akun AGY', callback_data: 'view:agusage' }
          ],
          [{ text: '« Kembali ke Dashboard', callback_data: 'view:status' }]
        ]
      }
    });
    await answerCallbackQuery(queryId);
    return;
  }

  // 1.3 View 9Router Usage Detail
  if (data === 'view:9usage') {
    const u = get9RouterUsage();
    if (!u) {
      await answerCallbackQuery(queryId, 'Data 9Router kosong.', true);
      return;
    }
    const t = u.today;
    const reqFormatted = Number(t.requests).toLocaleString();
    const promptFormatted = Number(t.promptTokens).toLocaleString();
    const compFormatted = Number(t.completionTokens).toLocaleString();
    const costFormatted = `$${Number(t.cost).toFixed(4)}`;

    const modelsList = Object.entries(t.byModel).map(([k, v]) => {
      const name = k.split('|')[0];
      return `• <code>${escapeHtml(name)}</code>: ${v.requests} req (${Number(v.promptTokens + v.completionTokens).toLocaleString()} tok)`;
    }).slice(0, 5).join('\n') || '<i>(Tidak ada aktivitas model hari ini)</i>';

    const richDoc = tgRich.doc(
      tgRich.heading(2, '🌐 9Router Usage Analytics'),
      tgRich.blockquote(`Periode: ${u.latestDate}`),
      tgRich.table([
        [{ content: 'Total Request' }, { content: tgRich.bold(reqFormatted) }],
        [{ content: 'Prompt Tokens' }, { content: promptFormatted }],
        [{ content: 'Completion Tokens' }, { content: compFormatted }],
        [{ content: 'Estimasi Biaya' }, { content: tgRich.code(costFormatted) }]
      ], { bordered: true }),
      tgRich.heading(3, 'Top Model Digunakan:'),
      tgRich.paragraph(modelsList),
      tgRich.blockquote(`7 Hari Terakhir: ${Number(u.sevenDays.requests).toLocaleString()} req • $${Number(u.sevenDays.cost).toFixed(2)} total`)
    );

    await editRich(chatId, messageId, richDoc, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔑 Lihat Akun AGY', callback_data: 'view:agusage' }],
          [{ text: '« Ringkasan Usage', callback_data: 'view:usage' }]
        ]
      }
    });
    await answerCallbackQuery(queryId);
    return;
  }

  // 1.4 View AGY Accounts Detail
  if (data === 'view:agusage') {
    const view = buildAgUsageView();
    await editRich(chatId, messageId, view.doc, {
      reply_markup: view.keyboard
    });
    await answerCallbackQuery(queryId);
    return;
  }

  // 1.4b Refresh AGY Quota Cache
  if (data === 'action:refresh_agusage') {
    const refreshResult = await triggerManualRefresh();
    if (!refreshResult.success) {
      await answerCallbackQuery(queryId, refreshResult.message, true);
      return;
    }

    await answerCallbackQuery(queryId, '🔄 Memulai pemindaian 14 akun...');
    await editRich(chatId, messageId, tgRich.doc(
      tgRich.heading(2, '🔑 AGY Google Multi-Auth Quota Monitor'),
      tgRich.paragraph('🔄 <i>Sedang memindai kuota 14 akun Google Auth di background (~45s)...</i>\n\nPesan ini akan diperbarui otomatis begitu pemindaian selesai.'),
      tgRich.blockquote('Proses berjalan di sandbox terisolasi tanpa memutus sesi bot yang aktif.')
    ));

    // When background scan finishes, update message with fresh data
    let pollCount = 0;
    const checkTimer = setInterval(async () => {
      pollCount++;
      const { getIsScanActive } = await import('./src/usage/ui.mjs');
      if (!getIsScanActive() || pollCount > 60) {
        clearInterval(checkTimer);
        const updatedView = buildAgUsageView();
        await editRich(chatId, messageId, updatedView.doc, {
          reply_markup: updatedView.keyboard
        }).catch(() => {});
      }
    }, 2000);
    if (checkTimer.unref) checkTimer.unref();
    return;
  }

  // 1.4c Open Slot Switcher Menu
  if (data === 'view:switch_slot_menu') {
    const ag = getAgyAccountsUsage();
    const activeSlot = ag ? ag.activeSlot : '1';
    const view = buildSlotSelectorView(activeSlot);
    await editRich(chatId, messageId, view.doc, {
      reply_markup: view.keyboard
    });
    await answerCallbackQuery(queryId);
    return;
  }

  // 1.4d Switch to Specific Slot
  if (data.startsWith('action:switch_slot:')) {
    const targetSlot = data.slice('action:switch_slot:'.length);
    const switchRes = await switchToSlot(targetSlot);
    if (!switchRes.success) {
      await answerCallbackQuery(queryId, switchRes.message, true);
      return;
    }
    await answerCallbackQuery(queryId, `✅ Berhasil beralih ke Slot ${targetSlot}!`);
    const updatedView = buildAgUsageView();
    await editRich(chatId, messageId, updatedView.doc, {
      reply_markup: updatedView.keyboard
    }).catch(() => {});
    return;
  }

  // 1.5 Git Operations Callbacks
  if (data === 'git:status') {
    await safeAnswer('⏳ Membaca status Git...');
    const gitStatus = await getGitStatus();
    await editRich(chatId, messageId, gitStatus.text, {
      reply_markup: gitStatus.keyboard
    });
    return;
  }

  if (data === 'git:diff') {
    await safeAnswer('⏳ Membaca git diff...');
    const diffRes = await getGitDiff();
    await editRich(chatId, messageId, diffRes.text, {
      reply_markup: {
        inline_keyboard: [[{ text: '« Kembali ke Status Git', callback_data: 'git:status' }]]
      }
    });
    return;
  }

  if (data === 'git:commit_push') {
    await safeAnswer('🚀 Memulai commit & push ke GitHub...');
    const pushRes = await gitCommitAndPush();
    await editRich(chatId, messageId, pushRes.message, {
      reply_markup: {
        inline_keyboard: [[{ text: '« Kembali ke Status Git', callback_data: 'git:status' }]]
      }
    });
    return;
  }

  if (data === 'git:pull') {
    await safeAnswer('⬇️ Memulai git pull...');
    const pullRes = await gitPull();
    await editRich(chatId, messageId, pullRes.message, {
      reply_markup: {
        inline_keyboard: [[{ text: '« Kembali ke Status Git', callback_data: 'git:status' }]]
      }
    });
    return;
  }

  // 2. View Models
  if (data === 'view:models') {
    const richDoc = tgRich.doc(
      tgRich.heading(2, '🧠 Pilih Model AI'),
      tgRich.paragraph('Klik tombol di bawah untuk beralih model AI:')
    );
    await editRich(chatId, messageId, richDoc, { reply_markup: getModelsKeyboard(session.model) });
    await answerCallbackQuery(queryId);
    return;
  }

  // 3. Set Model
  if (data.startsWith('set_model:')) {
    const model = data.slice('set_model:'.length);
    session.model = (model === 'default') ? null : model;
    saveSessions();
    const modelName = session.model || 'Default Sistem';
    await answerCallbackQuery(queryId, `✅ Model diatur ke: ${modelName}`, false);

    const richDoc = tgRich.doc(
      tgRich.heading(2, '🧠 Pilih Model AI'),
      tgRich.paragraph([
        'Model aktif saat ini: ',
        tgRich.code(modelName)
      ])
    );
    await editRich(chatId, messageId, richDoc, { reply_markup: getModelsKeyboard(session.model) });
    return;
  }

  // 4. View Effort
  if (data === 'view:effort') {
    const richDoc = tgRich.doc(
      tgRich.heading(2, '⚡ Daya Pikir (Reasoning Effort)'),
      tgRich.paragraph('Pilih intensitas penalaran AI untuk tugas Anda:')
    );
    await editRich(chatId, messageId, richDoc, { reply_markup: getEffortKeyboard(session.effort) });
    await answerCallbackQuery(queryId);
    return;
  }

  // 5. Set Effort
  if (data.startsWith('set_effort:')) {
    const effort = data.slice('set_effort:'.length);
    session.effort = (effort === 'default') ? null : effort;
    saveSessions();
    const effortName = session.effort ? session.effort.toUpperCase() : 'Default Sistem';
    await answerCallbackQuery(queryId, `⚡ Effort: ${effortName}`, false);

    const richDoc = tgRich.doc(
      tgRich.heading(2, '⚡ Daya Pikir (Reasoning Effort)'),
      tgRich.paragraph([
        'Effort saat ini: ',
        tgRich.bold(effortName)
      ])
    );
    await editRich(chatId, messageId, richDoc, { reply_markup: getEffortKeyboard(session.effort) });
    return;
  }

  // 6. View Mode
  if (data === 'view:mode') {
    const richDoc = tgRich.doc(
      tgRich.heading(2, '🎯 Mode Eksekusi Agent'),
      tgRich.paragraph('Pilih mode kerja agent:')
    );
    await editRich(chatId, messageId, richDoc, { reply_markup: getModeKeyboard(session.mode) });
    await answerCallbackQuery(queryId);
    return;
  }

  // 7. Set Mode
  if (data.startsWith('set_mode:')) {
    const mode = data.slice('set_mode:'.length);
    session.mode = mode;
    saveSessions();
    await answerCallbackQuery(queryId, `🎯 Mode: ${mode}`, false);

    const richDoc = tgRich.doc(
      tgRich.heading(2, '🎯 Mode Eksekusi Agent'),
      tgRich.paragraph([
        'Mode aktif: ',
        tgRich.code(mode)
      ])
    );
    await editRich(chatId, messageId, richDoc, { reply_markup: getModeKeyboard(session.mode) });
    return;
  }

  // 8. View Resume Sesi
  if (data === 'view:resume') {
    const view = buildResumeView(session.conversationId);
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    await answerCallbackQuery(queryId);
    return;
  }

  // 9. Action Resume Sesi
  if (data.startsWith('resume:')) {
    const target = data.slice('resume:'.length);
    const conv = (target === 'latest') ? getRecentConversations(1)[0] : findConversation(target);
    if (!conv) {
      await answerCallbackQuery(queryId, '❌ Sesi tidak ditemukan.', true);
      return;
    }

    session.conversationId = conv.conversation_id;
    saveSessions();

    const titleStr = conv.title || conv.preview || conv.conversation_id.slice(0, 8);
    await answerCallbackQuery(queryId, `✅ Sesi: ${titleStr.slice(0, 20)}`, false);

    const conf = buildResumeConfirmation(conv);
    await editRich(chatId, messageId, conf.doc, { reply_markup: conf.keyboard });
    return;
  }

  // 10. Action Reset
  if (data === 'action:reset') {
    session.conversationId = null;
    saveSessions();
    await answerCallbackQuery(queryId, '🔄 Sesi obrolan berhasil di-reset!', true);
    const view = buildDashboardView(session, userId);
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 11. View Logs Hub
  if (data === 'view:logs') {
    const view = buildLogsMenuView(session);
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    await answerCallbackQuery(queryId, '📜 Logs Hub');
    return;
  }

  // 12. View Turn / Code Logs
  if (data === 'view:turn_logs') {
    const tools = session.lastTurn?.tools || session.lastTools || [];
    const view = buildCodeLogsView(tools, session.conversationId, { duration: session.lastTurn?.duration });
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    await answerCallbackQuery(queryId, `📜 Log kode (${tools.length} aksi)`);
    return;
  }

  // 13. View Conversation Logs (Transcript)
  if (data === 'view:conv_logs') {
    await answerCallbackQuery(queryId, 'Membaca log sesi...');
    const logs = getConversationLogs(session.conversationId, 8);
    const view = buildConvLogsView(logs, session.conversationId);
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 14. View Bot Service Logs (Systemd)
  if (data === 'view:bot_logs') {
    await answerCallbackQuery(queryId, 'Membaca log systemd...');
    const logsText = await getBotServiceLogs(35);
    const view = buildBotLogsView(logsText);
    await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 15. Restore Last Response View
  if (data === 'view:last_response') {
    if (session.lastTurn && session.lastTurn.response) {
      const toolCount = (session.lastTurn.tools || []).length;
      const inlineKeyboard = [];
      if (toolCount > 0) {
        inlineKeyboard.push([
          { text: `📜 Logs Kode (${toolCount} Aksi)`, callback_data: 'view:turn_logs' }
        ]);
      }
      inlineKeyboard.push([
        { text: '🔄 Reset Sesi', callback_data: 'action:reset' },
        { text: '▶️ Riwayat Sesi', callback_data: 'view:resume' },
        { text: '⚙️ Dashboard', callback_data: 'view:status' }
      ]);
      await editRich(chatId, messageId, session.lastTurn.response, {
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
      await answerCallbackQuery(queryId, '« Kembali ke respons');
    } else {
      const view = buildDashboardView(session, userId);
      await editRich(chatId, messageId, view.doc, { reply_markup: view.keyboard });
      await answerCallbackQuery(queryId);
    }
    return;
  }

  // 16. Action List Files
  if (data === 'action:ls') {
    await answerCallbackQuery(queryId, 'Membaca direktori...');
    try {
      const files = fs.readdirSync(session.workingDir);
      const listItems = files.slice(0, 30).map(f => {
        const full = path.join(session.workingDir, f);
        const isDir = fs.statSync(full).isDirectory();
        return `${isDir ? '📁' : '📄'} ${f}`;
      });

      const richDoc = tgRich.doc(
        tgRich.heading(3, `📂 Folder: ${path.basename(session.workingDir)}`),
        tgRich.code(listItems.join('\n') || '(Kosong)'),
        tgRich.blockquote('Gunakan /get <nama_file> untuk mengunduh file ke chat.')
      );

      await sendRich(chatId, richDoc, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali ke Dashboard', callback_data: 'view:status' }]]
        }
      });
    } catch (e) {
      await sendRich(chatId, `❌ Gagal membaca direktori: ${e.message}`);
    }
    return;
  }

  if (!isCallbackAnswered) {
    await safeAnswer();
  }
}

// In-Memory Media Group Buffer for Telegram Album Debouncing
const mediaGroupBuffers = new Map();

async function handleMediaGroupCompletion(entry) {
  const { chatId, threadId, sessionKey, files, caption, userId, username } = entry;
  const session = getSession(sessionKey);
  const fileLines = files.map(f => `• <b>${escapeHtml(f.name)}</b> (${(f.size / 1024).toFixed(1)} KB) di <code>${escapeHtml(f.path)}</code>`).join('\n');
  const summaryMsg = `📥 <b>${files.length} Foto/File Berhasil Diunggah ke Server!</b>\n\n${fileLines}\n\n` +
    (caption ? `<b>Instruksi:</b> ${escapeHtml(caption)}` : `<i>Ketik instruksi jika ingin menganalisis atau mengedit file-file ini.</i>`);

  await sendRichMessageLegacy(chatId, summaryMsg, {
    ...(threadId ? { message_thread_id: threadId } : {}),
    reply_markup: {
      inline_keyboard: [[{ text: '📂 Lihat Folder', callback_data: 'action:ls' }]]
    }
  });

  if (caption) {
    if (session.pendingDelivery && session.pendingDelivery.status !== 'completed') {
      session.pendingDelivery = null;
      saveSessions();
    }
    const combinedPrompt = `Saya baru saja mengunggah ${files.length} file gambar ke server:\n` +
      files.map(f => `- ${f.name} di ${f.path}`).join('\n') +
      `\nInstruksi: ${caption}`;

    await handleMessage({
      chat: { id: chatId, type: threadId ? 'supergroup' : 'private' },
      message_thread_id: threadId,
      from: { id: userId, username },
      text: combinedPrompt
    });
  }
}

// Main Message Handler
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const threadId = msg.message_thread_id || null;
  const userId = String(msg.from?.id);
  const username = msg.from?.username || msg.from?.first_name || 'User';

  // 1. TOPIC ROUTING FOR FORUM GROUPS (Supergroup Kuro Ops)
  // Hanya merespons jika topik terdaftar di ALLOWED_TOPICS (default: 7).
  // Di semua topik lain (topik Kuro, General, dll), bot ini DIAM TOTAL (silent ignore).
  if (isGroup) {
    if (ALLOWED_TOPICS.length > 0 && (!threadId || !ALLOWED_TOPICS.includes(threadId))) {
      return; // Silent ignore! Jangan pernah tabrakan dengan Kuro atau bot lain.
    }
  }

  // Helper agar setiap balasan otomatis masuk ke thread topik yang sama
  const sendRich = (cid, doc, opts = {}) => {
    return sendRichMessage(cid, doc, {
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...opts
    });
  };

  const sendRichNative = (cid, markdown, opts = {}) => {
    return sendRichMessageNative(cid, markdown, {
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...opts
    });
  };

  const sendChatAction = (cid, action = 'typing', tId = threadId) => {
    return sendChatActionGlobal(cid, action, tId);
  };

  // 2. Security check: Whitelist
  if (ALLOWED_USERS.length === 0) {
    ALLOWED_USERS.push(userId);
    try {
      let content = fs.readFileSync(envPath, 'utf8');
      content = content.replace(/ALLOWED_USERS=".*"/, `ALLOWED_USERS="${userId}"`);
      fs.writeFileSync(envPath, content, 'utf8');
      console.log(`Auto-claimed owner ID: ${userId} (@${username})`);
    } catch (e) {
      console.error('Failed to update .env with claimed owner:', e);
    }
  } else if (!ALLOWED_USERS.includes(userId)) {
    console.warn(`Unauthorized access attempt from User ID ${userId} (@${username})`);
    if (!isGroup) {
      await sendRich(chatId, `⛔ <b>Akses Ditolak</b>\nUser ID Anda (<code>${userId}</code>) belum terdaftar.`);
    }
    return;
  }

  // Sesi independen untuk Topic 7 vs Private DM
  const sessionKey = isGroup ? `topic:${chatId}:${threadId}` : userId;
  const session = getSession(sessionKey);

  // Active OAuth Login Wizard interceptor
  if (hasActiveLoginSession(chatId)) {
    const rawText = (msg.text || '').trim();
    if (rawText === '/cancel' || rawText === '🛑 Batalkan') {
      cancelLoginSession(chatId);
      await sendRich(chatId, '🚫 <b>Sesi login Google Auth telah dibatalkan.</b>', threadId ? { message_thread_id: threadId } : {});
      return;
    }

    const submitted = submitAuthCode(chatId, rawText);
    if (submitted) {
      await sendRich(chatId, '⏳ <i>Memproses kode otorisasi Google OAuth... Mohon tunggu.</i>', threadId ? { message_thread_id: threadId } : {});
    } else {
      await sendRich(chatId, '❌ Gagal mengirimkan kode otorisasi ke proses login. Silakan coba lagi atau ketik /cancel.', threadId ? { message_thread_id: threadId } : {});
    }
    return;
  }

  // File Upload Handling
  if (msg.document || msg.photo) {
    sendChatAction(chatId, 'upload_document').catch(() => {});
    try {
      let fileId, fileName;
      if (msg.document) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name;
      } else {
        const photoArr = msg.photo;
        const highest = photoArr[photoArr.length - 1];
        fileId = highest.file_id;
        fileName = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
      }

      const saved = await downloadTelegramFile(fileId, session.workingDir, fileName);

      // Handle Album / Media Group Debouncing
      if (msg.media_group_id) {
        const mgId = String(msg.media_group_id);
        let groupEntry = mediaGroupBuffers.get(mgId);
        if (!groupEntry) {
          groupEntry = {
            id: mgId,
            files: [],
            caption: msg.caption || '',
            chatId,
            threadId,
            userId,
            username,
            sessionKey,
            timer: null
          };
          mediaGroupBuffers.set(mgId, groupEntry);
        } else {
          if (msg.caption && !groupEntry.caption) {
            groupEntry.caption = msg.caption;
          }
        }

        groupEntry.files.push(saved);
        if (groupEntry.timer) clearTimeout(groupEntry.timer);

        groupEntry.timer = setTimeout(async () => {
          mediaGroupBuffers.delete(mgId);
          await handleMediaGroupCompletion(groupEntry);
        }, 1200);

        return;
      }
      const richDoc = tgRich.doc(
        tgRich.heading(3, '📥 File Berhasil Diunggah ke Server!'),
        tgRich.table([
          [{ content: 'Nama File' }, { content: tgRich.code(saved.name) }],
          [{ content: 'Ukuran' }, { content: `${(saved.size / 1024).toFixed(1)} KB` }],
          [{ content: 'Tersimpan di' }, { content: tgRich.code(saved.path) }]
        ], { bordered: true }),
        tgRich.blockquote(msg.caption ? `Pesan: ${msg.caption}` : 'Ketik instruksi jika ingin menganalisis atau mengedit file ini.')
      );

      await sendRich(chatId, richDoc, {
        reply_markup: {
          inline_keyboard: [[{ text: '📂 Lihat Folder', callback_data: 'action:ls' }]]
        }
      });

      if (msg.caption) {
        if (session.pendingDelivery && session.pendingDelivery.status !== 'completed') {
          console.log(`[AUTO-ARCHIVE] Archiving uncompleted pendingDelivery for captioned photo prompt.`);
          session.pendingDelivery = null;
          saveSessions();
        }

        const prompt = `Saya baru saja mengunggah file ${saved.name} ke ${saved.path}. Instruksi: ${msg.caption}`;
        const typingTimer = setInterval(() => sendChatAction(chatId, 'typing').catch(() => {}), 4000);
        sendChatAction(chatId, 'typing').catch(() => {});
        try {
          const res = await runAgy(prompt, session);
          clearInterval(typingTimer);
          session.lastTools = res.tools || [];
          session.lastTurn = {
            id: Date.now(),
            prompt,
            response: res.response,
            tools: res.tools || [],
            duration: res.duration,
            usage: res.usage,
            timestamp: Date.now()
          };
          saveSessions();
          const inlineKeyboard = [];
          if (res.tools && res.tools.length > 0) {
            inlineKeyboard.push([{ text: `📜 Logs Kode (${res.tools.length} Aksi)`, callback_data: 'view:turn_logs' }]);
          }
          inlineKeyboard.push([
            { text: '🔄 Reset Sesi', callback_data: 'action:reset' },
            { text: '▶️ Riwayat Sesi', callback_data: 'view:resume' },
            { text: '⚙️ Dashboard', callback_data: 'view:status' }
          ]);

          const fileChunks = splitRichMarkdown(res.response, 30000);
          session.pendingDelivery = {
            turnId: session.lastTurn.id,
            chunks: fileChunks,
            chunkStatuses: new Array(fileChunks.length).fill('pending'),
            deliveredCount: 0,
            skippedCount: 0,
            currentChunkIndex: 0,
            currentChunkStatus: 'pending',
            status: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastError: null,
            replyMarkup: { inline_keyboard: inlineKeyboard }
          };
          saveSessions();

          await executeResumableDelivery(session, chatId, {
            reply_markup: { inline_keyboard: inlineKeyboard },
            message_thread_id: threadId
          });
        } catch (e) {
          clearInterval(typingTimer);
          const errClass = classifyTelegramError(e);
          if (errClass.isAmbiguous) {
            console.error(
              `[DUPLICATE-PREVENTION] File caption delivery failed with ambiguous transport failure (${errClass.reason}: ${e.message}). Skipping duplicate-send fallback.`
            );
          } else if (errClass.isRateLimit || e.isRateLimitExhausted) {
            console.error(
              `[RATE-LIMIT-EXHAUSTED] File caption delivery failed with HTTP 429 rate limit. Skipping fallback to avoid duplicate flood.`
            );
          } else {
            console.warn(`File caption delivery failed (${errClass.errorCode}: ${e.message}).`);
          }
        }
      }
    } catch (err) {
      console.error('File upload error:', err);
      await sendRich(chatId, `❌ Gagal menyimpan file: ${err.message}`);
    }
    return;
  }

  // Voice Note & Audio Handling (Voice-to-Prompt)
  if (msg.voice || msg.audio) {
    sendChatAction(chatId, 'record_voice', threadId).catch(() => {});
    const voiceItem = msg.voice || msg.audio;
    const fileId = voiceItem.file_id;

    let progressMsg = null;
    try {
      progressMsg = await tgRequest('sendMessage', {
        chat_id: chatId,
        text: '🎙️ <i>Mendengarkan dan mentranskripsi pesan suara Anda...</i>',
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {})
      });
    } catch (_) {}

    try {
      const fileInfo = await tgRequest('getFile', { file_id: fileId });
      const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const ext = path.extname(fileInfo.file_path) || (msg.voice ? '.oga' : '.mp3');
      const tempAudioPath = `/tmp/voice_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;

      const resStream = await fetch(downloadUrl);
      const arrayBuffer = await resStream.arrayBuffer();
      fs.writeFileSync(tempAudioPath, Buffer.from(arrayBuffer));

      // Transkripsi via processVoiceNote (async)
      const sttRes = await processVoiceNote(tempAudioPath);
      try { fs.unlinkSync(tempAudioPath); } catch (_) {}

      if (!sttRes.success || !sttRes.text) {
        if (progressMsg) {
          await tgRequest('deleteMessage', { chat_id: chatId, message_id: progressMsg.message_id }).catch(() => {});
        }
        await sendRich(chatId, `⚠️ <b>Gagal mengenali suara:</b> ${sttRes.error || 'Pesan suara tidak terdeteksi jelas.'}`);
        return;
      }

      const transcribedText = sttRes.text.trim();
      if (progressMsg) {
        await tgRequest('deleteMessage', { chat_id: chatId, message_id: progressMsg.message_id }).catch(() => {});
      }

      await sendRich(chatId, `🎙️ <b>Transkripsi Suara:</b>\n<i>"${escapeHtml(transcribedText)}"</i>\n\n⚙️ <i>Mengeksekusi sebagai perintah AI...</i>`);

      // Lanjutkan eksekusi sebagai prompt
      msg.text = transcribedText;
    } catch (err) {
      if (progressMsg) {
        await tgRequest('deleteMessage', { chat_id: chatId, message_id: progressMsg.message_id }).catch(() => {});
      }
      console.error('Audio transcription error:', err);
      await sendRich(chatId, `❌ <b>Gagal memproses pesan suara:</b> ${err.message}`);
      return;
    }
  }

  let text = (msg.text || '').trim();
  if (!text) return;

  // Shortcuts Mapping dari Reply Keyboard Mobile
  if (text === '📊 Status') text = '/status';
  else if (text === '📂 File (ls)') text = '/ls';
  else if (text === '⚡ Effort') text = '/effort';
  else if (text === '📈 Usage') text = '/usage';
  else if (text === '📸 Preview') text = '/preview';
  else if (text === '🎙️ Voice') text = '/voice';
  else if (text === '🎯 Mode') text = '/mode';
  else if (text === '🔄 New Session') text = '/new';
  else if (text === '🛑 Stop') text = '/stop';
  else if (text === '⌨️ Keyboard') text = '/keyboard';

  // Normalisasi command dengan mention bot (contoh: /model@instalrdptorbot -> /model)
  if (text.startsWith('/')) {
    text = text.replace(/^(\/[a-zA-Z0-9_]+)@\S+/, '$1');
  }

  // 0. /stop
  if (text === '/stop') {
    if (activeProcesses.has(sessionKey)) {
      const proc = activeProcesses.get(sessionKey);
      proc.cancel();
      await sendRich(chatId, '🛑 <b>Eksekusi AGY berhasil dihentikan.</b>');
    } else {
      await sendRich(chatId, 'ℹ️ Tidak ada proses AGY yang sedang berjalan.');
    }
    return;
  }

  // 0.1 /keyboard
  if (text === '/keyboard' || text === '/keys') {
    await sendRich(chatId, '⌨️ <b>Quick Keyboard Shortcuts Aktif!</b>\nGunakan tombol di bawah untuk akses cepat:', {
      reply_markup: MAIN_KEYBOARD
    });
    return;
  }

  // 0.2 /topic
  if (text === '/topic') {
    const isTopicAllowed = threadId && ALLOWED_TOPICS.includes(threadId);
    await sendRich(chatId, `🏷️ <b>Informasi Topik & Router:</b>\n• Chat ID: <code>${chatId}</code>\n• Topic ID: <code>${threadId || 'General'}</code>\n• Allowed Topics: <code>${ALLOWED_TOPICS.join(', ')}</code>\n• Agent: <b>Antigravity CLI (AGY)</b>\n• Status: ${isTopicAllowed ? '✅ <b>Dedicated Topic Aktif</b>' : (isGroup ? '⚠️ Topik Tidak Terdaftar' : '💬 Private Chat')}`);
    return;
  }

  // 0.2b /restart (Reboot Service with Shutdown & Recovery Notification)
  if (text === '/restart') {
    const threadOpt = threadId ? { message_thread_id: threadId } : {};
    let shutdownMsg = null;
    try {
      shutdownMsg = await tgRequest('sendMessage', {
        chat_id: chatId,
        text: '🔄 <b>Memulai Restart AGY Telegram Bridge...</b>\n\n⏳ <i>Menyimpan state & memicu systemctl restart...</i>\nPesan notifikasi akan diperbarui otomatis begitu bot aktif kembali.',
        parse_mode: 'HTML',
        ...threadOpt
      });
    } catch (_) {}

    const restartState = {
      chatId,
      threadId: threadId || null,
      messageId: shutdownMsg?.message_id || null,
      requestedAt: Date.now(),
      requestedBy: msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User')
    };

    try {
      fs.writeFileSync('/tmp/agy_restart_state.json', JSON.stringify(restartState, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error('[RESTART] Failed to save restart state:', e.message);
    }

    // Cancel running active AGY processes
    for (const [key, proc] of activeProcesses.entries()) {
      try { if (proc.cancel) proc.cancel(); } catch (_) {}
    }

    console.log(`[RESTART] Triggered by ${restartState.requestedBy} from chat ${chatId}`);
    setTimeout(() => {
      const child = spawn('sudo', ['systemctl', 'restart', 'agy-telegram.service'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }, 500);

    return;
  }

  // 0.3 /usage (Combined Overview)
  if (text === '/usage') {
    const view = buildUsageView();
    await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 0.4 /9usage (9Router Detailed Analytics)
  if (text === '/9usage') {
    const view = build9UsageView();
    await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 0.5 /agusage (14 Google Auth Accounts)
  if (text === '/agusage') {
    const view = buildAgUsageView();
    await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 0.5b /agswitch [slot]
  if (text === '/agswitch' || text.startsWith('/agswitch ')) {
    const arg = text.slice(9).trim();
    if (!arg) {
      const ag = getAgyAccountsUsage();
      const activeSlot = ag ? ag.activeSlot : '1';
      const view = buildSlotSelectorView(activeSlot);
      await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
      return;
    }
    const switchRes = await switchToSlot(arg);
    await sendRich(chatId, switchRes.message);
    return;
  }

  // 0.5c /aglogin <slot>
  if (text === '/aglogin' || text.startsWith('/aglogin ')) {
    const slotArg = text.slice(8).trim();
    if (!slotArg) {
      await sendRich(chatId, 'ℹ️ Harap tentukan nomor slot yang ingin di-login:\nContoh: <code>/aglogin 7</code>');
      return;
    }

    await sendRich(chatId, `⏳ <i>Menyiapkan sesi login Google OAuth untuk Slot ${escapeHtml(slotArg)}...</i>`);

    await startLoginFlow(chatId, slotArg, {
      onUrlReady: async (oauthUrl, slot) => {
        const loginText =
          `🔗 <b>Login Google Auth — Slot ${slot}</b>\n\n` +
          `1. Klik link di bawah untuk login dengan Akun Google Anda:\n` +
          `👉 <a href="${oauthUrl}">Buka Halaman Login Google</a>\n\n` +
          `2. Setelah berhasil login, copy <b>Authorization Code</b> atau <b>URL redirect</b> (https://antigravity.google/...).\n\n` +
          `3. Kirimkan kode atau URL tersebut ke chat ini!\n\n` +
          `<i>Ketik /cancel untuk membatalkan sesi.</i>`;
        await sendRich(chatId, loginText);
      },
      onComplete: async (result) => {
        await sendRich(chatId, result.message);
      }
    });
    return;
  }

  // 0.5d /git [status|diff|push|pull]
  if (text === '/git' || text.startsWith('/git ')) {
    const subCmd = text.slice(4).trim();
    if (subCmd === 'diff') {
      const diffRes = await getGitDiff();
      await sendRich(chatId, diffRes.text);
      return;
    }
    if (subCmd.startsWith('push')) {
      const customMsg = subCmd.slice(4).trim();
      await sendRich(chatId, '🚀 <i>Melakukan commit dan push ke origin/main...</i>');
      const pushRes = await gitCommitAndPush(customMsg);
      await sendRich(chatId, pushRes.message);
      return;
    }
    if (subCmd === 'pull') {
      await sendRich(chatId, '⬇️ <i>Menarik update terbaru dari GitHub...</i>');
      const pullRes = await gitPull();
      await sendRich(chatId, pullRes.message);
      return;
    }

    // Default: git status view
    const statusRes = await getGitStatus();
    await sendRich(chatId, statusRes.text, { reply_markup: statusRes.keyboard });
    return;
  }

  // 0.6 /voice (Podcast / Voice Reply Mode)
  if (text === '/voice' || text.startsWith('/voice ')) {
    const arg = text.slice(6).trim().toLowerCase();
    if (arg === 'on') {
      session.voiceReply = true;
    } else if (arg === 'off') {
      session.voiceReply = false;
    } else {
      session.voiceReply = !session.voiceReply;
    }
    saveSessions();
    const statusText = session.voiceReply ? '✅ <b>AKTIF (ON)</b>' : '⚪ <b>NONAKTIF (OFF)</b>';
    await sendRich(chatId, `🎙️ <b>Mode Podcast / Voice Reply:</b> ${statusText}\n\n${session.voiceReply ? 'Bot akan mengirim pesan suara rangkuman audio di setiap balasan!' : 'Bot hanya akan merespons dengan teks.'}`);
    return;
  }

  // 0.7 /preview (Web / Port Screenshot)
  if (text === '/preview' || text.startsWith('/preview ')) {
    let arg = text.slice(8).trim();
    if (!arg) {
      for (const p of [3000, 5173, 8080, 8000, 20128]) {
        try {
          execSync(`nc -z 127.0.0.1 ${p} 2>/dev/null`, { timeout: 1000 });
          arg = String(p);
          break;
        } catch (_) {}
      }
      if (!arg) {
        const localIndex = path.join(session.workingDir, 'index.html');
        if (fs.existsSync(localIndex)) {
          arg = 'index.html';
        } else {
          arg = '3000';
        }
      }
    }

    let targetUrl = arg;
    if (/^\d+$/.test(arg)) {
      targetUrl = `http://127.0.0.1:${arg}`;
    } else if (!arg.startsWith('http://') && !arg.startsWith('https://')) {
      const filePath = path.isAbsolute(arg) ? arg : path.resolve(session.workingDir, arg);
      if (fs.existsSync(filePath)) {
        targetUrl = `file://${filePath}`;
      } else {
        targetUrl = `http://127.0.0.1:${arg}`;
      }
    }

    sendChatAction(chatId, 'upload_photo', threadId).catch(() => {});
    const waitMsg = await sendRich(chatId, `📸 <i>Mengambil screenshot preview untuk:</i> <code>${escapeHtml(targetUrl)}</code>...`);

    const tempShot = `/tmp/prev_${Date.now()}.png`;
    try {
      await captureScreenshot(targetUrl, tempShot);
      if (waitMsg?.message_id) {
        await tgRequest('deleteMessage', { chat_id: chatId, message_id: waitMsg.message_id }).catch(() => {});
      }
      await sendPhoto(chatId, tempShot, `📸 <b>Web Preview:</b> <code>${escapeHtml(targetUrl)}</code>`, threadId);
      try { fs.unlinkSync(tempShot); } catch (_) {}
    } catch (e) {
      if (waitMsg?.message_id) {
        await tgRequest('deleteMessage', { chat_id: chatId, message_id: waitMsg.message_id }).catch(() => {});
      }
      await sendRich(chatId, `❌ <b>Gagal mengambil preview:</b> ${e.message}\n<i>Pastikan server web lokal sedang berjalan pada port tersebut.</i>`);
    }
    return;
  }

  // 0.8 /cat (Code Inspector)
  if (text.startsWith('/cat ') || text === '/cat') {
    const parts = text.slice(4).trim().split(/\s+/);
    const targetFile = parts[0];
    if (!targetFile) {
      await sendRich(chatId, '⚠️ Format: <code>/cat &lt;nama_file&gt; [baris_mulai-baris_selesai]</code>\nContoh: <code>/cat bot.mjs 1-50</code>');
      return;
    }

    const fullPath = path.isAbsolute(targetFile) ? targetFile : path.resolve(session.workingDir, targetFile);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      await sendRich(chatId, `❌ File tidak ditemukan: <code>${targetFile}</code>`);
      return;
    }

    let start = 1, end = 60;
    if (parts[1]) {
      const match = parts[1].match(/^(\d+)(?:-(\d+))?$/);
      if (match) {
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : start + 50;
      }
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const allLines = content.split('\n');
      const selected = allLines.slice(Math.max(0, start - 1), end);
      const formatted = selected.map((l, i) => `${String(start + i).padStart(3, ' ')} | ${l}`).join('\n');

      const richDoc = tgRich.doc(
        tgRich.heading(3, `📄 ${path.basename(fullPath)} (Baris ${start}-${Math.min(end, allLines.length)} dari ${allLines.length})`),
        tgRich.pre(formatted.slice(0, 3800) || '(Kosong)', path.extname(fullPath).slice(1) || 'text'),
        tgRich.blockquote(`Gunakan /get ${path.basename(fullPath)} untuk mengunduh seluruh file.`)
      );
      await sendRich(chatId, richDoc);
    } catch (e) {
      await sendRich(chatId, `❌ Gagal membaca file: ${e.message}`);
    }
    return;
  }

  // 0.9 /grep (Code Search)
  if (text.startsWith('/grep ') || text === '/grep') {
    const query = text.slice(5).trim();
    if (!query) {
      await sendRich(chatId, '⚠️ Format: <code>/grep &lt;kata_kunci&gt;</code>\nContoh: <code>/grep handleMessage</code>');
      return;
    }

    sendChatAction(chatId, 'typing', threadId).catch(() => {});
    try {
      const cmd = `grep -rnI --exclude-dir={node_modules,.git,.gemini,.local,dist,.next} -m 20 "${query.replace(/"/g, '\\"')}" .`;
      const out = execSync(cmd, { cwd: session.workingDir, encoding: 'utf8', timeout: 10000 }).trim();
      if (!out) {
        await sendRich(chatId, `🔍 Tidak ditemukan kecocokan untuk <code>${escapeHtml(query)}</code>.`);
        return;
      }
      const lines = out.split('\n').slice(0, 15).join('\n');
      const richDoc = tgRich.doc(
        tgRich.heading(3, `🔍 Hasil Pencarian: "${query}"`),
        tgRich.pre(lines, 'bash')
      );
      await sendRich(chatId, richDoc);
    } catch (err) {
      await sendRich(chatId, `ℹ️ Tidak ada hasil pencarian atau terjadi error: ${err.message}`);
    }
    return;
  }

  // 0.10 /tree (Folder Structure)
  if (text === '/tree' || text.startsWith('/tree ')) {
    const depth = parseInt(text.slice(5).trim(), 10) || 2;
    sendChatAction(chatId, 'typing', threadId).catch(() => {});
    try {
      const cmd = `find . -maxdepth ${depth} -not -path '*/.*' -not -path './node_modules*' -not -path './.git*' | sort | head -n 40`;
      const out = execSync(cmd, { cwd: session.workingDir, encoding: 'utf8', timeout: 8000 }).trim();
      const richDoc = tgRich.doc(
        tgRich.heading(3, `🌳 Struktur Direktori: ${path.basename(session.workingDir)} (Kedalaman: ${depth})`),
        tgRich.pre(out || '(Kosong)', 'bash')
      );
      await sendRich(chatId, richDoc);
    } catch (err) {
      await sendRich(chatId, `❌ Gagal membaca struktur: ${err.message}`);
    }
    return;
  }

  // 0.11 /watch & /unwatch (Background Watchdog)
  if (text.startsWith('/watch') || text === '/watch') {
    const parts = text.slice(6).trim().split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();

    if (subCmd === 'list') {
      if (watchers.size === 0) {
        await sendRich(chatId, 'ℹ️ Tidak ada monitor background yang sedang aktif.');
        return;
      }
      const list = Array.from(watchers.entries()).map(([id, w]) => `• <b>[ID: ${id}]</b> ${w.type}: <code>${w.target}</code> (Status: ${w.lastState})`).join('\n');
      await sendRich(chatId, `🔭 <b>Daftar Background Watcher Aktif:</b>\n\n${list}\n\n<i>Gunakan /unwatch &lt;ID&gt; untuk mematikan.</i>`);
      return;
    }

    if (subCmd === 'port' && parts[1]) {
      const port = parseInt(parts[1], 10);
      const watchId = `port_${port}`;
      if (watchers.has(watchId)) {
        await sendRich(chatId, `ℹ️ Port <code>${port}</code> sudah dipantau (ID: <code>${watchId}</code>).`);
        return;
      }

      let lastState = 'UNKNOWN';
      const checkPort = () => {
        let isUp = false;
        try {
          execSync(`nc -z 127.0.0.1 ${port} 2>/dev/null`, { timeout: 1500 });
          isUp = true;
        } catch (_) {}

        const currentState = isUp ? 'UP' : 'DOWN';
        if (lastState !== 'UNKNOWN' && currentState !== lastState) {
          const icon = isUp ? '🟢' : '🔴';
          sendRich(chatId, `${icon} <b>[WATCHDOG ALERT]</b>\nPort <code>${port}</code> berubah status: <b>${currentState}</b>!`).catch(() => {});
        }
        lastState = currentState;
        const entry = watchers.get(watchId);
        if (entry) entry.lastState = currentState;
      };

      checkPort();
      const timer = setInterval(checkPort, 20000);
      watchers.set(watchId, { type: 'port', target: String(port), chatId, threadId, timer, lastState });

      await sendRich(chatId, `🔭 <b>Watcher Aktif!</b>\nMemantau port <code>${port}</code> setiap 20 detik.\nStatus awal: <b>${lastState}</b>\nID: <code>${watchId}</code> (Gunakan <code>/unwatch ${watchId}</code> untuk berhenti).`);
      return;
    }

    await sendRich(chatId, '🔭 <b>Panduan /watch:</b>\n• <code>/watch port &lt;nomor_port&gt;</code> - Pantau service port lokal\n• <code>/watch list</code> - Lihat monitor aktif\n• <code>/unwatch &lt;ID&gt;</code> - Hentikan monitor');
    return;
  }

  if (text.startsWith('/unwatch ') || text === '/unwatch') {
    const id = text.slice(8).trim();
    if (!id || !watchers.has(id)) {
      await sendRich(chatId, `⚠️ ID Watcher tidak ditemukan: <code>${id}</code>\nKetik <code>/watch list</code> untuk melihat ID.`);
      return;
    }
    const entry = watchers.get(id);
    clearInterval(entry.timer);
    watchers.delete(id);
    await sendRich(chatId, `✅ Watcher <code>${id}</code> berhasil dihentikan.`);
    return;
  }

  // 1. /start
  if (text === '/start') {
    const view = buildDashboardView(session, userId);
    await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 2. /status or /menu or /settings
  if (text === '/status' || text === '/menu' || text === '/settings') {
    const view = buildDashboardView(session, userId);
    await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 3. /model
  if (text === '/model' || text.startsWith('/model ')) {
    const targetModel = text.slice(6).trim();
    if (!targetModel) {
      const richDoc = tgRich.doc(
        tgRich.heading(2, '🧠 Pilih Model AI'),
        tgRich.paragraph([
          'Model aktif saat ini: ',
          tgRich.code(session.model || 'Default Sistem')
        ])
      );
      await sendRich(chatId, richDoc, { reply_markup: getModelsKeyboard(session.model) });
      return;
    }

    if (targetModel === 'reset' || targetModel === 'default') {
      session.model = null;
      saveSessions();
      await sendRich(chatId, '✅ Model dikembalikan ke <b>Default Sistem</b>.');
      return;
    }

    session.model = targetModel;
    saveSessions();
    await sendRich(chatId, `✅ Model aktif diubah menjadi: <code>${targetModel}</code>`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⚙️ Buka Dashboard', callback_data: 'view:status' }]]
      }
    });
    return;
  }

  // 4. /models
  if (text === '/models') {
    const richDoc = tgRich.doc(
      tgRich.heading(2, '📋 Daftar Model AI'),
      tgRich.paragraph('Pilih model dari tombol keyboard berikut:')
    );
    await sendRich(chatId, richDoc, { reply_markup: getModelsKeyboard(session.model) });
    return;
  }

  // 5. /effort
  if (text === '/effort' || text.startsWith('/effort ')) {
    const targetEffort = text.slice(7).trim().toLowerCase();
    if (!targetEffort) {
      const richDoc = tgRich.doc(
        tgRich.heading(2, '⚡ Daya Pikir (Reasoning Effort)'),
        tgRich.paragraph([
          'Effort aktif saat ini: ',
          tgRich.bold(session.effort ? session.effort.toUpperCase() : 'Default Sistem')
        ])
      );
      await sendRich(chatId, richDoc, { reply_markup: getEffortKeyboard(session.effort) });
      return;
    }

    if (targetEffort === 'reset' || targetEffort === 'default') {
      session.effort = null;
      saveSessions();
      await sendRich(chatId, '✅ Effort dikembalikan ke <b>Default Sistem</b>.');
      return;
    }

    const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (!validEfforts.includes(targetEffort)) {
      await sendRich(chatId, `⚠️ Effort tidak valid. Gunakan: low, medium, high, max.`);
      return;
    }

    session.effort = targetEffort;
    saveSessions();
    await sendRich(chatId, `✅ Reasoning effort diatur ke: <b>${targetEffort.toUpperCase()}</b>`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⚙️ Buka Dashboard', callback_data: 'view:status' }]]
      }
    });
    return;
  }

  // 6. /mode
  if (text === '/mode' || text.startsWith('/mode ')) {
    const mode = text.slice(5).trim().toLowerCase();
    if (!mode) {
      const richDoc = tgRich.doc(
        tgRich.heading(2, '🎯 Mode Eksekusi Agent'),
        tgRich.paragraph([
          'Mode aktif saat ini: ',
          tgRich.code(session.mode)
        ])
      );
      await sendRich(chatId, richDoc, { reply_markup: getModeKeyboard(session.mode) });
      return;
    }

    const validModes = ['auto', 'plan', 'accept-edits'];
    if (!validModes.includes(mode)) {
      await sendRich(chatId, `⚠️ Mode tidak valid. Pilih: ${validModes.join(', ')}`);
      return;
    }

    session.mode = mode;
    saveSessions();
    await sendRich(chatId, `✅ Mode eksekusi diubah menjadi: <code>${mode}</code>`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⚙️ Buka Dashboard', callback_data: 'view:status' }]]
      }
    });
    return;
  }

  // 7. /new or /reset
  if (text === '/new' || text === '/reset') {
    session.conversationId = null;
    saveSessions();
    await sendRich(chatId, '🔄 <b>Sesi Percakapan Telah Direset!</b>\nTopik baru telah dimulai dengan memori bersih.', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '▶️ Riwayat / Resume', callback_data: 'view:resume' },
            { text: '⚙️ Dashboard', callback_data: 'view:status' }
          ]
        ]
      }
    });
    return;
  }

  // 7a. /retry_delivery or /retry (Resumable Partial Delivery)
  if (text === '/retry_delivery' || text.startsWith('/retry_delivery ') || text === '/retry' || text.startsWith('/retry ')) {
    const rawArg = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim().toLowerCase() : '';
    const force = rawArg === 'force' || rawArg === 'yes' || rawArg === '-f';
    const skip = rawArg === 'skip';

    const pd = session.pendingDelivery;
    if (!pd || !Array.isArray(pd.chunks) || pd.chunks.length === 0) {
      await sendRich(chatId, 'ℹ️ <b>Tidak ada pengiriman jawaban yang tertunda untuk sesi ini.</b>', {
        ...(threadId ? { message_thread_id: threadId } : {})
      });
      return;
    }

    if (pd.status === 'completed') {
      session.pendingDelivery = null;
      saveSessions();
      await sendRich(chatId, '✅ <b>Seluruh bagian jawaban sudah selesai terkirim sebelumnya.</b>', {
        ...(threadId ? { message_thread_id: threadId } : {})
      });
      return;
    }

    const total = pd.chunks.length;
    const delivered = pd.deliveredCount || 0;
    const skipped = pd.skippedCount || 0;
    const remaining = total - delivered - skipped;

    // Jika chunk berstatus unknown dan user belum memilih aksi force atau skip:
    if (pd.currentChunkStatus === 'unknown' && !force && !skip) {
      const unknownIdx = pd.currentChunkIndex >= 0 ? pd.currentChunkIndex : delivered;
      await sendRich(chatId,
        `⚠️ <b>Konfirmasi Pengiriman Ulang (Resumable Delivery):</b>\n\n` +
        `Bagian ke-<b>${unknownIdx + 1}</b> dari <b>${total}</b> berstatus <i>tidak diketahui (unknown)</i> akibat kendala koneksi sebelumnya.\n` +
        `Ada kemungkinan bagian tersebut sudah tampil di chat Telegram Anda.\n\n` +
        `Pilih tindakan untuk melanjutkan:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Kirim Ulang Bagian Ini', callback_data: 'action:retry_delivery_force' },
                { text: '⏭️ Lewati & Kirim Sisanya', callback_data: 'action:retry_delivery_skip' }
              ],
              [
                { text: '🗑️ Buang Jawaban', callback_data: 'action:retry_delivery_discard' },
                { text: '🛑 Batal', callback_data: 'action:retry_delivery_cancel' }
              ]
            ]
          },
          ...(threadId ? { message_thread_id: threadId } : {})
        }
      );
      return;
    }

    const skippedInfo = skipped > 0 ? ` (${skipped} dilewati)` : '';
    const statusMsg = await sendRich(chatId,
      `⏳ <b>Melanjutkan Pengiriman Jawaban...</b>\n` +
      `Terkirim: <b>${delivered}/${total}</b> bagian${skippedInfo}.\n` +
      `Sisa: <b>${Math.max(1, remaining)}</b> bagian.`,
      { ...(threadId ? { message_thread_id: threadId } : {}) }
    );

    try {
      const res = await executeResumableDelivery(session, chatId, {
        message_thread_id: threadId,
        forceUnknown: force,
        skipUnknown: skip
      });

      if (res && res.ok) {
        const skippedTxt = res.skippedCount > 0 ? ` (${res.skippedCount} bagian dilewati)` : '';
        try {
          await tgRequest('editMessageText', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            text: `✅ <b>Pengiriman Berhasil Dilanjutkan!</b>\nSeluruh <b>${total}</b> bagian jawaban telah lengkap diproses${skippedTxt}.`,
            parse_mode: 'HTML'
          });
        } catch (_) {}
      }
    } catch (err) {
      const errClass = classifyTelegramError(err);
      const waitSec = Math.ceil(telegramRateLimitState.getRemainingWaitMs() / 1000) || 5;
      let errNotice = `❌ <b>Pengiriman Tertunda Kembali:</b>\n<code>${escapeHtml(err.message)}</code>`;
      if (errClass.isRateLimit || err.isRateLimitExhausted) {
        errNotice = `⚠️ <b>Rate Limit Telegram (HTTP 429) Masih Aktif:</b>\nMohon tunggu ${waitSec} detik sebelum mencoba <code>/retry_delivery</code> kembali.`;
      }
      try {
        await tgRequest('editMessageText', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: errNotice,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Coba Lagi', callback_data: 'action:retry_delivery' }],
              [{ text: '🗑️ Buang Jawaban Lama', callback_data: 'action:retry_delivery_discard' }]
            ]
          }
        });
      } catch (_) {}
    }
    return;
  }

  // 7b. /resume or /history
  if (text === '/resume' || text.startsWith('/resume ') || text === '/history') {
    const arg = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim() : '';
    if (!arg) {
      const view = buildResumeView(session.conversationId);
      await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
      return;
    }

    const conv = findConversation(arg);
    if (!conv) {
      const recent = getRecentConversations(5);
      const listHints = recent.map((r, i) => `${i + 1}. <b>${r.title || r.conversation_id.slice(0, 8)}</b> (<code>${r.conversation_id.slice(0, 8)}</code>)`).join('\n');
      await sendRich(chatId, `❌ Sesi <b>"${arg}"</b> tidak ditemukan.\n\n<b>Sesi yang tersedia:</b>\n${listHints}\n\nKetik <code>/resume &lt;nomor|ID&gt;</code> atau <code>/resume</code> untuk melihat menu.`);
      return;
    }

    session.conversationId = conv.conversation_id;
    saveSessions();

    const conf = buildResumeConfirmation(conv);
    await sendRich(chatId, conf.doc, { reply_markup: conf.keyboard });
    return;
  }

  // 7c. /logs or /log
  if (text === '/logs' || text.startsWith('/logs ') || text === '/log' || text.startsWith('/log ')) {
    const rawArg = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim().toLowerCase() : '';

    if (rawArg === 'bot' || rawArg === 'service' || rawArg === 'sys') {
      sendChatAction(chatId, 'typing').catch(() => {});
      const logs = await getBotServiceLogs(35);
      const view = buildBotLogsView(logs);
      await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
      return;
    }

    if (rawArg === 'code' || rawArg === 'turn' || rawArg === 'last') {
      const tools = session.lastTurn?.tools || session.lastTools || [];
      const view = buildCodeLogsView(tools, session.conversationId, { duration: session.lastTurn?.duration });
      await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
      return;
    }

    if (rawArg === 'conv' || rawArg === 'session' || rawArg === 'full') {
      sendChatAction(chatId, 'typing').catch(() => {});
      const logs = getConversationLogs(session.conversationId, 10);
      const view = buildConvLogsView(logs, session.conversationId);
      await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
      return;
    }

    // Default /logs hub view
    const view = buildLogsMenuView(session);
    await sendRich(chatId, view.doc, { reply_markup: view.keyboard });
    return;
  }

  // 8. /get or /download
  if (text.startsWith('/get ') || text.startsWith('/download ')) {
    const targetFile = text.slice(text.indexOf(' ') + 1).trim();
    if (!targetFile) {
      await sendRich(chatId, '⚠️ Format: <code>/get &lt;nama_file&gt;</code>');
      return;
    }

    const resolved = path.isAbsolute(targetFile) ? targetFile : path.resolve(session.workingDir, targetFile);
    sendChatAction(chatId, 'upload_document', threadId).catch(() => {});
    try {
      await sendDocument(chatId, resolved, `📄 ${path.basename(resolved)}`, threadId);
    } catch (err) {
      await sendRich(chatId, `❌ Gagal mengirim file: ${err.message}`);
    }
    return;
  }

  // 9. /sh or /bash
  if (text.startsWith('/sh ') || text.startsWith('/bash ')) {
    const cmd = text.slice(text.indexOf(' ') + 1).trim();
    if (!cmd) {
      await sendRich(chatId, '⚠️ Format: <code>/sh &lt;perintah terminal&gt;</code>');
      return;
    }

    sendChatAction(chatId, 'typing', threadId).catch(() => {});
    const typingTimer = setInterval(() => sendChatAction(chatId, 'typing', threadId).catch(() => {}), 4000);

    try {
      const res = await executeShell(cmd, session.workingDir);
      clearInterval(typingTimer);
      const icon = res.success ? '✅' : '❌';
      const richDoc = tgRich.doc(
        tgRich.heading(3, `${icon} Terminal Execution (Exit ${res.code})`),
        tgRich.table([
          [{ content: 'Perintah' }, { content: tgRich.code(cmd) }],
          [{ content: 'Folder' }, { content: tgRich.code(session.workingDir) }]
        ], { bordered: true }),
        tgRich.pre(res.output, 'bash')
      );
      await sendRich(chatId, richDoc);
    } catch (err) {
      clearInterval(typingTimer);
      await sendRich(chatId, `❌ Gagal eksekusi: ${err.message}`);
    }
    return;
  }

  // 10. /pwd
  if (text === '/pwd') {
    await sendRich(chatId, `📂 <b>Direktori Kerja:</b>\n<code>${session.workingDir}</code>`);
    return;
  }

  // 11. /cd
  if (text.startsWith('/cd')) {
    let target = text.slice(3).trim();
    if (!target || target === '~') target = '/home/ubuntu';
    else if (target.startsWith('~/')) target = path.join('/home/ubuntu', target.slice(2));

    const resolved = path.isAbsolute(target) ? target : path.resolve(session.workingDir, target);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      session.workingDir = resolved;
      saveSessions();
      await sendRich(chatId, `✅ Direktori diubah ke:\n<code>${resolved}</code>`, {
        reply_markup: {
          inline_keyboard: [[{ text: '📂 Lihat File Folder', callback_data: 'action:ls' }]]
        }
      });
    } else {
      await sendRich(chatId, `❌ Direktori tidak ditemukan: <code>${resolved}</code>`);
    }
    return;
  }

  // 12. /ls
  if (text === '/ls' || text.startsWith('/ls ')) {
    let target = text.slice(3).trim();
    const dir = target
      ? (path.isAbsolute(target) ? target : path.resolve(session.workingDir, target))
      : session.workingDir;

    try {
      if (!fs.existsSync(dir)) {
        await sendRich(chatId, `❌ Direktori tidak ditemukan: <code>${dir}</code>`);
        return;
      }
      const files = fs.readdirSync(dir);
      const listItems = files.slice(0, 30).map(f => {
        const full = path.join(dir, f);
        const isDir = fs.statSync(full).isDirectory();
        return `${isDir ? '📁' : '📄'} ${f}`;
      });

      const richDoc = tgRich.doc(
        tgRich.heading(3, `📂 Folder: ${path.basename(dir)}`),
        tgRich.code(listItems.join('\n') || '(Kosong)'),
        tgRich.blockquote('Ketik /get <nama_file> untuk mendownload file.')
      );

      await sendRich(chatId, richDoc, {
        reply_markup: {
          inline_keyboard: [[{ text: '⚙️ Dashboard', callback_data: 'view:status' }]]
        }
      });
    } catch (e) {
      await sendRich(chatId, `❌ Gagal membaca direktori: ${e.message}`);
    }
    return;
  }

  // 14. /help
  if (text === '/help') {
    const richDoc = tgRich.doc(
      tgRich.heading(2, '📖 Panduan AGY Telegram Bridge'),
      tgRich.table([
        [{ content: 'Perintah', header: true }, { content: 'Deskripsi', header: true }],
        [{ content: '/menu' }, { content: 'Dashboard tombol interaktif' }],
        [{ content: '/model' }, { content: 'Keyboard pemilihan model AI' }],
        [{ content: '/effort' }, { content: 'Atur intensitas daya pikir' }],
        [{ content: '/mode' }, { content: 'Ganti mode kerja agent' }],
        [{ content: '/resume' }, { content: 'Pilih & lanjutkan sesi percakapan' }],
        [{ content: '/retry_delivery' }, { content: 'Lanjutkan pengiriman jawaban tertunda' }],
        [{ content: '/logs' }, { content: 'Lihat log eksekusi kode & service bot' }],
        [{ content: '/new' }, { content: 'Reset sesi percakapan' }],
        [{ content: '/get <file>' }, { content: 'Download file server ke HP' }],
        [{ content: '/sh <cmd>' }, { content: 'Eksekusi shell terminal' }],
        [{ content: '/ls' }, { content: 'Daftar file folder kerja' }],
        [{ content: '/cd <path>' }, { content: 'Pindah direktori kerja' }],
        [{ content: '/pwd' }, { content: 'Cek direktori kerja saat ini' }]
      ], { bordered: true }),
      tgRich.blockquote('Ketik pesan instruksi coding apa saja untuk mulai berinteraksi dengan AI!')
    );
    await sendRich(chatId, richDoc, {
      reply_markup: {
        inline_keyboard: [[{ text: '⚙️ Buka Dashboard Pengaturan', callback_data: 'view:status' }]]
      }
    });
    return;
  }

  // Cek apakah ada eksekusi proses aktif pada sesi ini
  if (activeProcesses.has(sessionKey)) {
    const currentProc = activeProcesses.get(sessionKey);
    const isAlive = currentProc?.child && currentProc.child.exitCode === null && currentProc.child.signalCode === null;
    if (isAlive) {
      const msg = currentProc.stopping
        ? '⏳ <i>Proses sebelumnya sedang dihentikan. Mohon tunggu beberapa detik...</i>'
        : '⏳ <i>AGY sedang menjalankan proses untuk sesi ini. Harap tunggu hingga selesai atau batalkan proses aktif terlebih dahulu.</i>';
      await sendRich(chatId, msg, {
        reply_markup: currentProc.stopping ? undefined : {
          inline_keyboard: [[{ text: '🛑 Batalkan Proses Berjalan', callback_data: `action:stop:${sessionKey}` }]]
        },
        ...(threadId ? { message_thread_id: threadId } : {})
      });
      return;
    } else {
      // Cleanup stale entry jika child process sudah exited
      activeProcesses.delete(sessionKey);
    }
  }

  // Auto-Archive stale/uncompleted pendingDelivery on new user prompt (Never block user workflow)
  if (session.pendingDelivery && session.pendingDelivery.status !== 'completed') {
    const pd = session.pendingDelivery;
    console.log(`[AUTO-ARCHIVE] Archiving previous uncompleted pendingDelivery (${pd.deliveredCount || 0}/${pd.chunks?.length || 0} chunks) to allow new user prompt.`);
    session.pendingDelivery = null;
    saveSessions();
  }

  // Regular prompt execution via agy with real-time code execution logs
  sendChatAction(chatId, 'typing', threadId).catch(() => {});
  const typingTimer = setInterval(() => sendChatAction(chatId, 'typing', threadId).catch(() => {}), 4000);

  let progressMsg = null;
  try {
    progressMsg = await tgRequest('sendMessage', {
      chat_id: chatId,
      text: '⏳ <b>AGY sedang berpikir...</b>\n<i>Menyiapkan workspace & agent...</i>',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🛑 Batalkan', callback_data: `action:stop:${sessionKey}` }]]
      },
      ...(threadId ? { message_thread_id: threadId } : {})
    });
  } catch (_) {}

  let lastProgressTime = 0;
  let scheduledProgressTimer = null;
  let isUpdatingProgress = false;
  let lastSentBodyText = '';
  let pendingUpdate = null;
  let progressCooldownUntil = 0;
  const PROGRESS_THROTTLE_MS = 1500;

  const flushProgressUpdate = async () => {
    if (!progressMsg || isUpdatingProgress) return;
    if (telegramRateLimitState.isCoolingDown()) return;
    if (Date.now() < progressCooldownUntil) return;
    if (!pendingUpdate) return;

    const update = pendingUpdate;
    pendingUpdate = null;
    const bodyText = formatProgressText(update);
    if (bodyText === lastSentBodyText) return;

    isUpdatingProgress = true;
    lastProgressTime = Date.now();
    try {
      await tgRequest('editMessageText', {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        text: bodyText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🛑 Batalkan', callback_data: `action:stop:${sessionKey}` }]]
        }
      });
      lastSentBodyText = bodyText;
    } catch (err) {
      const errClass = classifyTelegramError(err);
      if (errClass.isRateLimit) {
        const cdSec = errClass.retryAfter || 5;
        progressCooldownUntil = Date.now() + (cdSec * 1000);
        console.warn(`[PROGRESS-THROTTLE] Rate limit 429 during progress edit. Cooldown for ${cdSec}s.`);
      }
    } finally {
      isUpdatingProgress = false;
      if (pendingUpdate && !scheduledProgressTimer) {
        const elapsed = Date.now() - lastProgressTime;
        const delay = Math.max(0, PROGRESS_THROTTLE_MS - elapsed);
        scheduledProgressTimer = setTimeout(() => {
          scheduledProgressTimer = null;
          flushProgressUpdate();
        }, delay);
      }
    }
  };

  const onProgress = (update) => {
    if (!progressMsg) return;
    pendingUpdate = update;
    if (telegramRateLimitState.isCoolingDown()) return;
    const now = Date.now();
    if (now < progressCooldownUntil) return;

    if (!isUpdatingProgress && (now - lastProgressTime >= PROGRESS_THROTTLE_MS)) {
      if (scheduledProgressTimer) {
        clearTimeout(scheduledProgressTimer);
        scheduledProgressTimer = null;
      }
      flushProgressUpdate();
    } else if (!scheduledProgressTimer) {
      const elapsed = now - lastProgressTime;
      const delay = Math.max(0, PROGRESS_THROTTLE_MS - elapsed);
      scheduledProgressTimer = setTimeout(() => {
        scheduledProgressTimer = null;
        flushProgressUpdate();
      }, delay);
    }
  };

  const sessionAbortController = new AbortController();

  try {
    const res = await runAgy(text, session, onProgress, sessionKey, { abortController: sessionAbortController });
    clearInterval(typingTimer);
    if (scheduledProgressTimer) clearTimeout(scheduledProgressTimer);
    pendingUpdate = null;

    // Save last turn data for log viewing and restoring response
    session.lastTools = res.tools || [];
    session.lastTurn = {
      id: Date.now(),
      prompt: text,
      response: res.response,
      tools: res.tools || [],
      duration: res.duration,
      usage: res.usage,
      timestamp: Date.now()
    };
    saveSessions();

    // Deteksi file yang dimodifikasi / status git
    let gitSummary = '';
    const modifiedFiles = new Set();
    for (const t of (res.tools || [])) {
      if (['edit_file', 'write_file'].includes(t.name)) {
        const filePath = cleanParam(t.params?.Path || t.parameters?.Path || '');
        if (filePath) modifiedFiles.add(path.basename(filePath));
      }
    }

    const targetDir = session.workingDir && fs.existsSync(session.workingDir) ? session.workingDir : DEFAULT_DIR;
    if (isGitRepository(targetDir)) {
      try {
        const gitStat = execSync('git status --short', {
          cwd: targetDir,
          timeout: 2000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        }).trim();
        if (gitStat) {
          const statLines = gitStat.split('\n').slice(0, 6).join('\n');
          gitSummary = `\n\n📝 **Status File / Git:**\n\`\`\`\n${statLines}\n\`\`\``;
        } else if (modifiedFiles.size > 0) {
          gitSummary = `\n\n📝 **File Terubah:** \`${Array.from(modifiedFiles).join(', ')}\``;
        }
      } catch (_) {
        if (modifiedFiles.size > 0) {
          gitSummary = `\n\n📝 **File Terubah:** \`${Array.from(modifiedFiles).join(', ')}\``;
        }
      }
    } else if (modifiedFiles.size > 0) {
      gitSummary = `\n\n📝 **File Terubah:** \`${Array.from(modifiedFiles).join(', ')}\``;
    }

    const inlineKeyboard = [];
    if (res.tools && res.tools.length > 0) {
      inlineKeyboard.push([
        { text: `📜 Logs Kode (${res.tools.length} Aksi)`, callback_data: 'view:turn_logs' }
      ]);
    }

    inlineKeyboard.push([
      { text: '🔄 Reset Sesi', callback_data: 'action:reset' },
      { text: '▶️ Riwayat Sesi', callback_data: 'view:resume' },
      { text: '⚙️ Dashboard', callback_data: 'view:status' }
    ]);

    const promptChunks = splitRichMarkdown(res.response + gitSummary, 30000);
    session.pendingDelivery = {
      turnId: session.lastTurn.id,
      chunks: promptChunks,
      chunkStatuses: new Array(promptChunks.length).fill('pending'),
      deliveredCount: 0,
      skippedCount: 0,
      currentChunkIndex: 0,
      currentChunkStatus: 'pending',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
      replyMarkup: { inline_keyboard: inlineKeyboard }
    };
    saveSessions();

    let finalSent = false;
    let finalError = null;
    try {
      const delivRes = await executeResumableDelivery(session, chatId, {
        reply_markup: { inline_keyboard: inlineKeyboard },
        message_thread_id: threadId,
        abortSignal: sessionAbortController.signal
      });
      if (delivRes && delivRes.ok && session.pendingDelivery === null) {
        finalSent = true;
      }
    } catch (sendErr) {
      finalError = sendErr;
      const errClass = classifyTelegramError(sendErr);

      if (errClass.isAmbiguous) {
        // AMBIGUOUS TRANSPORT FAILURE:
        // Do NOT execute emergency sendMessage fallback!
        // Telegram might have already received and posted the message.
        console.error(
          `[DUPLICATE-PREVENTION] executeResumableDelivery failed with ambiguous transport failure (${errClass.reason}: ${sendErr.message}). Skipping duplicate-send fallback.`
        );
      } else if (errClass.isRateLimit || sendErr.isRateLimitExhausted) {
        // RATE LIMIT EXHAUSTED:
        // Do NOT execute fallback to prevent repeated requests during active rate limit.
        console.error(
          `[RATE-LIMIT-EXHAUSTED] executeResumableDelivery gagal karena rate limit Telegram (HTTP 429). Membatalkan fallback pengiriman berulang.`
        );
      } else {
        // DEFINITIVE REJECTION (e.g. 400 Bad Request):
        console.warn(
          `executeResumableDelivery definitively rejected (${errClass.errorCode}: ${sendErr.message}).`
        );
      }
    }

    // Hanya hapus pesan progress JIKA pesan final terbukti sukses terkirim
    if (progressMsg && finalSent) {
      try {
        await tgRequest('deleteMessage', { chat_id: chatId, message_id: progressMsg.message_id });
      } catch (_) {}
    } else if (progressMsg && !finalSent) {
      // Jika pengiriman pesan baru gagal atau tertunda:
      const errClass = classifyTelegramError(finalError);
      const pd = session.pendingDelivery;
      const delivInfo = pd ? ` (${pd.deliveredCount}/${pd.chunks.length} bagian terkirim)` : '';

      if (errClass.isAmbiguous) {
        // Jangan timpa progressMsg dengan jawaban lengkap yang bisa menimbulkan pesan duplikat
        try {
          await tgRequest('editMessageText', {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            text: `⚠️ <b>Jaringan ke Telegram mengalami timeout saat pengiriman respons${delivInfo}.</b>\nPesan mungkin sudah sebagian muncul. Gunakan tombol di bawah atau ketik /retry_delivery untuk melanjutkan sisa jawaban.`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Cek & Lanjutkan Pengiriman', callback_data: 'action:retry_delivery' }],
                ...inlineKeyboard
              ]
            }
          });
        } catch (_) {}
      } else if (errClass.isRateLimit || finalError?.isRateLimitExhausted) {
        // Rate limit 429: Jangan membanjiri Telegram jika masih cooldown
        const waitSec = Math.ceil(telegramRateLimitState.getRemainingWaitMs() / 1000) || 5;
        try {
          if (telegramRateLimitState.isCoolingDown()) {
            await sleepWithAbort(telegramRateLimitState.getRemainingWaitMs(), sessionAbortController.signal).catch(() => {});
          }
          await tgRequest('editMessageText', {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            text: `⚠️ <b>Respons siap tapi tertunda rate limit Telegram (HTTP 429)${delivInfo}.</b>\nSisa jawaban dapat dilanjutkan menggunakan tombol di bawah atau /retry_delivery dalam ${waitSec} detik.`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Lanjutkan Pengiriman', callback_data: 'action:retry_delivery' }],
                ...inlineKeyboard
              ]
            }
          });
        } catch (_) {}
      } else {
        // Definitive error: edit pesan progress dengan jawaban ringkas
        try {
          await tgRequest('editMessageText', {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            text: `⚠️ <b>Pengiriman respons mengalami kendala Telegram API${delivInfo}.</b>\nSilakan gunakan tombol di bawah atau /retry_delivery untuk mencoba mengirimkan sisa jawaban.`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Coba Kirim Ulang', callback_data: 'action:retry_delivery' }],
                ...inlineKeyboard
              ]
            }
          });
        } catch (_) {}
      }
    }

    // Voice Reply (Podcast Mode)
    if (session.voiceReply) {
      sendChatAction(chatId, 'record_voice', threadId).catch(() => {});
      const tempAudio = `/tmp/reply_${Date.now()}.mp3`;
      try {
        let cleanText = res.response
          .replace(/```[\s\S]*?```/g, '') // hapus blok kode
          .replace(/`([^`]+)`/g, '$1')
          .replace(/<[^>]+>/g, '') // hapus html
          .replace(/https?:\/\/\S+/g, '') // hapus link
          .replace(/[#*_~]/g, '')
          .replace(/\n+/g, ' ')
          .trim();

        if (cleanText.length > 280) {
          cleanText = cleanText.slice(0, 260) + '... dan lainnya.';
        }

        if (cleanText) {
          execSync(`edge-tts --voice id-ID-GadisNeural --text "${cleanText.replace(/"/g, '\\"')}" --write-media "${tempAudio}"`, { timeout: 15000 });
          if (fs.existsSync(tempAudio)) {
            await sendVoice(chatId, tempAudio, '🎙️ <i>Rangkuman Suara AGY</i>', threadId);
            try { fs.unlinkSync(tempAudio); } catch (_) {}
          }
        }
      } catch (ttsErr) {
        console.warn('TTS generation warning:', ttsErr.message);
      }
    }
  } catch (err) {
    clearInterval(typingTimer);
    if (scheduledProgressTimer) clearTimeout(scheduledProgressTimer);
    
    if (err.message && err.message.includes('Eksekusi dibatalkan oleh pengguna')) {
      console.log('AGY execution cancelled by user.');
      if (progressMsg) {
        try {
          await tgRequest('editMessageText', {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            text: '🛑 <b>Eksekusi AGY dibatalkan oleh pengguna.</b>',
            parse_mode: 'HTML'
          });
        } catch (_) {}
      }
      return;
    }

    console.error('Error running agy:', err);
    const errMsg = `❌ <b>Terjadi Kesalahan:</b>\n<code>${escapeHtml(err.message || String(err))}</code>`;
    if (progressMsg) {
      try {
        await tgRequest('editMessageText', {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          text: errMsg,
          parse_mode: 'HTML'
        });
      } catch (_) {
        await sendRich(chatId, errMsg).catch(() => {});
      }
    } else {
      await sendRich(chatId, errMsg).catch(() => {});
    }
  }
}

async function registerCommands() {
  const commands = [
    { command: 'menu', description: 'Dashboard kontrol interaktif' },
    { command: 'status', description: 'Cek status model & sesi aktif' },
    { command: 'usage', description: 'Ringkasan statistik penggunaan AI' },
    { command: '9usage', description: 'Detail statistik token 9Router' },
    { command: 'agusage', description: 'Status 14 akun Google Auth AGY' },
    { command: 'agswitch', description: 'Pindah slot akun Google Auth' },
    { command: 'aglogin', description: 'Login / perbarui token Google Auth' },
    { command: 'git', description: 'Hub kontrol Git (status, diff, push)' },
    { command: 'preview', description: 'Screenshot web / port lokal' },
    { command: 'voice', description: 'Toggle mode balasan suara (Podcast)' },
    { command: 'cat', description: 'Baca file kode langsung di chat' },
    { command: 'grep', description: 'Cari kata kunci dalam project' },
    { command: 'tree', description: 'Struktur hierarki folder' },
    { command: 'watch', description: 'Monitor service/port di background' },
    { command: 'stop', description: 'Hentikan proses AGY yang berjalan' },
    { command: 'restart', description: 'Reboot service AGY Telegram Bridge' },
    { command: 'keyboard', description: 'Tampilkan tombol pintas HP' },
    { command: 'topic', description: 'Informasi topik grup aktif' },
    { command: 'resume', description: 'Lanjutkan sesi obrolan sebelumnya' },
    { command: 'logs', description: 'Lihat log eksekusi kode & service' },
    { command: 'model', description: 'Pilih model AI (Keyboard)' },
    { command: 'effort', description: 'Atur daya pikir reasoning' },
    { command: 'mode', description: 'Atur mode agent (Auto/Plan)' },
    { command: 'new', description: 'Reset percakapan & mulai sesi baru' },
    { command: 'get', description: 'Download file dari server' },
    { command: 'ls', description: 'Lihat daftar file di server' },
    { command: 'sh', description: 'Jalankan perintah bash terminal' },
    { command: 'pwd', description: 'Lihat lokasi direktori kerja' },
    { command: 'cd', description: 'Pindah direktori kerja' },
    { command: 'help', description: 'Panduan lengkap fitur' }
  ];

  try {
    await tgRequest('setMyCommands', { commands });
    console.log('Registered Telegram bot commands menu.');
  } catch (err) {
    console.warn('Failed to register Telegram commands:', err.message);
  }
}

async function checkAndNotifyRestartRecovery() {
  const restartFile = '/tmp/agy_restart_state.json';
  if (!fs.existsSync(restartFile)) return;

  try {
    const raw = fs.readFileSync(restartFile, 'utf8');
    const state = JSON.parse(raw);
    try { fs.unlinkSync(restartFile); } catch (_) {}

    const elapsedSec = ((Date.now() - (state.requestedAt || Date.now())) / 1000).toFixed(1);
    const text =
      '🚀 <b>AGY Telegram Bridge Berhasil Di-restart!</b>\n\n' +
      `• <b>Durasi Reboot:</b> <code>${elapsedSec}s</code>\n` +
      `• <b>PID Baru:</b> <code>${process.pid}</code>\n` +
      `• <b>Diminta Oleh:</b> ${escapeHtml(state.requestedBy || 'Admin')}\n` +
      `• <b>Waktu:</b> <code>${new Date().toISOString().slice(11, 19)} UTC</code>\n\n` +
      '<i>Semua sistem siap menerima instruksi.</i>';

    const opts = state.threadId ? { message_thread_id: state.threadId } : {};

    if (state.messageId) {
      try {
        await tgRequest('editMessageText', {
          chat_id: state.chatId,
          message_id: state.messageId,
          text,
          parse_mode: 'HTML'
        });
        return;
      } catch (_) {}
    }

    await sendRich(state.chatId, text, opts);
  } catch (err) {
    console.error('[RECOVERY] Failed to send restart recovery message:', err.message);
  }
}

let isShuttingDown = false;
const handleGracefulShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] Received ${signal}. Performing graceful shutdown...`);
  for (const [key, proc] of activeProcesses.entries()) {
    try { if (proc.cancel) proc.cancel(); } catch (_) {}
  }
  process.exit(0);
};

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));

let isPollingActive = false;

async function startPolling() {
  if (isPollingActive) {
    console.warn('Polling already active; skipping duplicate loop.');
    return;
  }
  isPollingActive = true;

  console.log('🤖 AGY Telegram Bot started. Listening for updates...');
  let offset = 0;

  let me = null;
  let connectAttempts = 0;
  const MAX_CONNECT_ATTEMPTS = 6;
  while (!me && connectAttempts < MAX_CONNECT_ATTEMPTS) {
    connectAttempts++;
    try {
      me = await tgRequest('getMe');
      console.log(`Connected successfully as @${me.username} (${me.first_name})`);
      await registerCommands();
      await checkAndNotifyRestartRecovery();
    } catch (err) {
      if (connectAttempts < MAX_CONNECT_ATTEMPTS) {
        const retryDelaySec = connectAttempts * 2;
        console.warn(`Connection attempt ${connectAttempts}/${MAX_CONNECT_ATTEMPTS} to Telegram failed (${err.message}). Retrying in ${retryDelaySec}s...`);
        await sleep(retryDelaySec * 1000);
      } else {
        console.error('Failed to connect to Telegram after multiple retries:', err.message);
        process.exit(1);
      }
    }
  }

  let failureCount = 0;
  const MIN_RETRY_MS = 2000;
  const MAX_RETRY_MS = 30000;

  while (true) {
    try {
      const updates = await tgRequest('getUpdates', {
        offset,
        timeout: 30
      });

      failureCount = 0;

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.callback_query) {
          handleCallback(update.callback_query).catch(err => {
            console.error('Callback error:', err);
          });
        } else if (update.message) {
          handleMessage(update.message).catch(err => {
            console.error('Message error:', err);
          });
        }
      }
    } catch (err) {
      const isConflict = err.message && (err.message.includes('409') || err.message.includes('Conflict'));
      if (isConflict) {
        console.error('Telegram 409 Conflict: Another instance is polling with this token. Pausing 30s before retry...');
        await new Promise(r => setTimeout(r, 30000));
      } else {
        failureCount++;
        const backoff = Math.min(MIN_RETRY_MS * Math.pow(1.5, failureCount - 1), MAX_RETRY_MS);
        console.warn(`Polling network error (${failureCount}): ${err.message}. Retrying in ${Math.round(backoff / 1000)}s...`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
}

startPolling();

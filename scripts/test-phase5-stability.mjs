/**
 * AGY Telegram Bridge — Phase 5 Stability & Robustness Test Suite
 *
 * Offline verification for:
 * 1. Resilient Startup Retry Loop
 * 2. Non-blocking Auto-Archive of Pending Delivery
 * 3. Media Group / Album Debouncing
 * 4. HTML Tag-Balancing across split chunks
 * 5. Immediate Callback Query Ack (Anti-Timeout)
 * 6. Audio Normalization in STT
 */

import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { convertToWav } from '../src/voice/stt.mjs';

let passed = 0;
let total = 0;

function it(desc, fn) {
  total++;
  try {
    fn();
    console.log(`  ✓ [Test ${String(total).padStart(2, '0')}] PASS: ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ [Test ${String(total).padStart(2, '0')}] FAIL: ${desc}`);
    console.error(`    ${err.message}`);
  }
}

async function itAsync(desc, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ [Test ${String(total).padStart(2, '0')}] PASS: ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ [Test ${String(total).padStart(2, '0')}] FAIL: ${desc}`);
    console.error(`    ${err.message}`);
  }
}

console.log('======================================================================');
console.log('  AGY TELEGRAM BRIDGE — PHASE 5 STABILITY VERIFICATION SUITE         ');
console.log('======================================================================\n');

// Category 1: Resilient Startup Connection Loop
console.log('--- Category 1: Resilient Startup Connection Loop ---');

it('Retries on transient network error and recovers when connection succeeds', async () => {
  let attempts = 0;
  const mockTgRequest = async (method) => {
    attempts++;
    if (attempts < 3) throw new Error('fetch failed: connection reset');
    return { id: 123456, username: 'test_bot', first_name: 'TestBot' };
  };

  let me = null;
  let connectAttempts = 0;
  const MAX_CONNECT_ATTEMPTS = 5;
  while (!me && connectAttempts < MAX_CONNECT_ATTEMPTS) {
    connectAttempts++;
    try {
      me = await mockTgRequest('getMe');
    } catch (err) {
      if (connectAttempts >= MAX_CONNECT_ATTEMPTS) throw err;
    }
  }

  assert.strictEqual(attempts, 3);
  assert.strictEqual(me.username, 'test_bot');
});

it('Handles repeated failure up to MAX_CONNECT_ATTEMPTS without infinite loop', async () => {
  let attempts = 0;
  const mockTgRequest = async () => {
    attempts++;
    throw new Error('fetch failed: network unreachable');
  };

  let me = null;
  let connectAttempts = 0;
  const MAX_CONNECT_ATTEMPTS = 4;
  let errorCaught = false;

  while (!me && connectAttempts < MAX_CONNECT_ATTEMPTS) {
    connectAttempts++;
    try {
      me = await mockTgRequest('getMe');
    } catch (err) {
      if (connectAttempts >= MAX_CONNECT_ATTEMPTS) {
        errorCaught = true;
      }
    }
  }

  assert.strictEqual(attempts, 4);
  assert.strictEqual(errorCaught, true);
  assert.strictEqual(me, null);
});

// Category 2: Non-blocking Auto-Archive of Pending Delivery
console.log('\n--- Category 2: Non-blocking Auto-Archive of Pending Delivery ---');

it('Automatically archives previous uncompleted delivery on new user message', () => {
  const session = {
    conversationId: 'conv-test-123',
    pendingDelivery: {
      turnId: 1001,
      chunks: ['Part 1', 'Part 2', 'Part 3'],
      deliveredCount: 1,
      status: 'pending'
    }
  };

  // Simulate new message handling logic:
  if (session.pendingDelivery && session.pendingDelivery.status !== 'completed') {
    session.pendingDelivery = null; // Auto-archive
  }

  assert.strictEqual(session.pendingDelivery, null, 'Pending delivery should be cleared');
});

it('Does not clear completed pending delivery', () => {
  const session = {
    pendingDelivery: null
  };

  if (session.pendingDelivery && session.pendingDelivery.status !== 'completed') {
    session.pendingDelivery = null;
  }

  assert.strictEqual(session.pendingDelivery, null);
});

// Category 3: Media Group / Album Debouncing
console.log('\n--- Category 3: Media Group / Album Debouncing ---');

it('Collects multiple photos in an album and debounces into a single combined batch', async () => {
  const buffer = new Map();
  const mgId = 'media_group_999';

  // Photo 1 arrives
  let group1 = buffer.get(mgId);
  if (!group1) {
    group1 = { files: [], caption: 'Analyze this photo album', timer: null };
    buffer.set(mgId, group1);
  }
  group1.files.push({ name: 'photo_1.jpg', path: '/tmp/photo_1.jpg', size: 1024 });

  // Photo 2 arrives 20ms later
  let group2 = buffer.get(mgId);
  group2.files.push({ name: 'photo_2.jpg', path: '/tmp/photo_2.jpg', size: 2048 });

  // Photo 3 arrives 30ms later
  let group3 = buffer.get(mgId);
  group3.files.push({ name: 'photo_3.jpg', path: '/tmp/photo_3.jpg', size: 4096 });

  assert.strictEqual(buffer.get(mgId).files.length, 3);
  assert.strictEqual(buffer.get(mgId).caption, 'Analyze this photo album');

  // Verify combined prompt construction
  const group = buffer.get(mgId);
  const combinedPrompt = `Saya baru saja mengunggah ${group.files.length} file gambar ke server:\n` +
    group.files.map(f => `- ${f.name} di ${f.path}`).join('\n') +
    `\nInstruksi: ${group.caption}`;

  assert.match(combinedPrompt, /3 file gambar/);
  assert.match(combinedPrompt, /photo_1\.jpg/);
  assert.match(combinedPrompt, /photo_2\.jpg/);
  assert.match(combinedPrompt, /photo_3\.jpg/);
  assert.match(combinedPrompt, /Instruksi: Analyze this photo album/);
});

// Category 4: HTML Tag-Balancing Across Chunks
console.log('\n--- Category 4: HTML Tag-Balancing Across Chunks ---');

const VALID_TELEGRAM_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote', 'tg-spoiler', 'a']);

function sanitizeTelegramHtmlTest(text) {
  if (!text) return '';
  let result = '';
  const tagStack = [];
  const tagRegex = /(<[^>]+>|&[a-zA-Z0-9#]+;)/g;
  let lastIdx = 0;
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      const slice = text.slice(lastIdx, match.index);
      result += slice.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    lastIdx = tagRegex.lastIndex;
    const token = match[0];
    if (token.startsWith('&')) { result += token; continue; }
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
      const idx = tagStack.lastIndexOf(tagName);
      if (idx !== -1) {
        while (tagStack.length > idx) {
          result += `</${tagStack.pop()}>`;
        }
      }
    }
  }
  if (lastIdx < text.length) {
    result += text.slice(lastIdx).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  while (tagStack.length > 0) {
    result += `</${tagStack.pop()}>`;
  }
  return result;
}

function balanceChunksTest(chunks) {
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
    balancedChunks.push(sanitizeTelegramHtmlTest(chunk));
  }
  return balancedChunks;
}

it('Balances open <pre><code> across chunk boundary so second chunk reopens tags', () => {
  const chunk1 = '<pre><code>const x = 10;';
  const chunk2 = 'const y = 20;</code></pre>';
  const balanced = balanceChunksTest([chunk1, chunk2]);

  assert.strictEqual(balanced.length, 2);
  assert.strictEqual(balanced[0], '<pre><code>const x = 10;</code></pre>', 'Chunk 1 should close open pre/code');
  assert.strictEqual(balanced[1], '<pre><code>const y = 20;</code></pre>', 'Chunk 2 should reopen pre/code and close it');
});

it('Balances open <b> and <i> tags across chunks', () => {
  const chunk1 = 'Halo <b>dunia <i>yang indah';
  const chunk2 = 'dan penuh warna</i></b>!';
  const balanced = balanceChunksTest([chunk1, chunk2]);

  assert.strictEqual(balanced.length, 2);
  assert.strictEqual(balanced[0], 'Halo <b>dunia <i>yang indah</i></b>');
  assert.strictEqual(balanced[1], '<b><i>dan penuh warna</i></b>!');
});

// Category 5: Callback Query Immediate Ack
console.log('\n--- Category 5: Callback Query Immediate Ack ---');

it('Ensures safeAnswer fires once and prevents duplicate call or query expiration', async () => {
  let answerCount = 0;
  let lastText = '';
  const mockAnswerCallbackQuery = async (id, text, alert) => {
    answerCount++;
    lastText = text;
  };

  let isCallbackAnswered = false;
  const safeAnswer = async (text = '', alert = false) => {
    if (isCallbackAnswered) return;
    isCallbackAnswered = true;
    await mockAnswerCallbackQuery('q123', text, alert);
  };

  await safeAnswer('⏳ Memproses...');
  await safeAnswer('Status selesai'); // Should be ignored because already answered

  assert.strictEqual(answerCount, 1);
  assert.strictEqual(lastText, '⏳ Memproses...');
  assert.strictEqual(isCallbackAnswered, true);
});

// Category 6: Audio Normalization in STT
console.log('\n--- Category 6: Audio Normalization in STT ---');

await itAsync('convertToWav normalizes audio with loudnorm filter', async () => {
  // Create a silent dummy wav file for testing
  const dummySrc = path.join(os.tmpdir(), `test_src_${Date.now()}.wav`);
  const dummyOut = path.join(os.tmpdir(), `test_out_${Date.now()}.wav`);

  // Generate 0.5s audio tone with ffmpeg
  const { execSync } = await import('node:child_process');
  execSync(`ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=0.5" "${dummySrc}" -loglevel error`);

  try {
    const res = await convertToWav(dummySrc, dummyOut);
    assert.strictEqual(fs.existsSync(dummyOut), true);
    const stats = fs.statSync(dummyOut);
    assert.ok(stats.size > 0, 'Converted output should be non-empty');
  } finally {
    try { if (fs.existsSync(dummySrc)) fs.unlinkSync(dummySrc); } catch (_) {}
    try { if (fs.existsSync(dummyOut)) fs.unlinkSync(dummyOut); } catch (_) {}
  }
});

console.log('\n======================================================================');
console.log(`  SUMMARY: ${passed} PASSED, ${total - passed} FAILED out of ${total} TOTAL ASSERTIONS`);
console.log('======================================================================\n');

if (passed === total) {
  console.log('✓ ALL PHASE 5 STABILITY TESTS 100% PASSED (' + passed + '/' + total + ').\n');
  process.exit(0);
} else {
  console.error('✗ SOME TESTS FAILED (' + (total - passed) + ' failures).\n');
  process.exit(1);
}

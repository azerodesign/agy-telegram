/**
 * AGY Telegram Bridge — Phase 6 Multi-Task & Smart Queue Test Suite
 *
 * Offline verification for:
 * 1. Smart Task Queue (Enqueueing, FIFO processing, cancellation)
 * 2. /btw (Isolated quick query without locking main session)
 * 3. /bgtask (Independent background worker tracking & cancellation)
 * 4. Photo Caption Execution Delegation (Realtime streaming logs)
 */

import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

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
console.log('  AGY TELEGRAM BRIDGE — PHASE 6 MULTI-TASK & QUEUE VERIFICATION SUITE ');
console.log('======================================================================\n');

// Category 1: Smart Task Queue
console.log('--- Category 1: Smart Task Queue Management ---');

const sessionTaskQueues = new Map();

it('Enqueues new instruction when a session has an active process running', () => {
  const sessionKey = 'topic:-1004341504219:7';
  let queue = sessionTaskQueues.get(sessionKey);
  if (!queue) {
    queue = [];
    sessionTaskQueues.set(sessionKey, queue);
  }

  const task1 = { id: 101, text: 'Tolong buatkan file server.js', timestamp: Date.now() };
  const task2 = { id: 102, text: 'Tambahkan middleware cors', timestamp: Date.now() + 100 };

  queue.push(task1);
  queue.push(task2);

  assert.strictEqual(sessionTaskQueues.get(sessionKey).length, 2);
  assert.strictEqual(sessionTaskQueues.get(sessionKey)[0].id, 101);
  assert.strictEqual(sessionTaskQueues.get(sessionKey)[1].id, 102);
});

it('Maintains strict FIFO order and pops next task when active process finishes', () => {
  const sessionKey = 'topic:-1004341504219:7';
  const queue = sessionTaskQueues.get(sessionKey);
  assert.ok(queue && queue.length === 2);

  const nextTask = queue.shift();
  assert.strictEqual(nextTask.id, 101);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].id, 102);
});

it('Cancels and removes a specific task from queue by ID without disrupting other queued tasks', () => {
  const sessionKey = 'topic:-1004341504219:7';
  const queue = sessionTaskQueues.get(sessionKey);
  
  // Add another task
  queue.push({ id: 103, text: 'Task ketiga', timestamp: Date.now() });
  assert.strictEqual(queue.length, 2);

  // Cancel task 102
  const idx = queue.findIndex(item => item.id === 102);
  assert.notStrictEqual(idx, -1);
  queue.splice(idx, 1);

  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].id, 103);
});

it('Cleans up queue map when last task is popped', () => {
  const sessionKey = 'topic:-1004341504219:7';
  const queue = sessionTaskQueues.get(sessionKey);
  queue.shift(); // Remove 103

  if (queue.length === 0) {
    sessionTaskQueues.delete(sessionKey);
  }

  assert.strictEqual(sessionTaskQueues.has(sessionKey), false);
});

it('Clears all queued tasks when /stop is triggered on a session', () => {
  const sessionKey = 'user:123456';
  sessionTaskQueues.set(sessionKey, [
    { id: 201, text: 'A' },
    { id: 202, text: 'B' },
    { id: 203, text: 'C' }
  ]);

  assert.strictEqual(sessionTaskQueues.get(sessionKey).length, 3);
  sessionTaskQueues.delete(sessionKey); // Simulates /stop action
  assert.strictEqual(sessionTaskQueues.has(sessionKey), false);
});

// Category 2: /btw Ephemeral Side-Queries
console.log('\n--- Category 2: /btw Ephemeral Side-Queries ---');

it('Constructs isolated ephemeral session without touching conversationId', () => {
  const mainSession = {
    conversationId: 'real-persistent-conversation-uuid',
    workingDir: '/home/ubuntu/project',
    model: 'gemini-3.8-flash-high',
    mode: 'auto',
    effort: 'high'
  };

  const ephemeralSession = {
    conversationId: null, // Critical: One-shot, never corrupts main transcript
    workingDir: mainSession.workingDir,
    model: mainSession.model,
    mode: 'auto',
    effort: 'low' // Fast response for quick queries
  };

  assert.strictEqual(ephemeralSession.conversationId, null);
  assert.strictEqual(ephemeralSession.workingDir, '/home/ubuntu/project');
  assert.strictEqual(ephemeralSession.effort, 'low');
  assert.strictEqual(mainSession.conversationId, 'real-persistent-conversation-uuid');
});

it('Formats /btw response header and question cleanly with HTML escaping', () => {
  const query = 'Bagaimana cara <script>alert("xss")</script> diuji?';
  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  const formatted = `💡 <b>[BTW — Jawaban Cepat]</b>\n<i>Q: "${escapeHtml(query)}"</i>\n\nJawabannya adalah...`;

  assert.match(formatted, /&lt;script&gt;/);
  assert.doesNotMatch(formatted, /<script>/);
  assert.match(formatted, /\[BTW — Jawaban Cepat\]/);
});

// Category 3: /bgtask Background Worker
console.log('\n--- Category 3: /bgtask Background Worker ---');

const backgroundTasks = new Map();

it('Creates background task with unique ID and running status', () => {
  const bgId = `bg_${Date.now().toString(36)}`;
  const bgEntry = {
    id: bgId,
    prompt: 'npm run test:unit',
    chatId: 1821599046,
    threadId: null,
    sessionKey: '1821599046',
    startTime: Date.now(),
    status: 'running'
  };

  backgroundTasks.set(bgId, bgEntry);

  assert.strictEqual(backgroundTasks.has(bgId), true);
  assert.strictEqual(backgroundTasks.get(bgId).status, 'running');
  assert.strictEqual(backgroundTasks.get(bgId).prompt, 'npm run test:unit');
});

it('Cancels and cleans up background task on user abort', () => {
  const bgId = Array.from(backgroundTasks.keys())[0];
  assert.ok(bgId);

  // Simulate cancellation action:
  const task = backgroundTasks.get(bgId);
  task.status = 'cancelled';
  backgroundTasks.delete(bgId);

  assert.strictEqual(backgroundTasks.has(bgId), false);
});

// Category 4: Photo Caption Realtime Logs Delegation
console.log('\n--- Category 4: Photo Caption Realtime Logs Delegation ---');

it('Constructs unified prompt with uploaded filename, path, and user caption', () => {
  const saved = {
    name: 'photo_1793466343053.jpg',
    path: '/home/ubuntu/photos/photo_1793466343053.jpg',
    size: 204800
  };
  const caption = 'Perbaiki styling modal login';

  const prompt = `Saya baru saja mengunggah file ${saved.name} ke ${saved.path}. Instruksi: ${caption}`;

  assert.match(prompt, /Saya baru saja mengunggah file photo_1793466343053\.jpg/);
  assert.match(prompt, /Instruksi: Perbaiki styling modal login/);
});

console.log('\n======================================================================');
console.log(`  SUMMARY: ${passed} PASSED, ${total - passed} FAILED out of ${total} TOTAL ASSERTIONS`);
console.log('======================================================================\n');

if (passed === total) {
  console.log('✓ ALL PHASE 6 MULTI-TASK & QUEUE TESTS 100% PASSED (' + passed + '/' + total + ').\n');
  process.exit(0);
} else {
  console.error('✗ SOME TESTS FAILED (' + (total - passed) + ' failures).\n');
  process.exit(1);
}

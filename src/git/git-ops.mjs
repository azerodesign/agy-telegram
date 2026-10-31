/**
 * AGY Git - Telegram Git Operations Hub
 * 
 * Provides:
 * - Status check (branch, staged, modified, untracked)
 * - Diff viewer (clean code block)
 * - Quick Commit & Push
 * - Git Pull
 * - Interactive inline control menu
 */

import { execFile, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = '/home/ubuntu/agy-telegram';

/**
 * Escapes characters for Telegram HTML.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Gets concise Git status formatted for Telegram HTML.
 */
export async function getGitStatus() {
  return new Promise((resolve) => {
    execFile('git', ['status', '--short', '--branch'], { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          success: false,
          message: `❌ Git error: ${stderr || err.message}`
        });
      }

      const lines = stdout.trim().split('\n').filter(Boolean);
      const branchLine = lines[0] || '## main';
      const fileLines = lines.slice(1);

      let lastCommit = '-';
      try {
        lastCommit = execSync('git log -1 --pretty=format:"%h - %s (%cr)"', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      } catch (_) {}

      const isClean = fileLines.length === 0;

      let fileSummary = '<i>Working tree bersih, tidak ada perubahan pending.</i>';
      if (!isClean) {
        fileSummary = fileLines.slice(0, 15).map(l => {
          const status = l.slice(0, 2).trim();
          const filePath = l.slice(3).trim();
          let icon = '📝';
          if (status === '??') icon = '❓';
          else if (status.includes('M')) icon = '✏️';
          else if (status.includes('D')) icon = '🗑️';
          else if (status.includes('A')) icon = '✨';
          return `${icon} <code>${escapeHtml(status)}</code> ${escapeHtml(filePath)}`;
        }).join('\n');

        if (fileLines.length > 15) {
          fileSummary += `\n<i>...dan ${fileLines.length - 15} file lainnya</i>`;
        }
      }

      const text =
        '🐙 <b>AGY Git Operations Hub</b>\n\n' +
        `• <b>Branch:</b> <code>${escapeHtml(branchLine.replace(/^##\s*/, ''))}</code>\n` +
        `• <b>Last Commit:</b> <code>${escapeHtml(lastCommit)}</code>\n` +
        `• <b>Status Perubahan:</b> ${isClean ? '✅ Bersih' : `⚠️ Ada ${fileLines.length} file diubah`}\n\n` +
        fileSummary;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '📊 Refresh Status', callback_data: 'git:status' },
            { text: '📝 Lihat Diff', callback_data: 'git:diff' }
          ],
          [
            { text: '🚀 Quick Commit & Push', callback_data: 'git:commit_push' },
            { text: '⬇️ Git Pull', callback_data: 'git:pull' }
          ]
        ]
      };

      resolve({
        success: true,
        isClean,
        text,
        keyboard
      });
    });
  });
}

/**
 * Gets git diff snippet formatted for Telegram HTML.
 */
export async function getGitDiff(maxChars = 2500) {
  return new Promise((resolve) => {
    execFile('git', ['diff'], { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          success: false,
          text: `❌ Gagal mengambil diff: ${stderr || err.message}`
        });
      }

      if (!stdout.trim()) {
        return resolve({
          success: true,
          text: 'ℹ️ <i>Tidak ada perbedaan file pada working tree (diff kosong).</i>'
        });
      }

      let diffText = stdout.trim();
      let truncated = false;
      if (diffText.length > maxChars) {
        diffText = diffText.slice(0, maxChars) + '\n\n... (diff dipotong karena terlalu panjang)';
        truncated = true;
      }

      const text =
        '📝 <b>Git Diff (Perubahan Belum Di-commit):</b>\n\n' +
        `<pre><code class="language-diff">${escapeHtml(diffText)}</code></pre>`;

      resolve({
        success: true,
        text,
        truncated
      });
    });
  });
}

/**
 * Performs git add, git commit, and git push.
 */
export async function gitCommitAndPush(customMessage, options = {}) {
  const commitMsg = (customMessage || `chore: update from telegram bridge at ${new Date().toISOString()}`).trim();
  const repoDir = options.cwd || REPO_ROOT;

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      message: `Dry run commit & push verified for message: "${commitMsg}"`
    };
  }

  return new Promise((resolve) => {
    try {
      execSync('git add -A', { cwd: repoDir });
      const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' }).trim();
      if (!status) {
        return resolve({
          success: false,
          message: 'ℹ️ Tidak ada perubahan yang perlu di-commit (working tree bersih).'
        });
      }

      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: repoDir });
      const pushOut = execSync('git push origin main 2>&1', { cwd: repoDir, encoding: 'utf8' });
      const hash = execSync('git rev-parse --short HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

      resolve({
        success: true,
        hash,
        message:
          '🚀 <b>Commit & Push Berhasil!</b>\n\n' +
          `• <b>Commit:</b> <code>${hash}</code>\n` +
          `• <b>Pesan:</b> <i>${escapeHtml(commitMsg)}</i>\n` +
          `• <b>Target:</b> <code>origin/main</code>\n\n` +
          `<pre><code>${escapeHtml(pushOut.slice(-300))}</code></pre>`
      });
    } catch (err) {
      resolve({
        success: false,
        message: `❌ Git Commit/Push gagal:\n<code>${escapeHtml(err.message)}</code>`
      });
    }
  });
}

/**
 * Performs git pull.
 */
export async function gitPull() {
  return new Promise((resolve) => {
    execFile('git', ['pull', 'origin', 'main'], { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          success: false,
          message: `❌ Git pull gagal:\n<code>${escapeHtml(stderr || err.message)}</code>`
        });
      }

      resolve({
        success: true,
        message:
          '⬇️ <b>Git Pull Selesai!</b>\n\n' +
          `<pre><code>${escapeHtml(stdout.trim() || 'Already up to date.')}</code></pre>`
      });
    });
  });
}

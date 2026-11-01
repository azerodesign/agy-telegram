/**
 * AGY Voice - Speech to Text Module
 * 
 * Converts incoming Telegram voice notes (.ogg/.oga) to 16kHz mono WAV via ffmpeg,
 * then transcribes via python speech_recognition (Indonesian & English).
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');

/**
 * Converts any audio file to 16kHz mono WAV suitable for speech recognition.
 */
export async function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-i', inputPath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '16000', '-ac', '1', outputPath, '-loglevel', 'error'],
      (err, stdout, stderr) => {
        if (err) {
          // Fallback to basic conversion if loudnorm filter fails
          execFile('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath, '-loglevel', 'error'], (fbErr, fbStdout, fbStderr) => {
            if (fbErr) return reject(new Error(`FFmpeg conversion failed: ${fbStderr || fbErr.message}`));
            resolve(outputPath);
          });
          return;
        }
        resolve(outputPath);
      }
    );
  });
}

/**
 * Transcribes a 16kHz WAV file into text using transcribe.py.
 */
export async function transcribeWav(wavPath) {
  return new Promise((resolve, reject) => {
    execFile('python3', [TRANSCRIBE_SCRIPT, wavPath], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr.trim() || err.message));
      }
      const text = stdout.trim();
      if (!text) {
        return reject(new Error('Suara tidak terdeteksi atau hening.'));
      }
      resolve(text);
    });
  });
}

/**
 * Complete pipeline: Converts input audio and transcribes it to text.
 * Automatically cleans up temporary files.
 */
export async function processVoiceNote(inputAudioPath) {
  const tempWav = path.join(os.tmpdir(), `agy_stt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    await convertToWav(inputAudioPath, tempWav);
    const transcript = await transcribeWav(tempWav);
    return {
      success: true,
      text: transcript
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  } finally {
    try {
      if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
    } catch (_) {}
  }
}

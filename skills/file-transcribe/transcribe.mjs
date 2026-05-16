#!/usr/bin/env node

/**
 * File Transcription via OpenKBS AI Proxy
 *
 * Transcribes audio/video files using Whisper through the OpenKBS proxy.
 * No OpenAI key needed — uses projectJWT for authentication and billing.
 * Language is auto-detected unless WHISPER_LANG is set.
 *
 * Usage:
 *   node transcribe.mjs <input-file> [output.txt]
 *
 * Env vars:
 *   WHISPER_LANG    — optional language hint (auto-detect if not set)
 *   CHUNK_SECONDS   — chunk size in seconds (default: 600)
 *   BATCH           — parallel requests (default: 4)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const MAX_WHISPER_SIZE = 25 * 1024 * 1024; // 25MB
const PROXY_URL = 'https://proxy.openkbs.com/v1/audio/transcriptions';

const SERVER_URL = process.env.SERVER_URL;
const KB_ID = process.env.KB_ID;
const PROJECT_DIR = process.env.OPENKBS_PROJECT_DIR || process.cwd();
const language = process.env.WHISPER_LANG || null;
const chunkSeconds = parseInt(process.env.CHUNK_SECONDS || '600', 10);
const BATCH = parseInt(process.env.BATCH || '4', 10);

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'transcript.txt';

if (!inputPath) {
  console.error('Usage: node transcribe.mjs <input-file> [output.txt]');
  process.exit(1);
}

if (!SERVER_URL || !KB_ID) {
  console.error('Error: Transcription requires hosted platform (SERVER_URL and KB_ID must be set)');
  process.exit(1);
}

const absInput = path.resolve(PROJECT_DIR, inputPath);
if (!fs.existsSync(absInput)) {
  console.error(`Error: input not found: ${absInput}`);
  process.exit(1);
}

function readProjectJWT() {
  const jwtPath = path.join(process.env.HOME || os.homedir(), '.openkbs', 'projectJWT');
  try {
    return fs.readFileSync(jwtPath, 'utf-8').trim();
  } catch {
    console.error('Error: projectJWT not found. Authentication required.');
    process.exit(1);
  }
}

function isVideo(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'quiet', '-show_streams', '-select_streams', 'v', '-of', 'csv=p=0', filePath,
    ], { encoding: 'utf-8', timeout: 15000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function extractAudio(input, output) {
  console.log(`Extracting audio → ${path.basename(output)}`);
  execFileSync('ffmpeg', [
    '-y', '-i', input,
    '-vn', '-acodec', 'libmp3lame',
    '-ab', '128k', '-ar', '16000', '-ac', '1',
    output,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300000 });
}

function reencodeToMp3(input, output) {
  console.log(`Re-encoding → ${path.basename(output)}`);
  execFileSync('ffmpeg', [
    '-y', '-i', input,
    '-acodec', 'libmp3lame',
    '-ab', '128k', '-ar', '16000', '-ac', '1',
    output,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300000 });
}

function splitChunks(input, chunksDir) {
  console.log(`Splitting into ${chunkSeconds}s chunks`);
  fs.mkdirSync(chunksDir, { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-i', input,
    '-f', 'segment', '-segment_time', String(chunkSeconds),
    '-c', 'copy',
    path.join(chunksDir, 'chunk_%03d.mp3'),
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300000 });
}

function buildPublicUrl(relPath) {
  const serverHost = SERVER_URL.replace(/^https?:\/\//, '');
  return `https://p-${KB_ID}.${serverHost}/${relPath}`;
}

async function transcribeUrl(audioUrl, jwt) {
  const body = { audio: audioUrl, model: 'whisper-1' };
  if (language) body.language = language;

  const response = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.message || errBody.error?.message || `Transcription failed: ${response.status}`);
  }

  const result = await response.json();
  return result.text || '';
}

async function transcribeBatched(urls, jwt) {
  const results = new Array(urls.length);

  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(urls.length / BATCH);
    console.log(`  batch ${batchNum}/${totalBatches} (${batch.length} chunks)`);

    const batchResults = await Promise.all(
      batch.map((url, idx) => transcribeUrl(url, jwt).then(text => {
        const preview = text.slice(0, 80).replace(/\s+/g, ' ');
        console.log(`    chunk ${i + idx + 1}: ${preview}...`);
        return { index: i + idx, text };
      }))
    );

    for (const r of batchResults) {
      results[r.index] = r.text;
    }
  }

  return results.filter(Boolean).join('\n\n');
}

async function main() {
  const jwt = readProjectJWT();
  const timestamp = Date.now();
  const tmpRelDir = `_tmp/transcribe-${timestamp}`;
  const tmpDir = path.join(PROJECT_DIR, 'site', tmpRelDir);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    let audioPath = absInput;
    const needsExtract = isVideo(absInput);
    const ext = path.extname(absInput).toLowerCase();

    if (needsExtract) {
      console.log('Detected video file');
      audioPath = path.join(tmpDir, 'audio.mp3');
      extractAudio(absInput, audioPath);
    } else if (ext !== '.mp3') {
      console.log(`Detected audio file (${ext})`);
      audioPath = path.join(tmpDir, 'audio.mp3');
      reencodeToMp3(absInput, audioPath);
    } else {
      console.log('Detected MP3 audio file');
    }

    const audioSize = fs.statSync(audioPath).size;
    console.log(`Audio size: ${(audioSize / 1024 / 1024).toFixed(1)} MB`);

    let fullText;

    if (audioSize <= MAX_WHISPER_SIZE) {
      console.log('File under 25MB — sending directly to Whisper');
      const destName = 'audio.mp3';
      const destPath = path.join(tmpDir, destName);
      if (audioPath !== destPath) {
        fs.copyFileSync(audioPath, destPath);
      }
      const url = buildPublicUrl(`${tmpRelDir}/${destName}`);
      fullText = await transcribeUrl(url, jwt);
    } else {
      console.log('File over 25MB — splitting into chunks');
      const chunksDir = path.join(tmpDir, 'chunks');
      splitChunks(audioPath, chunksDir);

      const chunkFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp3')).sort();
      console.log(`Transcribing ${chunkFiles.length} chunks (batch=${BATCH})`);

      const urls = chunkFiles.map(f => buildPublicUrl(`${tmpRelDir}/chunks/${f}`));
      fullText = await transcribeBatched(urls, jwt);
    }

    const absOutput = path.resolve(PROJECT_DIR, outputPath);
    fs.writeFileSync(absOutput, fullText);
    console.log(`\nDone! Wrote ${fullText.length} chars to ${outputPath}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * File Transcription — OpenKBS Proxy or direct OpenAI
 *
 * Two modes:
 *   1. OpenKBS Studio (SERVER_URL + KB_ID set) → uses proxy.openkbs.com, no API key needed
 *   2. Standalone (OPENAI_KEY set) → calls OpenAI Whisper API directly
 *
 * Usage:
 *   node transcribe.mjs <input-file> [output.txt]
 *
 * Env vars:
 *   OPENAI_KEY      — OpenAI API key (used when SERVER_URL/KB_ID are not set)
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
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

const SERVER_URL = process.env.SERVER_URL;
const KB_ID = process.env.KB_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const PROJECT_DIR = process.env.OPENKBS_PROJECT_DIR || process.cwd();
const language = process.env.WHISPER_LANG || null;
const chunkSeconds = parseInt(process.env.CHUNK_SECONDS || '600', 10);
const BATCH = parseInt(process.env.BATCH || '4', 10);

const useProxy = !!(SERVER_URL && KB_ID);

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'transcript.txt';

if (!inputPath) {
  console.error('Usage: node transcribe.mjs <input-file> [output.txt]');
  process.exit(1);
}

if (!useProxy && !OPENAI_KEY) {
  console.error('Error: No transcription backend available.');
  console.error('  Option 1: Run inside OpenKBS Studio (SERVER_URL + KB_ID are set automatically)');
  console.error('  Option 2: Set OPENAI_KEY environment variable for direct OpenAI Whisper access');
  process.exit(1);
}

const absInput = path.resolve(PROJECT_DIR, inputPath);
if (!fs.existsSync(absInput)) {
  console.error(`Error: input not found: ${absInput}`);
  process.exit(1);
}

if (useProxy) {
  console.log('Mode: OpenKBS proxy');
} else {
  console.log('Mode: Direct OpenAI API');
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

// ── Proxy mode: send URL to proxy.openkbs.com ──

async function transcribeViaProxy(audioUrl, jwt) {
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

// ── Direct mode: upload file to OpenAI API ──

async function transcribeViaOpenAI(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('model', 'whisper-1');
  if (language) formData.append('language', language);

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error?.message || `Transcription failed: ${response.status}`);
  }

  const result = await response.json();
  return result.text || '';
}

// ── Batched transcription (works for both modes) ──

async function transcribeBatched(items, transcribeFn) {
  const results = new Array(items.length);

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(items.length / BATCH);
    console.log(`  batch ${batchNum}/${totalBatches} (${batch.length} chunks)`);

    const batchResults = await Promise.all(
      batch.map((item, idx) => transcribeFn(item).then(text => {
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

// ── Main ──

async function main() {
  const timestamp = Date.now();
  const workDir = path.join(os.tmpdir(), `transcribe-${timestamp}`);
  let proxyTmpDir = null;

  if (useProxy) {
    const tmpRelDir = `_tmp/transcribe-${timestamp}`;
    proxyTmpDir = path.join(PROJECT_DIR, 'site', tmpRelDir);
    fs.mkdirSync(proxyTmpDir, { recursive: true });
  }
  fs.mkdirSync(workDir, { recursive: true });

  const tmpDir = proxyTmpDir || workDir;

  try {
    let audioPath = absInput;
    const needsExtract = isVideo(absInput);
    const ext = path.extname(absInput).toLowerCase();

    if (needsExtract) {
      console.log('Detected video file');
      audioPath = path.join(workDir, 'audio.mp3');
      extractAudio(absInput, audioPath);
    } else if (ext !== '.mp3') {
      console.log(`Detected audio file (${ext})`);
      audioPath = path.join(workDir, 'audio.mp3');
      reencodeToMp3(absInput, audioPath);
    } else {
      console.log('Detected MP3 audio file');
    }

    const audioSize = fs.statSync(audioPath).size;
    console.log(`Audio size: ${(audioSize / 1024 / 1024).toFixed(1)} MB`);

    let fullText;

    if (audioSize <= MAX_WHISPER_SIZE) {
      console.log('File under 25MB — sending directly to Whisper');

      if (useProxy) {
        const jwt = readProjectJWT();
        const destName = 'audio.mp3';
        const destPath = path.join(proxyTmpDir, destName);
        fs.copyFileSync(audioPath, destPath);
        const tmpRelDir = `_tmp/transcribe-${timestamp}`;
        const url = buildPublicUrl(`${tmpRelDir}/${destName}`);
        fullText = await transcribeViaProxy(url, jwt);
      } else {
        fullText = await transcribeViaOpenAI(audioPath);
      }
    } else {
      console.log('File over 25MB — splitting into chunks');
      const chunksDir = path.join(workDir, 'chunks');
      splitChunks(audioPath, chunksDir);

      const chunkFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp3')).sort();
      console.log(`Transcribing ${chunkFiles.length} chunks (batch=${BATCH})`);

      if (useProxy) {
        const jwt = readProjectJWT();
        const tmpRelDir = `_tmp/transcribe-${timestamp}`;
        const proxyChunksDir = path.join(proxyTmpDir, 'chunks');
        fs.mkdirSync(proxyChunksDir, { recursive: true });
        for (const f of chunkFiles) {
          fs.copyFileSync(path.join(chunksDir, f), path.join(proxyChunksDir, f));
        }
        const urls = chunkFiles.map(f => buildPublicUrl(`${tmpRelDir}/chunks/${f}`));
        fullText = await transcribeBatched(urls, url => transcribeViaProxy(url, jwt));
      } else {
        const filePaths = chunkFiles.map(f => path.join(chunksDir, f));
        fullText = await transcribeBatched(filePaths, transcribeViaOpenAI);
      }
    }

    const absOutput = path.resolve(PROJECT_DIR, outputPath);
    fs.writeFileSync(absOutput, fullText);
    console.log(`\nDone! Wrote ${fullText.length} chars to ${outputPath}`);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    if (proxyTmpDir) {
      try { fs.rmSync(proxyTmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});

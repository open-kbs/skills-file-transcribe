#!/usr/bin/env node

/**
 * File transcription via the OpenKBS AI proxy — Gemini.
 *
 * Default engine is gemini-flash-latest (a chat model given the audio and a
 * transcription prompt): on real meetings it keeps cross-talk and hard
 * passages, follows a vocabulary list and labels speakers. MODEL=gemini-3.5-transcribe
 * switches to the dedicated STT model — cheaper, word-level timestamps, but
 * it silently skips hard passages of multi-speaker recordings.
 * Languages are auto-detected (code-switching inside one file is fine).
 *
 * Two modes:
 *   1. OpenKBS Studio (SERVER_URL + KB_ID set) → proxy.openkbs.com, billed to
 *      the project's credits through projectJWT; no vendor key needed
 *   2. Standalone (GEMINI_API_KEY set) → calls the Gemini API directly
 *
 * Usage:
 *   node transcribe.mjs <input-file> [output.txt]
 *
 * Env vars (all optional):
 *   MODEL            gemini-flash-latest (default) | gemini-3.5-transcribe
 *   TRANSCRIBE_LANG  language hint, ISO-639-1 or BCP-47 (bg, en, de-DE).
 *                    Omit to auto-detect. (WHISPER_LANG still works.)
 *   STYLE            smart (default: punctuation, formatting, fillers removed)
 *                    | verbatim (every word as spoken). MODE still works.
 *   SPEAKERS=1       label speakers ("Speaker 1: …")
 *   TIMESTAMPS=1     [hh:mm:ss] per paragraph (+ <output>.words.json with
 *                    word-level times on gemini-3.5-transcribe)
 *   VOCAB            comma-separated names/terms to spell right (on
 *                    gemini-3.5-transcribe not combinable with SPEAKERS/TIMESTAMPS)
 *   CHUNK_SECONDS    split point for long recordings (default 1800 = 30 min)
 *   BATCH            parallel chunk requests (default 2)
 *   GEMINI_API_KEY   standalone mode (used when SERVER_URL/KB_ID are not set)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const DEDICATED_MODEL = 'gemini-3.5-transcribe';
const MODEL = process.env.MODEL || 'gemini-flash-latest';
const dedicated = MODEL === DEDICATED_MODEL;
const PROXY_URL = process.env.OPENKBS_PROXY_URL || 'https://proxy.openkbs.com/v1/audio/transcriptions';
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024; // proxy accepts 100 MB per request
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const GEMINI_INLINE_MAX_BYTES = 14 * 1024 * 1024; // 20 MB request cap, base64 inflates by 4/3

const SERVER_URL = process.env.SERVER_URL;
const KB_ID = process.env.KB_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const useProxy = !!(SERVER_URL && KB_ID);
const PROJECT_DIR = process.env.OPENKBS_PROJECT_DIR || process.cwd();
const language = process.env.TRANSCRIBE_LANG || process.env.WHISPER_LANG || null;
const speakers = process.env.SPEAKERS === '1';
const timestamps = process.env.TIMESTAMPS === '1';
const style = process.env.STYLE || process.env.MODE;
// The dedicated model gives speakers/timestamps only in verbatim mode; the
// chat engine takes them as prompt instructions in either style.
const mode = style === 'verbatim' || (dedicated && (speakers || timestamps)) ? 'verbatim' : 'smart';
const vocabulary = (process.env.VOCAB || '').split(',').map(s => s.trim()).filter(Boolean);
// Standalone sends the audio inline, so chunks must stay under ~14 MB: at
// 64 kbps that is 25 minutes.
const chunkSeconds = parseInt(process.env.CHUNK_SECONDS || (useProxy ? '1800' : '1500'), 10);
const BATCH = parseInt(process.env.BATCH || '2', 10);

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'transcript.txt';

if (!inputPath) {
  console.error('Usage: node transcribe.mjs <input-file> [output.txt]');
  process.exit(1);
}
if (!useProxy && !GEMINI_API_KEY) {
  console.error('Error: No transcription backend available.');
  console.error('  Option 1: Run inside OpenKBS Studio (SERVER_URL + KB_ID are set automatically)');
  console.error('  Option 2: Set GEMINI_API_KEY for direct Gemini API access');
  process.exit(1);
}
if (dedicated && vocabulary.length && (speakers || timestamps)) {
  console.error('Error: on gemini-3.5-transcribe VOCAB cannot be combined with SPEAKERS or TIMESTAMPS');
  process.exit(1);
}

const absInput = path.resolve(PROJECT_DIR, inputPath);
if (!fs.existsSync(absInput)) {
  console.error(`Error: input not found: ${absInput}`);
  process.exit(1);
}

function readProjectJWT() {
  if (!useProxy) return null;
  const jwtPath = path.join(process.env.HOME || os.homedir(), '.openkbs', 'projectJWT');
  try {
    return fs.readFileSync(jwtPath, 'utf-8').trim();
  } catch {
    console.error('Error: projectJWT not found. Authentication required.');
    process.exit(1);
  }
}

function ffprobe(args) {
  return execFileSync('ffprobe', ['-v', 'quiet', ...args], { encoding: 'utf-8', timeout: 15000 }).trim();
}

function isVideo(filePath) {
  try {
    return ffprobe(['-show_streams', '-select_streams', 'v', '-of', 'csv=p=0', filePath]).length > 0;
  } catch {
    return false;
  }
}

function durationSeconds(filePath) {
  try {
    return parseFloat(ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', filePath])) || 0;
  } catch {
    return 0;
  }
}

// One mono 16 kHz MP3 for everything the model sees: ~0.5 MB per minute, so a
// 30-minute chunk is ~14 MB and a 3-hour recording still fits one upload.
function toMp3(input, output, label) {
  console.log(`${label} → ${path.basename(output)}`);
  execFileSync('ffmpeg', [
    '-y', '-i', input,
    '-vn', '-acodec', 'libmp3lame',
    '-ab', '64k', '-ar', '16000', '-ac', '1',
    output,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 1800000 });
}

function splitChunks(input, chunksDir) {
  console.log(`Splitting into ${chunkSeconds}s chunks`);
  fs.mkdirSync(chunksDir, { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-i', input,
    '-f', 'segment', '-segment_time', String(chunkSeconds),
    '-c', 'copy',
    path.join(chunksDir, 'chunk_%03d.mp3'),
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600000 });
}

function buildPublicUrl(relPath) {
  const serverHost = SERVER_URL.replace(/^https?:\/\//, '');
  return `https://p-${KB_ID}.${serverHost}/${relPath}`;
}

let totalCredits = 0;

// One chunk → { text, words }. `relPath` is the file under site/ (served by the
// preview server in proxy mode); `filePath` is the same file on disk.
async function transcribeChunk(relPath, filePath, jwt) {
  const once = () => {
    if (useProxy) return transcribeViaProxy(buildPublicUrl(relPath), jwt);
    return dedicated ? transcribeViaGemini(filePath) : transcribeViaGeminiChat(filePath);
  };
  // Google's prompt filter blocks a chunk only sometimes; a second try clears it.
  try {
    return await once();
  } catch (err) {
    if (!/blocked/i.test(err.message)) throw err;
    console.log(`    blocked once, retrying: ${err.message}`);
    return once();
  }
}

// Same instruction the proxy gives a chat model.
function transcriptionPrompt() {
  const lines = [
    'Transcribe this audio recording.',
    'Output only the transcript, nothing else: no preamble, no headings, no notes, no closing remarks.',
    'Keep every sentence in the language it was spoken; do not translate.',
    mode === 'verbatim'
      ? 'Write every word exactly as spoken, including repetitions, false starts and filler words.'
      : 'Write clean, readable text: proper punctuation and capitalisation, drop filler sounds and false starts, keep every meaningful word — do not summarise or skip passages, even hard-to-hear or overlapping ones (transcribe your best hearing of them).',
  ];
  if (language) lines.push(`The language of the recording is "${language}".`);
  if (speakers) lines.push('Label speakers as "Speaker 1:", "Speaker 2:", … numbered by first appearance; start a new paragraph whenever the speaker changes.');
  if (timestamps) lines.push('Begin each paragraph with the time it starts in the audio, as [mm:ss] (or [h:mm:ss] past one hour).');
  if (!speakers && !timestamps) lines.push('Split the text into paragraphs at natural pauses and topic changes.');
  if (vocabulary.length) lines.push(`Names and terms that occur in the recording — spell them exactly like this: ${vocabulary.join(', ')}.`);
  return lines.join(' ');
}

async function transcribeViaGeminiChat(filePath) {
  const audio = fs.readFileSync(filePath);
  if (audio.length > GEMINI_INLINE_MAX_BYTES) {
    throw new Error(`Chunk too large for inline upload (${(audio.length / 1024 / 1024).toFixed(1)} MB) — lower CHUNK_SECONDS`);
  }
  const call = (thinkingOff) => fetch(GEMINI_GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mp3', data: audio.toString('base64') } }, { text: transcriptionPrompt() }] }],
      generationConfig: { temperature: 0, ...(thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
    }),
  });
  let response = await call(true);
  let bodyText = await response.text();
  if (response.status === 400 && /thinking/i.test(bodyText)) { response = await call(false); bodyText = await response.text(); }
  if (!response.ok) {
    let msg = `Gemini request failed: ${response.status}`;
    try { msg = JSON.parse(bodyText).error?.message || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  const parsed = JSON.parse(bodyText);
  if (parsed.promptFeedback?.blockReason) throw new Error(`Transcription blocked (${parsed.promptFeedback.blockReason})`);
  const parts = parsed.candidates?.[0]?.content?.parts || [];
  return { text: parts.map(p => p.text || '').join('').trim(), words: [] };
}

// ── Proxy mode: the proxy fetches the clip by URL and bills the project ──

async function transcribeViaProxy(audioUrl, jwt) {
  const body = { audio: audioUrl, model: MODEL, mode };
  if (language) body.language = language;
  if (speakers) body.diarization = true;
  if (timestamps) body.timestamps = true;
  if (vocabulary.length) body.vocabulary = vocabulary;

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
    throw new Error(errBody.error?.message || errBody.error || errBody.message || `Transcription failed: ${response.status}`);
  }

  totalCredits += Number(response.headers.get('x-openkbs-cost-credits')) || 0;
  const result = await response.json();
  return { text: result.text || '', words: Array.isArray(result.words) ? result.words : [] };
}

// ── Standalone mode: Gemini Interactions API with the clip inline ──

async function transcribeViaGemini(filePath) {
  const audio = fs.readFileSync(filePath);
  if (audio.length > GEMINI_INLINE_MAX_BYTES) {
    throw new Error(`Chunk too large for inline upload (${(audio.length / 1024 / 1024).toFixed(1)} MB) — lower CHUNK_SECONDS`);
  }
  const transcription_config = {
    mode: mode === 'smart'
      ? 'smart'
      : { type: 'verbatim', ...(timestamps ? { timestamp_granularities: ['word'] } : {}), ...(speakers ? { diarization_mode: 'speaker' } : {}) },
  };
  if (language) transcription_config.language_codes = [language];
  if (vocabulary.length) transcription_config.custom_vocabulary = vocabulary;

  const response = await fetch(GEMINI_INTERACTIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      model: DEDICATED_MODEL,
      input: [{ type: 'audio', data: audio.toString('base64'), mime_type: 'audio/mp3' }],
      generation_config: { transcription_config },
    }),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error?.message || `Gemini request failed: ${response.status}`);
  }
  const interaction = await response.json();
  if (interaction.status && interaction.status !== 'completed') {
    throw new Error(`Transcription ${interaction.status}`);
  }
  // The REST body has no output_text: the transcript is the text content of
  // the model_output step(s), word_info annotations beside it.
  const sec = (v) => (typeof v === 'string' ? parseFloat(v) || 0 : 0);
  const texts = [];
  const words = [];
  for (const step of interaction.steps || []) {
    for (const c of step.content || []) {
      if (c.type !== 'text' || typeof c.text !== 'string') continue;
      texts.push(c.text);
      for (const a of c.annotations || []) {
        if (a.type !== 'word_info') continue;
        words.push({ word: a.text, start: sec(a.start_offset), end: sec(a.end_offset), ...(a.speaker ? { speaker: a.speaker } : {}) });
      }
    }
  }
  return { text: texts.join('\n').trim(), words };
}

async function transcribeBatched(items, jwt) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    console.log(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(items.length / BATCH)} (${batch.length} chunks)`);
    const batchResults = await Promise.all(
      batch.map((it, idx) => transcribeChunk(it.relPath, it.filePath, jwt).then(r => {
        console.log(`    chunk ${i + idx + 1}: ${r.text.slice(0, 80).replace(/\s+/g, ' ')}...`);
        return { index: i + idx, ...r };
      }))
    );
    for (const r of batchResults) results[r.index] = r;
  }
  return results;
}

function hms(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// Plain text unless speakers/timestamps were asked for; then one paragraph per
// speaker turn, prefixed with the label and/or the start time. Speaker labels
// restart in every chunk (each chunk is its own request), so a "Speaker 1" in
// chunk 2 need not be chunk 1's "Speaker 1" — keep multi-speaker recordings
// under one CHUNK_SECONDS when that matters.
// "[mm:ss]" / "[h:mm:ss]" at a line start → the same stamp shifted into the
// whole recording's timeline.
function shiftStamps(text, offsetSec) {
  return text.replace(/^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/gm, (_, a, b, c) => {
    const sec = c != null ? (+a) * 3600 + (+b) * 60 + (+c) : (+a) * 60 + (+b);
    return `[${hms(sec + offsetSec)}]`;
  });
}

function formatChunk(chunk, offsetSec) {
  if (!speakers && !timestamps) return chunk.text.trim();
  if (!chunk.words.length) return shiftStamps(chunk.text.trim(), offsetSec);

  const speakerNo = new Map();
  const label = (spk) => {
    if (!speakerNo.has(spk)) speakerNo.set(spk, speakerNo.size + 1);
    return `Speaker ${speakerNo.get(spk)}`;
  };

  const paragraphs = [];
  let current = null;
  for (const w of chunk.words) {
    const spk = speakers ? (w.speaker ?? 'spk:0') : 'all';
    if (!current || current.spk !== spk) {
      current = { spk, start: (w.start ?? 0) + offsetSec, words: [] };
      paragraphs.push(current);
    }
    current.words.push(w.word);
  }
  return paragraphs.map(p => {
    const prefix = [timestamps ? `[${hms(p.start)}]` : '', speakers ? `${label(p.spk)}:` : ''].filter(Boolean).join(' ');
    return `${prefix} ${p.words.join(' ')}`.trim();
  }).join('\n\n');
}

async function main() {
  const jwt = readProjectJWT();
  const tmpRelDir = `_tmp/transcribe-${Date.now()}`;
  const tmpDir = path.join(PROJECT_DIR, 'site', tmpRelDir);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const audioPath = path.join(tmpDir, 'audio.mp3');
    toMp3(absInput, audioPath, isVideo(absInput) ? 'Extracting audio' : 'Preparing audio');

    const duration = durationSeconds(audioPath);
    const audioSize = fs.statSync(audioPath).size;
    console.log(`Audio: ${hms(duration)}, ${(audioSize / 1024 / 1024).toFixed(1)} MB, ${MODEL} ${useProxy ? 'via OpenKBS proxy' : 'direct'}, style=${mode}${language ? `, lang=${language}` : ''}${speakers ? ', speakers' : ''}${timestamps ? ', timestamps' : ''}`);

    let chunks;
    let offsets;
    if (duration <= chunkSeconds && audioSize <= (useProxy ? MAX_UPLOAD_BYTES : GEMINI_INLINE_MAX_BYTES)) {
      console.log('Single request');
      chunks = [await transcribeChunk(`${tmpRelDir}/audio.mp3`, audioPath, jwt)];
      offsets = [0];
    } else {
      const chunksDir = path.join(tmpDir, 'chunks');
      splitChunks(audioPath, chunksDir);
      const chunkFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp3')).sort();
      console.log(`Transcribing ${chunkFiles.length} chunks (batch=${BATCH})`);
      chunks = await transcribeBatched(chunkFiles.map(f => ({ relPath: `${tmpRelDir}/chunks/${f}`, filePath: path.join(chunksDir, f) })), jwt);
      offsets = chunkFiles.map((_, i) => i * chunkSeconds);
    }

    const fullText = chunks.map((c, i) => formatChunk(c, offsets[i])).filter(Boolean).join('\n\n');
    const absOutput = path.resolve(PROJECT_DIR, outputPath);
    fs.writeFileSync(absOutput, fullText + '\n');

    if (timestamps && chunks.some(c => c.words.length)) {
      const words = chunks.flatMap((c, i) => c.words.map(w => ({
        ...w,
        start: (w.start ?? 0) + offsets[i],
        end: (w.end ?? 0) + offsets[i],
      })));
      const wordsPath = absOutput.replace(/\.[^.]+$/, '') + '.words.json';
      fs.writeFileSync(wordsPath, JSON.stringify(words));
      console.log(`Word timestamps: ${path.relative(PROJECT_DIR, wordsPath)} (${words.length} words)`);
    }

    console.log(`\nDone! Wrote ${fullText.length} chars to ${outputPath}${useProxy ? ` — cost ${(totalCredits / 1000).toFixed(2)} credits` : ''}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});

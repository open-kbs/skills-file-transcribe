---
name: file-transcribe
description: Transcribe audio/video files to text with Gemini via the OpenKBS AI proxy — languages auto-detected, optional speaker labels, timestamps and a vocabulary of names/terms. Supports MP4, MP3, WAV, OGG, MKV and other ffmpeg-readable formats; long recordings are chunked automatically.
allowed-tools: Bash(node *transcribe.mjs*)
---

# File Transcription Skill

Transcribes audio or video files with Gemini through the OpenKBS AI proxy. No
API key needed — billed to the project's credits per token, like a chat call
(the last line prints the credits spent). Languages are auto-detected; mixed
languages inside one recording are fine.

Default engine: `gemini-flash-latest` — keeps cross-talk and hard passages,
follows a vocabulary list, labels speakers. `MODEL=gemini-3.5-transcribe`
switches to Google's dedicated STT model: cheaper and gives word-level
timestamps, but it silently skips hard passages of multi-speaker recordings,
so use it for clean single-speaker audio only.

## When to use

- Transcribe an audio file (MP3, WAV, OGG, FLAC, M4A, …)
- Transcribe a video file (MP4, MKV, MOV, AVI, WebM, …)
- Meeting / interview / lecture / podcast → text, optionally with who said what

## Command

```bash
node .claude/skills/file-transcribe/transcribe.mjs <input-file> [output.txt]
```

(`.agents/skills/file-transcribe/` if it was installed with `npx skills add`.)

- `<input-file>` — audio or video file (required)
- `[output.txt]` — output path (default `transcript.txt`)

## Examples

```bash
# Auto-detected language, clean readable text
node .claude/skills/file-transcribe/transcribe.mjs .uploads/meeting.mp3

# Who said what (Speaker 1 / Speaker 2 …) with a time per paragraph
SPEAKERS=1 TIMESTAMPS=1 node .claude/skills/file-transcribe/transcribe.mjs .uploads/interview.mp4 interview.txt

# Language hint + names/terms the model must spell right
TRANSCRIBE_LANG=bg VOCAB="Пламен,OpenKBS,Kubernetes" node .claude/skills/file-transcribe/transcribe.mjs .uploads/call.ogg

# Cheap dedicated STT model with word-level timestamps (clean single-speaker audio)
MODEL=gemini-3.5-transcribe TIMESTAMPS=1 node .claude/skills/file-transcribe/transcribe.mjs .uploads/lecture.mp3
```

## Options (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `gemini-flash-latest` | or `gemini-3.5-transcribe` (see above) |
| `TRANSCRIBE_LANG` | auto | Language hint: `bg`, `en`, `de-DE` … |
| `STYLE` | `smart` | `smart` = punctuation, formatting, fillers removed; `verbatim` = every word as spoken |
| `SPEAKERS` | off | `1` → "Speaker N:" paragraphs |
| `TIMESTAMPS` | off | `1` → `[hh:mm:ss]` at the start of each paragraph; with `MODEL=gemini-3.5-transcribe` also `<output>.words.json` (word-level start/end) |
| `VOCAB` | — | Comma-separated names/terms to spell right (on gemini-3.5-transcribe not combinable with `SPEAKERS`/`TIMESTAMPS`) |
| `CHUNK_SECONDS` | `1800` | Split point for long recordings. Capped at 3600 (one proxy call must finish in 3 min); 1800 on gemini-3.5-transcribe with `SPEAKERS`/`TIMESTAMPS` (its per-call limit). Standalone default 1500 |
| `BATCH` | `2` | Parallel chunk requests |

## How it works

1. ffmpeg converts the input (audio track of a video included) to mono 16 kHz MP3
2. Recordings longer than `CHUNK_SECONDS` are split into chunks
3. Each chunk is served from the preview server and sent to the proxy's
   `/v1/audio/transcriptions` with the chosen model
4. Results are stitched in order (chunk offsets added to timestamps) and written out
5. Temporary files are removed

Speaker labels are per chunk: in a long recording "Speaker 1" of chunk 2 is not
guaranteed to be chunk 1's "Speaker 1". For multi-speaker files that must stay
consistent, keep the recording under one chunk (`CHUNK_SECONDS` up to 3600).
On gemini-3.5-transcribe, `SPEAKERS`/`TIMESTAMPS` force verbatim style. A chunk
that ends with a `finish_reason` warning was cut short by the model's output
limit — lower `CHUNK_SECONDS`.

## Requirements

- `ffmpeg` (`sudo apt-get update && sudo apt-get install -y ffmpeg` if `ffmpeg -version` fails)
- Hosted platform (`SERVER_URL` and `KB_ID` are set in Studio containers), or
  `GEMINI_API_KEY` for standalone use outside Studio

## Workflow

1. Verify the input file exists (`.uploads/` or the path the user gave)
2. Run the command; the last line prints the credits spent
3. Read the output file and present the transcript to the user
4. Move/save the transcript where the user wants it

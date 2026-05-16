---
name: file-transcribe
description: Transcribe audio/video files to text using Whisper via OpenKBS AI proxy. Supports MP4, MP3, WAV, OGG, MKV and other ffmpeg-compatible formats. Splits large files into chunks automatically.
allowed-tools: Bash(node *transcribe.mjs*)
---

# File Transcription Skill

Transcribe audio or video files to text using OpenAI Whisper, routed through the OpenKBS AI proxy. No API key needed — uses the project's credits. Language is auto-detected from the audio.

## When to use

Use this skill when the user asks to:
- Transcribe an audio file (MP3, WAV, OGG, FLAC, M4A, etc.)
- Transcribe a video file (MP4, MKV, MOV, AVI, WebM, etc.)
- Convert speech to text from any media file
- Get a text version of a recording, meeting, lecture, podcast, etc.

## Command

```bash
node .agents/skills/file-transcribe/transcribe.mjs <input-file> [output.txt]
```

- `<input-file>` — path to audio or video file (required)
- `[output.txt]` — output text file path (optional, defaults to `transcript.txt`)

## Examples

```bash
# Transcribe an uploaded MP3 (language auto-detected)
node .agents/skills/file-transcribe/transcribe.mjs .uploads/meeting.mp3

# Transcribe a video with custom output path
node .agents/skills/file-transcribe/transcribe.mjs .uploads/lecture.mp4 lecture_transcript.txt

# Force a specific language hint
WHISPER_LANG=en node .agents/skills/file-transcribe/transcribe.mjs .uploads/podcast.mp3
```

## Environment variables (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_LANG` | *(auto-detect)* | Language hint for Whisper (e.g. `en`, `bg`, `de`) |
| `CHUNK_SECONDS` | `600` | Chunk duration in seconds (for large files) |
| `BATCH` | `4` | Parallel transcription requests |

## How it works

1. Detects if input is video or audio
2. For video: extracts audio track as MP3
3. Checks file size — files under 25MB go directly to Whisper; larger files are split into chunks
4. Uploads to the preview server and calls the OpenKBS Whisper proxy
5. Stitches chunk results in order and writes the final transcript
6. Cleans up all temporary files

## Requirements

- `ffmpeg` must be installed (available in Studio containers)
- Hosted platform only (needs `SERVER_URL` and `KB_ID`)

## Workflow

1. Verify the input file exists (check `.uploads/` or the path the user specified)
2. Run the transcription command
3. Read the output file and present the transcript to the user
4. If the user wants, save/move the transcript to a specific location

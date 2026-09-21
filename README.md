# OpenKBS Skills

Skills for [OpenKBS Studio](https://github.com/open-kbs/openkbs-studio) AI coding agent.

## Available Skills

### file-transcribe

Transcribe audio/video files to text with Gemini via the OpenKBS AI proxy (or standalone with `GEMINI_API_KEY`). Languages auto-detected, optional speaker labels, timestamps and a vocabulary of names/terms. Supports MP4, MP3, WAV, OGG, MKV and other ffmpeg-compatible formats; long recordings are chunked automatically.

**Install:**
```bash
npx skills add openkbs/skills
```

## License

MIT

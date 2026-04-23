# MarketingVideo

Standalone CLI tool for creating commercial-ready teaching/marketing videos from structured slide content.

Pipeline:

- HTML slides (`slides.html`)
- Auto screenshot to PNG
- TTS narration per slide
- SRT subtitle generation
- MP4 rendering and concatenation

## Quick Start

### 1. Install deps

```bash
npm install
```

### 2. Install Playwright browser runtime (first run only)

```bash
npx playwright install chromium
```

### 3. Configure env

```bash
cp .env.example .env
```

Fill at least:

- `GEMINI_API_KEY`
- `MINIMAX_API_KEY`

### 4. Initialize media folders

```bash
npm run init
```

## Typical Commands

```bash
# Generate one image asset
npm run video -- image --task-id demo --prompt "your prompt" --filename cover.jpg

# Validate slides HTML
npm run video -- validate --task-id demo

# Screenshot all slides (with auto-placeholder image fill)
npm run video -- screenshot --task-id demo

# TTS
npm run video -- tts --task-id demo --voice English_Explanatory_Man --tts-speed 1.0

# Subtitles
npm run video -- srt --task-id demo

# Render final MP4
npm run video -- render --task-id demo
```

Final output:

- `media/outbound/<task-id>.mp4`

## Project Layout

```text
.
├── AGENTS.md
├── README.md
├── package.json
├── scripts/
├── templates/
└── media/
    ├── assets/
    ├── inbound/
    ├── wip/
    └── outbound/
```

## Notes

- The default template assumes 1920x1080 production.
- `validate` enforces first/last slide structural constraints.
- If generated visuals contain readable text, regenerate them before render.

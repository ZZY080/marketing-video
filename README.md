# MarketingVideo

Standalone CLI tool for creating commercial-ready teaching/marketing videos from PPT slides and structured narration.

Pipeline:

- PPT slides (`slides.pptx`)
- Auto export to PNG frames
- TTS narration per slide
- SRT subtitle generation
- MP4 rendering and concatenation

## Quick Start

### 1. Install deps

```bash
npm install
```

### 2. Install PPT export and rendering dependencies

```bash
brew install --cask libreoffice
brew install poppler
brew install ffmpeg
```

### 3. Configure env

```bash
cp .env.example .env
```

Fill at least:

- `MINIMAX_API_KEY`
- `GEMINI_API_KEY` (optional, only for `image` command)

### 4. Initialize media folders

```bash
npm run init
```

## Typical Commands

```bash
# Generate one image asset
npm run video -- image --task-id demo --prompt "your prompt" --filename cover.jpg

# Export PPT to slide frames
npm run video -- ppt-screenshot --task-id demo

# Import scene/shot script JSON to segments
npm run video -- script-import --task-id demo --script-path /absolute/path/script.json

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

- Prepare `media/wip/<task-id>/slides.pptx` before running `ppt-screenshot`.
- If you use storyboard JSON format, run `script-import` first to generate `segments.json`.
- `render` validates slide frame continuity and segment mapping.
- Commands `screenshot` and `validate` are deprecated in PPT-only workflow.

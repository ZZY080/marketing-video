# MarketingVideo

Standalone CLI tool for creating commercial-ready teaching/marketing videos from PPT slides and structured narration.

**Agent / automation runs:** use [`AGENTS.md`](AGENTS.md) as the canonical guide (PDF-first frames to avoid missing text, chat-based slide review, `run-interactive` gates, and quality checklist).

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

# Export PPT to slide frames (auto prefers slides.pdf if present)
npm run video -- ppt-screenshot --task-id demo

# High-fidelity mode (recommended): export PDF from PowerPoint and use it directly
npm run video -- ppt-screenshot --task-id demo --pdf-path /absolute/path/slides.pdf

# Strict PDF mode (fail fast if PDF source is unavailable)
npm run video -- ppt-screenshot --task-id demo --strict-pdf

# Interactive full workflow (manual approval after each stage)
npm run video -- run-interactive --task-id demo

# Import scene/shot script JSON to segments
npm run video -- script-import --task-id demo --script-path /absolute/path/script.json

# TTS
npm run video -- tts --task-id demo --voice auto --tts-speed 1.0

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
- For best visual fidelity, export `slides.pdf` from Microsoft PowerPoint and place it at `media/wip/<task-id>/slides.pdf`.
- `ppt-screenshot` now auto-uses `slides.pdf` when no explicit `--pptx-path/--pdf-path` is provided, and will try auto-exporting PDF via PowerPoint on macOS if missing.
- If exported frames show missing/truncated text, do not continue to render; switch to PDF source and regenerate frames first.
- `run-interactive` pauses after `ppt-screenshot / tts / srt / qa` and asks for manual confirmation (`y/yes`) before continuing.
- `run-interactive` enforces PDF source for frame export; if `slides.pdf` is missing, it attempts PowerPoint auto-export first and fails fast if unavailable.
- `run-interactive` exports per-slide narration review file at `media/wip/<task-id>/review/slide-narration-review.md` and requires manual approval before TTS.
- During interactive screenshot QA, exported `slide-*.png` paths are printed for pre-review.
- In non-interactive terminals, `run-interactive` writes `media/wip/<task-id>/PENDING_APPROVAL.md` and pauses. Continue with `--approve-stage <stage>`.
- In chat-based review mode, slides must be delivered one-by-one in order, then reviewed as a full set; continue to next stage only after user says the full set is approved.
- If you use storyboard JSON format, run `script-import` first to generate `segments.json`.
- `render` validates slide frame continuity and segment mapping.
- Commands `screenshot` and `validate` are deprecated in PPT-only workflow.

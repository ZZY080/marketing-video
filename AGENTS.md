# Marketing Video Agent Guide (PPT-Only)

This repository produces teaching/marketing videos from PPT slides and narration assets.

Pipeline:

`source -> outline/script -> slides.pptx -> ppt-screenshot -> tts -> srt -> render -> final MP4`

Default output: `1920x1080` MP4, per-slide narration, burned subtitles, and zero-padded slide frames (`slide-001.png ...`).

---

## 1) Repository Scope

- `scripts/` - CLI and pipeline implementation (TypeScript via `tsx`)
- `media/` - runtime workspace
  - `assets/` - shared brand assets
  - `inbound/` - input source files
  - `wip/<task-id>/` - task artifacts
  - `outbound/` - final videos

Per-task artifacts (`media/wip/<task-id>/`):

```text
source.md
outline.md
slides.pptx
slides/slide-NNN.png
segments.json
audio/segment-NNN.mp3
subtitles/all.srt
subtitles/segment-NNN.srt
clips/clip-NNN.mp4
concat.txt
```

Final video: `media/outbound/<task-id>.mp4` (or custom `--out`).

---

## 2) Runtime and Environment

### 2.1 Prerequisites

```bash
node --version # >=20
npm install

# PPT export dependencies
# 1) LibreOffice (provides soffice/libreoffice)
# 2) poppler (provides pdftoppm)
# macOS:
brew install --cask libreoffice
brew install poppler

# ffmpeg/ffprobe for TTS probing + rendering
brew install ffmpeg
ffmpeg -version
ffprobe -version
```

### 2.2 Environment variables

Copy `.env.example` to `.env` and fill:

- `MINIMAX_API_KEY` (required for TTS)
- `GEMINI_API_KEY` (required only when using `image` command)
- `MARKETING_VIDEO_MEDIA_ROOT` (optional media root override)

### 2.3 CLI entry

All commands go through:

```bash
npm run video -- <command> [flags]
```

The `--` is required.

---

## 3) Core Workflow

### Step 0 - Prepare source

Save source material to:

`media/wip/<task-id>/source.md`

### Step 1 - Prepare script

Create:

`media/wip/<task-id>/segments.json`

Rules:

- `segments.length` must match slide count.
- `index` must be 1-based sequential.
- `slideIndex` must point to existing slide.
- `narration` must be final spoken text.
- Leave `audioPath` and `durationSeconds` empty before `tts`.

### Step 2 - Create `slides.pptx`

Create:

`media/wip/<task-id>/slides.pptx`

Design guidance:

- Target 16:9, ideally 1920x1080 visual layout.
- Keep headline and body readable after export.
- Avoid overflow, clipping, and tiny text.
- Keep CTA and brand information visible on the final slide.

### Step 3 - Export PPT to frames

```bash
npm run video -- ppt-screenshot --task-id <task-id>
```

Optional input override:

```bash
npm run video -- ppt-screenshot --task-id <task-id> --pptx-path /absolute/path/deck.pptx
```

Output:

- `media/wip/<task-id>/slides/slide-001.png`, `slide-002.png`, ...

### Step 4 - Visual QA (mandatory)

Check every exported `slide-*.png`:

- no text overflow/clipping
- clear contrast and hierarchy
- accurate numbers and claims
- visible visual difference across adjacent slides
- final slide contains CTA/contact/brand copy

If issues exist: edit PPT -> rerun `ppt-screenshot` -> recheck.

### Step 5 - TTS

```bash
npm run video -- tts --task-id <task-id> [--voice <minimax_voice_id>] [--tts-speed 1.0]
```

This writes:

- `audio/segment-NNN.mp3`
- `audioPath` + `durationSeconds` back into `segments.json`

### Step 6 - Subtitles

```bash
npm run video -- srt --task-id <task-id>
```

Generates:

- `subtitles/all.srt`
- `subtitles/segment-NNN.srt`

Subtitle policy (mandatory):

- Default mode must be `semantic` (normal subtitle switching), not full-page static subtitle.
- `strict-single` is only allowed when explicitly requested by the user.
- Subtitles must stay page-bound: each `segment-NNN.srt` may only contain text from slide `NNN` narration.
- Sync priority: use TTS timestamps when available to keep voice and subtitle timing aligned.
- English subtitles must preserve readable spacing between words; remove garbled replacement glyphs (for example `�` or square boxes).

### Step 7 - Render

```bash
npm run video -- render --task-id <task-id> [--out /absolute/path/output.mp4]
```

Render checks:

- slides exist and are sequentially numbered
- slide count matches `segments.length`
- all `slideIndex` references are valid
- each segment has `audioPath` + `durationSeconds`

---

## 4) CLI Reference

```bash
# initialize media layout
npm run video -- init

# generate one standalone image (optional helper)
npm run video -- image --task-id <id> --prompt "<prompt>" [--filename <name>.jpg]

# ppt -> slide frames
npm run video -- ppt-screenshot --task-id <id> [--pptx-path <absolute path>]

# narration synthesis
npm run video -- tts --task-id <id> [--voice <id>] [--tts-speed <0.5-2.0>]

# subtitle generation
npm run video -- srt --task-id <id>

# final mp4 rendering
npm run video -- render --task-id <id> [--out <absolute path>]
```

Deprecated commands:

- `screenshot` (HTML flow removed)
- `validate` (HTML validation removed)

---

## 5) Quality Gate

A task is complete only when:

- [ ] `slides.pptx` exists and exports cleanly.
- [ ] `ppt-screenshot` generated `slide-001...slide-NNN`.
- [ ] `segments.json` exists and slide count matches frames.
- [ ] Visual QA passed for every frame.
- [ ] `tts` filled `audioPath` + `durationSeconds` for all segments.
- [ ] `subtitles/all.srt` exists.
- [ ] Subtitle style is normal switching (not static full-page subtitle), unless user explicitly requested static subtitle.
- [ ] Subtitle text is page-related (no cross-page carryover).
- [ ] Spot-check subtitle timing against audio on at least 2 slides (start/mid) before final delivery.
- [ ] `render` produced playable MP4 with burned subtitles.

---

## 6) Reusable Execution Prompt (Copy/Paste)

Use this prompt for future runs to avoid the same subtitle issues:

```text
基于给定 PPT 和逐页脚本生成视频。要求：
1) 字幕使用正常切换样式（semantic），不要整页常驻字幕；
2) 每页字幕内容只来自该页讲稿，不跨页；
3) 语音与字幕时间必须同步（优先使用 TTS 时间戳）；
4) 英文字幕单词之间必须有空格，清理乱码/方块字符；
5) 渲染前抽查至少 2 页，确认字幕切换与语音对齐后再交付。
```

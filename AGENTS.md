# Marketing Video Agent Guide

This repository is a standalone marketing-video production tool.

It converts source material into a complete teaching/marketing video:

`source → outline → slides.html → screenshots → segments → TTS → subtitles → final MP4`

Default output: `1920×1080` MP4, per-slide narration, burned subtitles, slides zero-padded as `slide-001.png … slide-NNN.png`.

Follow every step in order. The pipeline will **not** rewrite your authoring decisions for you (language, narration text, line breaks, placeholder copy, voice IDs, etc.).

---

## 1) Repository Scope

- `scripts/` — CLI + pipeline implementation (TypeScript, run via `tsx`)
- `templates/default.html` — base HTML slide template (ships in Chinese; see §3.2)
- `media/` — runtime workspace (auto-created by `init`)
  - `assets/` — shared brand assets; `leadvisor_platform_logo.png` is the corner logo
  - `inbound/` — input source files
  - `wip/<task-id>/` — per-task working artifacts
  - `outbound/` — rendered final MP4s

Produced per task inside `media/wip/<task-id>/`:

```
source.md              # Step 0
outline.md             # Step 1
slides.html            # Step 2 (hydrated in place by Step 3)
images/                # custom + auto-generated placeholder images
slides/slide-NNN.png   # Step 3 output (3-digit zero-padded)
segments.json          # Step 5 (audioPath/durationSeconds filled by Step 6)
audio/segment-NNN.mp3  # Step 6
subtitles/all.srt      # Step 7
subtitles/segment-NNN.srt
clips/clip-NNN.mp4     # Step 8 intermediate
concat.txt             # Step 8 intermediate
```

Final video: `media/outbound/<task-id>.mp4` (override with `--out`).

---

## 2) Runtime and Environment

### 2.1 Prerequisites (install once)

```bash
# Node + package deps
node --version            # must be >= 20
npm install

# Chromium for Playwright screenshots (screenshot.ts prefers system Chrome, falls back to this)
npx playwright install chromium

# ffmpeg/ffprobe (required by tts.ts and render.ts)
# macOS:
brew install ffmpeg
# Ubuntu/Debian:
# sudo apt-get install -y ffmpeg
ffmpeg -version
ffprobe -version
```

### 2.2 Environment variables

Copy `.env.example` → `.env` and fill in:

| Variable                           | Required | Default                     | Purpose                                                  |
| ---------------------------------- | -------- | --------------------------- | -------------------------------------------------------- |
| `GEMINI_API_KEY`                   | yes      | —                           | Image generation (Gemini / Imagen)                       |
| `MINIMAX_API_KEY`                  | yes      | —                           | TTS (MiniMax `speech-2.8-hd`)                            |
| `GOOGLE_IMAGE_MODEL`               | no       | `gemini-2.5-flash-image`    | First image model tried; falls back to Imagen 4 variants |
| `MARKETING_VIDEO_MEDIA_ROOT`       | no       | `<repo>/media`              | Override media root                                      |
| `MARKETING_VIDEO_REQUIRED_CTA_URL` | no       | `https://www.leadvisor.net` | URL enforced by `validate` on the last slide             |

### 2.3 Command-line entry point

All commands go through `npm run video -- <command> [flags]`. **The `--` is required** — it tells npm to pass flags to the script instead of consuming them itself.

Optional sanity check for the TypeScript sources:

```bash
npm run typecheck
```

---

## 3) Core Workflow

### Step 0 — Prepare source

Convert the article/PDF/URL into markdown and save to:

```
media/wip/<task-id>/source.md
```

### Step 1 — Write outline

Save to `media/wip/<task-id>/outline.md`. Each slide entry must include:

- `Type` (e.g. Cover / Context / Key Facts / Flow / Insight / Check / Outro)
- `Content` (bullets or copy to render on the slide)
- `Background` (short summary for the agent; not rendered)
- `Narration` (final spoken wording; will be copied verbatim into `segments.json`)
- `Visual` (either `placeholder` or `./images/<file>.jpg`)

### Step 2 — Produce `slides.html`

```bash
cp templates/default.html media/wip/<task-id>/slides.html
```

Then **replace body sections only**. Keep the full template scaffold (head, font links, `<style>` block, cover/outro classes).

#### 3.2 Authoring rules (the pipeline will not fix these)

Language & text:

- The shipped template is Chinese (`<html lang="zh-CN">`). If the deck is in another language, change the `lang` attribute **and** translate every visible string (eyebrow, headings, pills, `check-list`, `tip-list`, `stat-label`, `info-chip`, `placeholder-tag`/`placeholder-title`/`placeholder-copy`, outro copy).
- Replace every `<...>` angle-bracket token (e.g. `<国家>`, `<主题>`, `<文章来源机构>`, `<01>`/`<02>`/`<03>`).
- Before hand-off, grep the file for these leftovers — each will trip validation or look unprofessional in the PNG:
  - `Cover Visual`, `Context Visual`, `Evidence Visual`, `Flow Visual`, `Insight Visual`, `Layout Visual`, `Declaration Visual`
  - `Opening Hook`, `Template note:`, `Use this area for`, `Use this frame for`
  - `Primary Visual`, `Supporting Visual`, `Reference Visual`, `Closing Visual`
  - `Scene 1`, `Scene 2`, `Scene 3`
  - Any remaining `&lt;` / `&gt;` in rendered copy
  - `TODO`, `TBD`, `PLACEHOLDER`, `待补充`, `待填写`, `占位文本`, `示例文案`
    Full list lives in `FORBIDDEN_SNIPPETS` + `FORBIDDEN_TEXT_PATTERNS` inside `scripts/validate.ts`.

Typography & layout:

- Minimum font size anywhere in the body: **26px**.
- Max **4 bullets per slide** — split into a second slide instead of shrinking text.
- Keep headlines on a single line. Apply the `.one-line` utility class (already in the template `<style>`) to `.t-hero` / `.t-display` / `.t-title` when in doubt. Shipped sizes are 76 / 58 / 50px. Shorten copy rather than reducing font size.
- If a flow-style page feels tight, add `flow-slide-compact` to the `<section>` — the template has CSS that tightens the header gap and lets the flow layout fill the remaining height (see `templates/default.html`).
- If a slide feels empty, enlarge the key visual or key number; do not add filler paragraphs.

Structural invariants (the template must not be stripped):

- First slide must still carry `cover-logo`, `hero-grid`, `media-mosaic`.
- Last slide must still carry `cta-shell`, `cta-panel`, and render the required URL from `MARKETING_VIDEO_REQUIRED_CTA_URL` (default `https://www.leadvisor.net`).
- Every slide must have one real main visual region — an `image-placeholder` block or a real `<img>`. The corner logo does not count.
- Slide backgrounds must stay CSS-only (no full-bleed photos as slide background).
- Keep the `<head>` and the full `<style>` block intact, including remote font links. If screenshoting fails because of fonts, fix `scripts/screenshot.ts`, not the deck.
- Logo path is always `../../assets/leadvisor_platform_logo.png` (relative to `media/wip/<task-id>/slides.html`). If the file is missing, add it to `media/assets/` before continuing — do not invent a substitute.
- Image references inside the deck must be relative (`./images/<file>.jpg` for per-task images, `../../assets/<file>` for shared assets). `file:///` absolute paths are rejected by validation.

Placeholder image prompts (scene-only):

- `placeholder-tag` / `placeholder-title` / `placeholder-copy` text is fed into the image generator verbatim.
- Write them as scene/subject descriptions only. No numbers, no quoted phrases, no "label this", no instructions. The generator is additionally told NO TEXT / NO LOGOS / NO WATERMARKS — keep the prompt clean so the rule is not diluted.
- Prompt language must match the slide language.

### Step 3 — Screenshot (hydrate + capture)

```bash
npm run video -- screenshot --task-id <task-id>
```

This command does three things, in order, and will abort if any fail:

1. **Hydrate placeholders.** Every `<div class="image-placeholder">` without an `<img>` inside is replaced by `<img src="./images/auto-placeholder-sNNN-NN.jpg" class="image-fill" …>`. The image is generated via Gemini/Imagen using the placeholder text + slide headline as the prompt. Pre-existing files in `images/` with the same name are reused (delete them to force regeneration).
2. **Persist hydrated HTML** back to `media/wip/<task-id>/slides.html`. This is expected; subsequent runs keep the inserted `<img>` tags.
3. **Capture PNGs** into `media/wip/<task-id>/slides/slide-001.png`, `slide-002.png`, … using a Playwright page at 1920×1080 per `.slide` section. Filename format is locked — don't rename them, `render.ts` matches on it.

Optional full lint (safe to run after `screenshot` has hydrated placeholders):

```bash
npm run video -- validate --task-id <task-id>
```

Running `validate` before the first successful `screenshot` usually fails on unresolved `image-placeholder` blocks; that's expected.

### Step 4 — Visual QA (mandatory, before TTS/render)

Open **every** `media/wip/<task-id>/slides/slide-*.png` and confirm:

- No text overflow (especially headlines — they should be single-line).
- No layout break (every `flow-slide-compact` page fits inside 1080px, the outro URL is visible, the `stat-grid` doesn't clip).
- Good contrast and correct data.
- Visible variation between adjacent slides (if two neighbors look identical, change the visual or the layout).
- No leftover template English chrome, `<...>` tokens, `TODO`, "示例文案", etc.

**Iteration loop:** if any PNG fails QA → edit `slides.html` (and/or regenerate images by deleting `images/auto-placeholder-*.jpg`) → re-run `screenshot` → re-inspect. Only proceed to Step 5 once all PNGs pass.

### Step 5 — Prepare `segments.json`

Create `media/wip/<task-id>/segments.json` by hand. Strict 1:1 mapping to slides — `segments.length === slide count`.

Exact schema (verified against `scripts/types.ts`, `scripts/tts.ts`, `scripts/render.ts`):

```json
{
  "title": "Optional deck title; not rendered, used as metadata",
  "segments": [
    {
      "index": 1,
      "slideIndex": 1,
      "narration": "封面口播的完整中文句子。"
    },
    {
      "index": 2,
      "slideIndex": 2,
      "narration": "第二页口播。"
    }
  ]
}
```

Field rules:

- `index` — 1-based running segment number, no gaps.
- `slideIndex` — 1-based slide this segment plays over (typically equal to `index`).
- `narration` — exact spoken text. Subtitles are generated from this string; no rewriting happens in code.
- `audioPath` and `durationSeconds` are written back by the `tts` command. Do not fill them manually.

Narration hygiene (TTS + subtitle safety):

- Do not leave bare digit slashes (`2024/1760`, `2015/2020`). TTS often reads them as fractions or "percent". For Chinese narration write `2024年第1760号` or `2015年至2020年`; for English narration write `2024 over 1760` or `2015 to 2020`.
- Write the narration in the final spoken language (CJK or Latin). `scripts/language.ts` detects language by character count and drives subtitle font + line wrapping (CJK lines wrap at ~26 chars, Latin at ~60 chars / 12 words). The default MiniMax voice handles both; pick the narration language first, then decide whether to override `--voice`.

### Step 6 — TTS

```bash
npm run video -- tts --task-id <task-id> \
  [--voice <minimax_voice_id>] \
  [--tts-speed 1.0]
```

Flags:

- `--voice` — MiniMax `voice_id`. Default is `English_Explanatory_Man`, which this pipeline uses for **both Chinese and English** narration (MiniMax's `speech-2.8-hd` handles CJK input with this voice id). Override only when a different voice is explicitly required. `auto` or an empty value falls back to the default.
- `--tts-speed` — `0.5` to `2.0`, default `1.0`. Values outside this range are rejected.

The command iterates through every segment, calls `https://api.minimaxi.com/v1/t2a_v2` with `speech-2.8-hd`, writes `audio/segment-NNN.mp3`, probes its duration with `ffprobe`, and **writes `audioPath` + `durationSeconds` back into `segments.json`**. If any segment comes back with 0 duration the run aborts.

### Step 7 — Subtitles

```bash
npm run video -- srt --task-id <task-id>
```

Produces `subtitles/all.srt` (used for reference) and per-segment `subtitles/segment-NNN.srt` (burned into clips by `render`). Subtitle timing is proportional to segment duration; text splitting is language-aware (see `scripts/srt.ts` + `scripts/language.ts`).

### Step 8 — Render

```bash
npm run video -- render --task-id <task-id>
# optional: override output path
npm run video -- render --task-id <task-id> --out /absolute/path/output.mp4
```

Behavior:

- Reads slides from `slides/slide-NNN.{png,jpg}` (3-digit naming enforced).
- Fails fast if any segment is missing `audioPath` or `durationSeconds` (i.e. Step 6 wasn't run).
- Each clip is `libx264` CRF 19, 30 fps, 1920×1080, blurred background + centered foreground, burned subtitles (`PingFang SC` 22pt for zh, `Arial` 21pt for Latin), 0.35s fades at each end.
- Concatenates via `ffmpeg -f concat` into `media/outbound/<task-id>.mp4` (or `--out`).

---

## 4) Image Policy (strict)

Every generated in-slide image must be 100% text-free. No:

- letters, digits, words, labels
- captions, signage, screen text, document text
- watermarks, logos, branding marks
- annotations or readable symbols of any kind

`scripts/screenshot.ts` already hard-codes this rule into the prompt, but if a generated image still contains readable text, delete `media/wip/<task-id>/images/auto-placeholder-s*-*.jpg` for that slide and re-run `screenshot` to regenerate.

---

## 5) CLI Reference (complete)

All flags below are exact; defaults shown in `[brackets]`.

```bash
# Initialize media/ layout (idempotent)
npm run video -- init

# Generate one explicit image (useful for custom hero shots the screenshot step won't auto-fill)
npm run video -- image \
  --task-id <id> \
  --prompt "<full prompt>" \
  [--filename <name>.jpg]           # default image.jpg; basename only, .jpg or .jpeg
  [--output-path <absolute path>]   # override default images/<filename>
  [--image-size 1K|2K]              # default 2K
  [--aspect-ratio 16:9|9:16|1:1|3:4|4:3]   # default 16:9
  [--guidance-scale <float>]        # default 1.5

# Hydrate placeholders + write back slides.html + capture PNGs
npm run video -- screenshot --task-id <id>

# HTML terminal lint (run after the first successful screenshot)
npm run video -- validate --task-id <id>

# Synthesize narration, fill audioPath/durationSeconds back into segments.json
npm run video -- tts \
  --task-id <id> \
  [--voice <minimax_voice_id>]      # default English_Explanatory_Man (handles zh + en)
  [--tts-speed <0.5-2.0>]           # default 1.0

# Generate SRT files from segments.json
npm run video -- srt --task-id <id>

# Compose per-clip MP4s and concatenate to final
npm run video -- render \
  --task-id <id> \
  [--out <absolute path>]           # default <media>/outbound/<id>.mp4
```

---

## 6) Quality Gate (delivery checklist)

A task is complete only when **all** of the following are true:

- [ ] Every outline slide has a corresponding `<section class="slide">` in `slides.html` (count matches).
- [ ] `segments.json` exists with `segments.length === slide count`, every `index` and `slideIndex` set.
- [ ] `npm run video -- screenshot --task-id <id>` completed with no unresolved placeholders.
- [ ] Visual QA (§3 Step 4) passed on every PNG — single-line headings, no overflow, no English template chrome, no `<...>` tokens left, accurate numbers.
- [ ] `npm run video -- validate --task-id <id>` passes (enforces `FORBIDDEN_SNIPPETS`, placeholder-free HTML, required last-slide URL, structural classes on first/last slides).
- [ ] `tts` wrote `audioPath` + `durationSeconds` for every segment.
- [ ] `subtitles/all.srt` exists.
- [ ] `media/outbound/<task-id>.mp4` plays from start to finish with burned subtitles and per-slide narration.
- [ ] No readable text, watermark, or logo inside any generated visual image.
- [ ] Narration in `segments.json` is still the final author-written wording (nothing rewrites it downstream).

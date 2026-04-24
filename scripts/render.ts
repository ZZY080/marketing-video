import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectNarrationLanguage, hasHanCharacters } from "./language";
import { Segment } from "./types";
import {
  ensureDir,
  execCommand,
  fail,
  formatIndex,
  logInfo,
  logWarn,
} from "./utils";

interface RenderInput {
  segments: Segment[];
  slidesDir: string;
  subtitlesDir: string;
  clipsDir: string;
  concatPath: string;
  outputPath: string;
}

interface SubtitleFontConfig {
  zh: string;
  en: string;
}

const DEFAULT_ZH_FONT_CANDIDATES = [
  "Hiragino Sans GB",
  "Heiti SC",
  "Arial Unicode MS",
  "Noto Sans CJK SC",
  "Microsoft YaHei",
  "SimHei",
  "PingFang SC",
];
const DEFAULT_EN_FONT_CANDIDATES = [
  "Arial",
  "Helvetica",
  "Noto Sans",
  "Arial Unicode MS",
];

export async function renderSegmentsAndConcat(input: RenderInput): Promise<string[]> {
  await ensureDir(input.clipsDir);
  await ensureDir(path.dirname(input.outputPath));
  const subtitleFonts = await resolveSubtitleFonts();
  const slideFiles = (await readdir(input.slidesDir))
    .filter((name) => /^slide-\d{3}\.(jpg|png)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  if (slideFiles.length === 0) {
    fail("未找到可渲染的幻灯片图片。");
  }

  const clipPaths: string[] = [];
  for (const segment of input.segments) {
    const slideIndex = clamp(segment.slideIndex, 1, slideFiles.length);
    const slideName = slideFiles[slideIndex - 1];
    if (!slideName) {
      fail(`Missing slide image for index ${String(slideIndex)}.`);
    }
    const slidePath = path.join(input.slidesDir, slideName);
    const audioPath = segment.audioPath;
    if (!audioPath) {
      fail(`第 ${String(segment.index)} 段缺少音频路径。`);
    }

    const segmentSrtPath = path.join(
      input.subtitlesDir,
      `segment-${formatIndex(segment.index)}.srt`,
    );
    const clipPath = path.join(input.clipsDir, `clip-${formatIndex(segment.index)}.mp4`);
    const duration = resolveSegmentDuration(segment);
    const subtitleFilter = buildSubtitleFilter(
      segmentSrtPath,
      segment.narration,
      subtitleFonts,
    );
    const fadeOutStart = Math.max(0, duration - 0.35).toFixed(3);
    const videoFilter = [
      "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=28:14[bg]",
      "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease[fg]",
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,${subtitleFilter},fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeOutStart}:d=0.35[v]`,
    ].join(";");

    logInfo(`正在渲染第 ${String(segment.index)} 段视频...`);
    await execCommand("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      slidePath,
      "-i",
      audioPath,
      "-filter_complex",
      videoFilter,
      "-af",
      `apad=pad_dur=${duration.toFixed(3)}`,
      "-map",
      "[v]",
      "-map",
      "1:a:0",
      "-t",
      duration.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "19",
      "-r",
      "30",
      "-g",
      "60",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      clipPath,
    ]);
    clipPaths.push(clipPath);
  }

  const concatBody = clipPaths
    .map((clipPath) => `file '${clipPath.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(input.concatPath, `${concatBody}\n`, "utf-8");

  logInfo("正在拼接最终视频...");
  await execCommand("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    input.concatPath,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-r",
    "30",
    "-g",
    "60",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    input.outputPath,
  ]);

  return clipPaths;
}

function normalizeForFilter(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function buildSubtitleFilter(
  segmentSrtPath: string,
  narration: string,
  fonts: SubtitleFontConfig,
): string {
  const language = hasHanCharacters(narration)
    ? "zh"
    : detectNarrationLanguage(narration);
  const fontName = language === "zh" ? fonts.zh : fonts.en;
  const fontSize = language === "zh" ? 23 : 22;
  const forceStyle = [
    `FontName=${fontName}`,
    `FontSize=${String(fontSize)}`,
    "Bold=0",
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H5A000000",
    "BackColour=&H64000000",
    "BorderStyle=1",
    "Outline=1",
    "Shadow=0",
    "Spacing=0",
    "WrapStyle=2",
    "MarginL=96",
    "MarginR=96",
    "Alignment=2",
    "MarginV=14",
  ].join(",");
  return `subtitles='${normalizeForFilter(segmentSrtPath)}':charenc=UTF-8:force_style='${forceStyle}'`;
}

function resolveSegmentDuration(segment: Segment): number {
  const target = segment.targetDurationSeconds;
  if (typeof target === "number" && Number.isFinite(target) && target > 0) {
    return Math.max(target, 0.3);
  }
  return Math.max(segment.durationSeconds ?? 0, 0.3);
}

async function resolveSubtitleFonts(): Promise<SubtitleFontConfig> {
  const installed = await readInstalledFontFamilies();
  const zhCandidates = mergeFontCandidates(
    process.env.MARKETING_VIDEO_ZH_SUBTITLE_FONTS,
    DEFAULT_ZH_FONT_CANDIDATES,
  );
  const enCandidates = mergeFontCandidates(
    process.env.MARKETING_VIDEO_EN_SUBTITLE_FONTS,
    DEFAULT_EN_FONT_CANDIDATES,
  );

  const zh = pickFirstInstalledFont(installed, zhCandidates) ?? zhCandidates[0];
  const en = pickFirstInstalledFont(installed, enCandidates) ?? enCandidates[0];
  logInfo(`字幕字体：zh=${zh} / en=${en}`);
  return { zh, en };
}

async function readInstalledFontFamilies(): Promise<Set<string>> {
  try {
    const { stdout } = await execCommand("fc-list", [":", "family"]);
    const families = new Set<string>();
    for (const rawLine of stdout.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      for (const item of line.split(",")) {
        const family = item.trim().toLowerCase();
        if (family) {
          families.add(family);
        }
      }
    }
    return families;
  } catch {
    logWarn("无法读取系统字体列表（fc-list），将使用默认字幕字体候选。");
    return new Set<string>();
  }
}

function mergeFontCandidates(raw: string | undefined, defaults: string[]): string[] {
  const envFonts = (raw ?? "")
    .split(",")
    .map((font) => font.trim())
    .filter(Boolean);
  const merged = [...envFonts, ...defaults];
  return Array.from(new Set(merged));
}

function pickFirstInstalledFont(
  installed: Set<string>,
  candidates: string[],
): string | null {
  if (installed.size === 0) {
    return candidates[0] ?? null;
  }
  for (const candidate of candidates) {
    if (installed.has(candidate.trim().toLowerCase())) {
      return candidate;
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

import path from "node:path";
import type { TaskPaths } from "./types";
import { PROJECT_ROOT } from "./env";

export const DEFAULT_MEDIA_ROOT = path.join(PROJECT_ROOT, "media");
export const MEDIA_ROOT = resolveMediaRoot();

function resolveMediaRoot(): string {
  const fromEnv = process.env.MARKETING_VIDEO_MEDIA_ROOT?.trim()
    || process.env.MEDIA_ROOT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return DEFAULT_MEDIA_ROOT;
}

export function buildTaskPaths(taskId: string, outputPath?: string): TaskPaths {
  const root = MEDIA_ROOT;
  const wipDir = path.join(root, "wip", taskId);
  return {
    wipDir,
    outlinePath: path.join(wipDir, "outline.md"),
    pptxPath: path.join(wipDir, "slides.pptx"),
    slidesHtmlPath: path.join(wipDir, "slides.html"),
    segmentsPath: path.join(wipDir, "segments.json"),
    imagesDir: path.join(wipDir, "images"),
    slidesDir: path.join(wipDir, "slides"),
    audioDir: path.join(wipDir, "audio"),
    subtitlesDir: path.join(wipDir, "subtitles"),
    clipsDir: path.join(wipDir, "clips"),
    concatPath: path.join(wipDir, "concat.txt"),
    outputPath: outputPath ?? path.join(root, "outbound", `${taskId}.mp4`),
  };
}

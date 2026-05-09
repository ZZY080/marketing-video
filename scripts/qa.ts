import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Segment } from "./types";
import { fail } from "./utils";

interface QaOptions {
  requireSingleLineSubtitle: boolean;
  maxDurationDriftRatio: number;
}

export async function runQualityChecks(input: {
  subtitlesDir: string;
  segments: Segment[];
  options?: Partial<QaOptions>;
}): Promise<void> {
  const options: QaOptions = {
    requireSingleLineSubtitle: input.options?.requireSingleLineSubtitle ?? true,
    maxDurationDriftRatio: input.options?.maxDurationDriftRatio ?? 0.03,
  };

  for (const segment of input.segments) {
    const segmentFile = path.join(
      input.subtitlesDir,
      `segment-${String(segment.index).padStart(3, "0")}.srt`,
    );
    const raw = await readFile(segmentFile, "utf-8").catch(() => {
      fail(`缺少字幕文件：${segmentFile}`);
    });
    validateSubtitleContent(raw, segment.index, options.requireSingleLineSubtitle);
    validateDurationDrift(segment, options.maxDurationDriftRatio);
  }
}

function validateSubtitleContent(
  content: string,
  segmentIndex: number,
  requireSingleLine: boolean,
): void {
  const blocks = content
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).filter(Boolean);
    if (lines.length < 3) {
      continue;
    }
    const textLines = lines.slice(2);
    if (requireSingleLine && textLines.length > 1) {
      fail(`第 ${String(segmentIndex)} 段字幕出现多行，需保持单行显示。`);
    }
    for (const textLine of textLines) {
      if (hasForbiddenAsciiSubtitlePunctuation(textLine)) {
        fail(
          `第 ${String(segmentIndex)} 段字幕仍包含英文句读标点（请使用中文标点）：${textLine}`,
        );
      }
    }
  }
}

function hasForbiddenAsciiSubtitlePunctuation(text: string): boolean {
  if (/[,;:!?]/.test(text)) {
    return true;
  }
  if (/(?<!\d)\.(?!\d)/.test(text)) {
    return true;
  }
  if (/\u0022/.test(text)) {
    return true;
  }
  return false;
}

function validateDurationDrift(segment: Segment, maxRatio: number): void {
  const target = segment.targetDurationSeconds;
  const actual = segment.durationSeconds;
  if (
    typeof target !== "number"
    || !Number.isFinite(target)
    || target <= 0
    || typeof actual !== "number"
    || !Number.isFinite(actual)
    || actual <= 0
  ) {
    return;
  }
  const driftRatio = Math.abs(actual - target) / target;
  if (driftRatio > maxRatio) {
    fail(
      `第 ${String(segment.index)} 段时长偏差过大：target=${target.toFixed(3)}s, actual=${actual.toFixed(3)}s, drift=${(driftRatio * 100).toFixed(2)}%`,
    );
  }
}

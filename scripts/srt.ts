import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  detectNarrationLanguage,
  measureSubtitleUnits,
  normalizeNarrationWhitespace,
} from "./language";
import { Segment } from "./types";
import { formatIndex, toSrtTimestamp } from "./utils";

// 同步优先：按语义句切分，避免“按固定字数硬切”导致口播与字幕错位。
const MAX_CJK_LINE_LENGTH = 20;
const MAX_LATIN_LINE_LENGTH = 44;
const MAX_LATIN_LINE_WORDS = 9;
const MIN_CUE_SECONDS = 1.2;
const MAX_CUE_SECONDS = 6.0;

export type SubtitleMode = "semantic" | "strict-single";

export async function writeSrtFiles(
  segments: Segment[],
  subtitlesDir: string,
  options?: { subtitleMode?: SubtitleMode },
): Promise<{ allSrtPath: string; segmentSrtPaths: string[] }> {
  const allSrtPath = path.join(subtitlesDir, "all.srt");
  const allEntries: string[] = [];
  const segmentSrtPaths: string[] = [];

  let current = 0;
  let globalIndex = 1;
  for (const segment of segments) {
    const duration = Math.max(segment.durationSeconds ?? 0, 0.3);
    const start = current;
    const segmentTimedCues = resolveSegmentCueTimings(
      segment,
      duration,
      options?.subtitleMode ?? "semantic",
    );
    const timedLines = segmentTimedCues.map((item) => ({
      text: item.text,
      start: start + item.start,
      end: start + item.end,
    }));

    for (const item of timedLines) {
      allEntries.push(
        `${globalIndex}\n${toSrtTimestamp(item.start)} --> ${toSrtTimestamp(item.end)}\n${item.text}\n`,
      );
      globalIndex += 1;
    }

    const segmentSrtPath = path.join(
      subtitlesDir,
      `segment-${formatIndex(segment.index)}.srt`,
    );
    const segmentEntries = segmentTimedCues
      .map(
        (item, idx) =>
          `${idx + 1}\n${toSrtTimestamp(item.start)} --> ${toSrtTimestamp(item.end)}\n${item.text}\n`,
      )
      .join("\n");
    await writeFile(segmentSrtPath, `${segmentEntries.trim()}\n`, "utf-8");
    segmentSrtPaths.push(segmentSrtPath);
    current += duration;
  }

  await writeFile(allSrtPath, `${allEntries.join("\n").trim()}\n`, "utf-8");
  return {
    allSrtPath,
    segmentSrtPaths,
  };
}

function resolveSegmentCueTimings(
  segment: Segment,
  duration: number,
  subtitleMode: SubtitleMode,
): Array<{ text: string; start: number; end: number }> {
  if (subtitleMode === "strict-single") {
    const singleLine = sanitizeNarrationToSingleLine(segment.narration);
    return singleLine ? [{ text: singleLine, start: 0, end: duration }] : [];
  }
  // 同步优先：只要有 TTS 时间戳就优先使用，确保口播与字幕时间对齐。
  const fromTts = mapTtsSubtitleCues(segment, duration);
  if (fromTts.length > 0) {
    return fromTts;
  }

  const subtitleLines = splitNarrationToSubtitleLines(segment.narration);
  return allocateTimings(subtitleLines, 0, duration);
}

function sanitizeNarrationToSingleLine(narration: string): string {
  const normalized = normalizeNarrationWhitespace(sanitizeSubtitleText(narration)).trim();
  if (!normalized) {
    return "";
  }
  const language = detectNarrationLanguage(normalized);
  if (language === "zh") {
    return normalized.replace(/\s+/gu, "");
  }
  return normalized.replace(/\s+/gu, " ");
}

function mapTtsSubtitleCues(
  segment: Segment,
  duration: number,
): Array<{ text: string; start: number; end: number }> {
  const cues = (segment.subtitleCues ?? [])
    .filter((item) =>
      Number.isFinite(item.startSeconds)
      && Number.isFinite(item.endSeconds)
      && item.endSeconds > item.startSeconds,
    )
    .sort((a, b) => a.startSeconds - b.startSeconds);
  if (cues.length === 0) {
    return [];
  }

  const firstStart = cues[0]?.startSeconds ?? 0;
  const lastEnd = cues[cues.length - 1]?.endSeconds ?? firstStart;
  const sourceSpan = Math.max(0.001, lastEnd - firstStart);

  const normalized = cues
    .flatMap((cue) => {
      const lines = splitCueToSingleLines(cue.text);
      if (lines.length === 0) {
        return null;
      }
      const normalizedStart = ((cue.startSeconds - firstStart) / sourceSpan) * duration;
      const normalizedEnd = ((cue.endSeconds - firstStart) / sourceSpan) * duration;
      const cueStart = clamp(normalizedStart, 0, duration);
      const cueEnd = clamp(normalizedEnd, cueStart, duration);
      if (cueEnd - cueStart < 0.05) {
        return [];
      }
      return allocateTimings(lines, cueStart, cueEnd);
    })
    .filter((item): item is { text: string; start: number; end: number } => item !== null);

  if (normalized.length === 0) {
    return [];
  }

  const stitched: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const item = normalized[i];
    const isLast = i === normalized.length - 1;
    const gap = item.start - cursor;
    const start = clamp(
      Math.max(cursor, gap <= 0.24 ? cursor : item.start),
      0,
      duration,
    );
    let end = clamp(item.end, start + 0.05, duration);
    if (isLast) {
      end = duration;
    } else if (end <= start) {
      end = clamp(start + 0.05, 0, duration);
    }
    if (end <= start) {
      continue;
    }
    stitched.push({ text: item.text, start, end });
    cursor = end;
  }

  return stitched;
}

function splitCueToSingleLines(text: string): string[] {
  const normalized = normalizeNarrationWhitespace(sanitizeSubtitleText(text)).trim();
  if (!normalized) {
    return [];
  }
  const language = detectNarrationLanguage(normalized);
  const lines = language === "zh"
    ? wrapChineseSentence(normalized)
    : wrapLatinSentence(normalized);
  const sanitized = lines
    .map((line) => normalizeNarrationWhitespace(sanitizeSubtitleText(line)).trim())
    .filter(Boolean);
  if (sanitized.length > 0) {
    return sanitized;
  }
  return [normalized];
}

function splitNarrationToSubtitleLines(narration: string): string[] {
  const normalized = normalizeNarrationWhitespace(narration).trim();
  if (!normalized) {
    return [narration.trim()];
  }

  const language = detectNarrationLanguage(normalized);
  const sentenceParts = splitSentences(normalized, language);
  const lines = sentenceParts.flatMap((sentence) =>
    language === "zh"
      ? wrapChineseSentence(sentence)
      : wrapLatinSentence(sentence),
  );

  const sanitizedLines = lines
    .map((line) => normalizeNarrationWhitespace(sanitizeSubtitleText(line)).trim())
    .filter(Boolean);
  if (sanitizedLines.length > 0) {
    return sanitizedLines;
  }
  const sanitizedNarration = normalizeNarrationWhitespace(
    sanitizeSubtitleText(normalized),
  ).trim();
  return sanitizedNarration ? [sanitizedNarration] : [normalized];
}

function allocateTimings(
  lines: string[],
  start: number,
  end: number,
): Array<{ text: string; start: number; end: number }> {
  const safeLines = lines.filter(Boolean);
  if (safeLines.length === 0) {
    return [];
  }
  const totalDuration = Math.max(0.3, end - start);
  const weightedUnits = safeLines.map((line) => {
    const base = measureSubtitleUnits(line);
    // 标点通常对应语音停顿，适当抬高权重可让显示时长更贴近朗读节奏。
    const pauseWeight = countPauseMarks(line) * 0.35;
    return Math.max(0.1, base + pauseWeight);
  });
  const totalUnits = weightedUnits.reduce((sum, n) => sum + n, 0);
  let cursor = start;
  const baselineMinCue = Math.min(
    MIN_CUE_SECONDS,
    totalDuration / safeLines.length * 0.9,
  );

  return safeLines.map((line, idx) => {
    const remaining = end - cursor;
    const isLast = idx === safeLines.length - 1;
    const proportionalSlice = totalDuration * ((weightedUnits[idx] ?? 0) / totalUnits);
    const remainingLines = safeLines.length - idx;
    const minForThis = isLast
      ? 0
      : Math.min(baselineMinCue, (remaining / remainingLines) * 0.95);
    const maxForThis = isLast
      ? remaining
      : Math.max(
          minForThis,
          Math.min(
            MAX_CUE_SECONDS,
            remaining - baselineMinCue * (remainingLines - 1),
          ),
        );
    const slice = isLast
      ? remaining
      : clamp(proportionalSlice, minForThis, maxForThis);
    const itemStart = cursor;
    const itemEnd = isLast ? end : Math.min(end, cursor + slice);
    cursor = itemEnd;
    return { text: line, start: itemStart, end: itemEnd };
  });
}

function splitSentences(text: string, language: "zh" | "en"): string[] {
  const parts =
    language === "zh"
      ? text.split(/(?<=[。！？!?])\s*/u)
      : text.split(/(?<=[.!?])\s+/u);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function wrapChineseSentence(sentence: string): string[] {
  const normalized = sentence.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= MAX_CJK_LINE_LENGTH) {
    return [normalized];
  }

  const clauseParts = normalized
    .split(/(?<=[，、；：])/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauseParts.length === 0) {
    return chunkChineseText(normalized);
  }

  const lines: string[] = [];
  let buffer = "";
  for (const clause of clauseParts) {
    const next = `${buffer}${clause}`;
    if (!buffer || next.length <= MAX_CJK_LINE_LENGTH) {
      buffer = next;
      continue;
    }
    lines.push(...chunkChineseText(buffer));
    buffer = clause;
  }
  if (buffer) {
    lines.push(...chunkChineseText(buffer));
  }
  return lines;
}

function chunkChineseText(text: string): string[] {
  if (text.length <= MAX_CJK_LINE_LENGTH) {
    return [text];
  }

  const lines: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    lines.push(text.slice(cursor, cursor + MAX_CJK_LINE_LENGTH).trim());
    cursor += MAX_CJK_LINE_LENGTH;
  }
  return lines.filter(Boolean);
}

function wrapLatinSentence(sentence: string): string[] {
  const clauses = sentence
    .split(/(?<=[,;:])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauses.length === 0) {
    return wrapLatinWords(sentence);
  }

  const lines: string[] = [];
  let buffer = "";
  for (const clause of clauses) {
    const next = buffer ? `${buffer} ${clause}` : clause;
    if (lineCanFit(next)) {
      buffer = next;
      continue;
    }
    if (buffer) {
      lines.push(...wrapLatinWords(buffer));
    }
    buffer = clause;
  }
  if (buffer) {
    lines.push(...wrapLatinWords(buffer));
  }
  return lines;
}

function wrapLatinWords(text: string): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let buffer = "";
  for (const word of words) {
    const next = buffer ? `${buffer} ${word}` : word;
    if (!buffer || lineCanFit(next)) {
      buffer = next;
      continue;
    }
    lines.push(buffer);
    buffer = word;
  }
  if (buffer) {
    lines.push(buffer);
  }
  return lines;
}

function lineCanFit(text: string): boolean {
  const words = text.split(/\s+/u).filter(Boolean);
  return (
    text.length <= MAX_LATIN_LINE_LENGTH && words.length <= MAX_LATIN_LINE_WORDS
  );
}

function countPauseMarks(text: string): number {
  const matches = text.match(/[，。！？；：,.!?;:]/gu);
  return matches?.length ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSubtitleText(text: string): string {
  const widthNormalized = text.normalize("NFKC");
  const noControlChars = widthNormalized
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, " ")
    .replace(/[�□■▢▣▤▥▦▧▨▩◻◼◽◾]/gu, " ");
  const normalizedPunctuation = noControlChars
    .replace(/[，、]/gu, ",")
    .replace(/[。]/gu, ".")
    .replace(/[！]/gu, "!")
    .replace(/[？]/gu, "?")
    .replace(/[；]/gu, ";")
    .replace(/[：]/gu, ":")
    .replace(/[“”]/gu, "\"")
    .replace(/[‘’]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, "-")
    .replace(/\.{3,}/g, "…")
    .replace(/…{2,}/gu, "…");
  const fixedBoundaries = normalizedPunctuation
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([,.!?;:])([A-Za-z0-9])/g, "$1 $2");
  const keepCorePunctuation = fixedBoundaries.replace(/[^\p{L}\p{N}\p{Script=Han}\s,.!?;:'"()\-…]/gu, " ");
  return keepCorePunctuation.replace(/\s+/gu, " ").trim();
}

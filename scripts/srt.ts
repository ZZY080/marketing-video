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
const MAX_CJK_LINE_LENGTH = 24;
const MAX_LATIN_LINE_LENGTH = 56;
const MAX_LATIN_LINE_WORDS = 12;
const MIN_CUE_SECONDS = 1.2;
const MAX_CUE_SECONDS = 6.0;

export async function writeSrtFiles(
  segments: Segment[],
  subtitlesDir: string,
): Promise<{ allSrtPath: string; segmentSrtPaths: string[] }> {
  const allSrtPath = path.join(subtitlesDir, "all.srt");
  const allEntries: string[] = [];
  const segmentSrtPaths: string[] = [];

  let current = 0;
  let globalIndex = 1;
  for (const segment of segments) {
    const duration = Math.max(segment.durationSeconds ?? 0, 0.3);
    const start = current;
    const end = current + duration;
    const subtitleLines = splitNarrationToSubtitleLines(segment.narration);
    const timedLines = allocateTimings(subtitleLines, start, end);

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
    const segmentEntries = allocateTimings(subtitleLines, 0, duration)
      .map(
        (item, idx) =>
          `${idx + 1}\n${toSrtTimestamp(item.start)} --> ${toSrtTimestamp(item.end)}\n${item.text}\n`,
      )
      .join("\n");
    await writeFile(segmentSrtPath, `${segmentEntries.trim()}\n`, "utf-8");
    segmentSrtPaths.push(segmentSrtPath);
    current = end;
  }

  await writeFile(allSrtPath, `${allEntries.join("\n").trim()}\n`, "utf-8");
  return {
    allSrtPath,
    segmentSrtPaths,
  };
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
    .map((line) => normalizeNarrationWhitespace(stripSubtitlePunctuation(line)).trim())
    .filter(Boolean);
  if (sanitizedLines.length > 0) {
    return sanitizedLines;
  }
  const sanitizedNarration = normalizeNarrationWhitespace(
    stripSubtitlePunctuation(normalized),
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

function stripSubtitlePunctuation(text: string): string {
  return text.replace(/\p{P}+/gu, "");
}

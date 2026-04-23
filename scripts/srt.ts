import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  detectNarrationLanguage,
  measureSubtitleUnits,
  normalizeNarrationWhitespace,
} from "./language";
import { Segment } from "./types";
import { formatIndex, toSrtTimestamp } from "./utils";

const MAX_CJK_LINE_LENGTH = 26;
const MAX_LATIN_LINE_LENGTH = 60;
const MAX_LATIN_LINE_WORDS = 12;

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

  return lines.length > 0 ? lines : [normalized];
}

function allocateTimings(
  lines: string[],
  start: number,
  end: number,
): Array<{ text: string; start: number; end: number }> {
  const safeLines = lines.filter(Boolean);
  const totalDuration = Math.max(0.3, end - start);
  const totalChars = safeLines.reduce(
    (sum, line) => sum + measureSubtitleUnits(line),
    0,
  );
  let cursor = start;

  return safeLines.map((line, idx) => {
    const remaining = end - cursor;
    const slice =
      idx === safeLines.length - 1
        ? remaining
        : Math.max(
            0.6,
            totalDuration * (measureSubtitleUnits(line) / totalChars),
          );
    const itemStart = cursor;
    const itemEnd =
      idx === safeLines.length - 1 ? end : Math.min(end, cursor + slice);
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
  const clauseParts = sentence
    .split(/(?<=[，、；：])/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauseParts.length === 0) {
    return chunkChineseText(sentence);
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

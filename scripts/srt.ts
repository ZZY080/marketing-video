import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  detectNarrationLanguage,
  measureSubtitleUnits,
  normalizeNarrationWhitespace,
} from "./language";
import type { Segment, SubtitleCue } from "./types";
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
  const rawCues = (segment.subtitleCues ?? [])
    .filter((item) =>
      Number.isFinite(item.startSeconds)
      && Number.isFinite(item.endSeconds)
      && item.endSeconds > item.startSeconds,
    )
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const cues = mergeBrokenWordBoundaryCues(rawCues);
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

  return mergeOrphanTimedLines(stitched);
}

/** MiniMax 等 TTS 时间戳偶发把英文单词拆到相邻 cue（如 "T" + "he"），合并后再排版。 */
function mergeBrokenWordBoundaryCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) {
    return cues;
  }
  const out: SubtitleCue[] = [];
  let i = 0;
  while (i < cues.length) {
    let current: SubtitleCue = cues[i]!;
    let j = i + 1;
    while (j < cues.length && shouldMergeBrokenEnglishWord(current.text, cues[j]!.text)) {
      const next = cues[j]!;
      current = {
        text: mergeAdjacentCueText(current.text, next.text),
        startSeconds: current.startSeconds,
        endSeconds: next.endSeconds,
      };
      j += 1;
    }
    out.push(current);
    i = j;
  }
  return out;
}

function shouldMergeBrokenEnglishWord(prevText: string, nextText: string): boolean {
  if (/\s$/u.test(prevText) || /^\s/u.test(nextText)) {
    return false;
  }
  const a = prevText.trimEnd();
  const b = nextText.trimStart();
  if (!a || !b) {
    return false;
  }
  if (!/[A-Za-z]/.test(a) || !/[A-Za-z]/.test(b)) {
    return false;
  }
  const lastTok = (a.match(/(\S+)$/u)?.[1] ?? "").replace(/[^A-Za-z'-]+$/u, "");
  const firstTok = (b.match(/^(\S+)/u)?.[1] ?? "").replace(/^[^A-Za-z'-]+/u, "");
  if (!lastTok || !firstTok) {
    return false;
  }
  if (/^[A-Z]$/.test(lastTok) && /^[a-z]/u.test(firstTok)) {
    if (lastTok === "I" || lastTok === "A") {
      return false;
    }
    return true;
  }
  if (/^[A-Za-z]{2}$/.test(lastTok) && /^[a-z]+/u.test(firstTok)) {
    if (/^[A-Z]{2}$/.test(lastTok)) {
      return false;
    }
    return true;
  }
  if (/(?:'|’)$/.test(lastTok) && /^[a-z]/u.test(firstTok)) {
    return true;
  }
  if (/'$/.test(a) && /^[a-z]/u.test(b)) {
    return true;
  }
  return false;
}

function mergeAdjacentCueText(a: string, b: string): string {
  const aSt = a.trimEnd();
  const bSt = b.trimStart();
  if (!aSt) {
    return bSt;
  }
  if (!bSt) {
    return aSt;
  }
  if (/[A-Za-z0-9]$/.test(aSt) && /^[a-z]/.test(bSt)) {
    return `${aSt}${bSt}`;
  }
  return `${aSt} ${bSt}`;
}

function splitCueToSingleLines(text: string): string[] {
  const normalized = normalizeNarrationWhitespace(sanitizeSubtitleText(text)).trim();
  if (!normalized) {
    return [];
  }
  const language = detectNarrationLanguage(normalized);
  const rawLines = language === "zh"
    ? wrapChineseSentence(normalized)
    : wrapLatinSentence(normalized);
  const lines = polishSubtitleLines(rawLines, language);
  const sanitized = lines
    .map((line) => normalizeNarrationWhitespace(sanitizeSubtitleText(line)).trim())
    .filter(Boolean);
  if (sanitized.length > 0) {
    return sanitized;
  }
  return [normalized];
}

function splitNarrationToSubtitleLines(narration: string): string[] {
  let normalized = normalizeNarrationWhitespace(narration).trim();
  if (!normalized) {
    return [narration.trim()];
  }

  normalized = latinPunctuationToChinese(normalized);
  const language = detectNarrationLanguage(normalized);
  const sentenceParts = splitSentences(normalized, language);
  const rawLines = sentenceParts.flatMap((sentence) =>
    language === "zh"
      ? wrapChineseSentence(sentence)
      : wrapLatinSentence(sentence),
  );
  const lines = polishSubtitleLines(rawLines, language);

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
      : text.split(/(?<=[.!?。！？])\s+/u);
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
  return balanceChineseLines(lines);
}

function chunkChineseText(text: string): string[] {
  const source = text.trim();
  if (!source) {
    return [];
  }
  if (source.length <= MAX_CJK_LINE_LENGTH) {
    return [source];
  }

  const lines: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const remaining = source.length - cursor;
    if (remaining <= MAX_CJK_LINE_LENGTH) {
      lines.push(source.slice(cursor).trim());
      break;
    }
    const hardEnd = cursor + MAX_CJK_LINE_LENGTH;
    let splitAt = findBestChineseBreakPoint(source, cursor, hardEnd);
    if (splitAt <= cursor) {
      splitAt = hardEnd;
    }
    if (
      splitAt < source.length
      && startsWithAttachableHanParticle(source.slice(splitAt))
      && splitAt + 1 <= source.length
    ) {
      splitAt += 1;
    }
    const line = source.slice(cursor, splitAt).trim();
    if (line) {
      lines.push(line);
      cursor = splitAt;
      continue;
    }
    lines.push(source.slice(cursor, hardEnd).trim());
    cursor = hardEnd;
  }
  return balanceChineseLines(lines.filter(Boolean));
}

function wrapLatinSentence(sentence: string): string[] {
  const clauses = sentence
    .split(/(?<=[,;:，；：])\s*/u)
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

/** 避免最后一行只剩一两个短词（孤行），尽量并入上一行。 */
function balanceLatinLines(lines: string[]): string[] {
  if (lines.length <= 1) {
    return lines;
  }
  const out = [...lines];
  while (out.length >= 2) {
    const last = out[out.length - 1] ?? "";
    const prev = out[out.length - 2] ?? "";
    const lastWords = last.trim().split(/\s+/u).filter(Boolean);
    const merged = `${prev.trimEnd()} ${last.trimStart()}`.trim();
    const lastWordCount = lastWords.length;
    const lastCharCount = last.replace(/\s+/gu, "").length;
    const shouldPullUp =
      (lastWordCount <= 2 && lastCharCount <= 12)
      || (lastWordCount === 1 && lastCharCount <= 5);
    if (shouldPullUp && lineCanFit(merged)) {
      out.splice(out.length - 2, 2, merged);
      continue;
    }
    break;
  }
  return out;
}

function balanceChineseLines(lines: string[]): string[] {
  if (lines.length <= 1) {
    return lines;
  }
  const out = [...lines];
  while (out.length >= 2) {
    const last = out[out.length - 1]?.trim() ?? "";
    const prev = out[out.length - 2]?.trim() ?? "";
    if (!last || !prev) {
      break;
    }
    const shortTailText = last.replace(/[，。！？；：、,.!?;:\s]/gu, "");
    const shouldMergeTail = shortTailText.length <= 4 || last.length <= 5;
    const merged = `${prev}${last}`;
    if (
      shouldMergeTail
      && merged.length <= MAX_CJK_LINE_LENGTH + 4
    ) {
      out.splice(out.length - 2, 2, merged);
      continue;
    }
    break;
  }
  return out;
}

function polishSubtitleLines(
  lines: string[],
  language: "zh" | "en",
): string[] {
  const cleaned: string[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) {
      continue;
    }
    if (cleaned.length > 0 && startsWithClosingOrPunctuation(line)) {
      const first = line[0] ?? "";
      cleaned[cleaned.length - 1] = `${cleaned[cleaned.length - 1]}${first}`;
      line = line.slice(1).trimStart();
      if (!line) {
        continue;
      }
    }
    cleaned.push(line);
  }
  return language === "zh"
    ? balanceChineseLines(cleaned)
    : balanceLatinLines(cleaned);
}

function mergeOrphanTimedLines(
  lines: Array<{ text: string; start: number; end: number }>,
): Array<{ text: string; start: number; end: number }> {
  if (lines.length <= 1) {
    return lines;
  }
  const merged: Array<{ text: string; start: number; end: number }> = [];
  for (const item of lines) {
    const current = { ...item, text: item.text.trim() };
    if (!current.text) {
      continue;
    }
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push(current);
      continue;
    }
    if (shouldMergeOrphanLine(prev.text, current.text)) {
      prev.text = joinSubtitleText(prev.text, current.text);
      prev.end = current.end;
      continue;
    }
    merged.push(current);
  }
  const rebalanced = rebalanceTimedLineBoundaries(merged);
  return rebalanced
    .map((item) => ({
      ...item,
      text: normalizeNarrationWhitespace(sanitizeSubtitleText(item.text)).trim(),
    }))
    .filter((item) => item.text.length > 0);
}

function shouldMergeOrphanLine(prevText: string, nextText: string): boolean {
  const prev = prevText.trimEnd();
  const next = nextText.trimStart();
  if (!prev || !next) {
    return false;
  }
  if (startsWithClosingOrPunctuation(next)) {
    return true;
  }

  const prevLast = prev.slice(-1);
  const nextFirst = next.slice(0, 1);
  const prevHanTail = prev.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/u)?.[0] ?? "";
  const nextHanHead = next.match(/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/u)?.[0] ?? "";
  const mergedHanLen = prev.length + next.length;
  if (
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(prevLast)
    && /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(nextFirst)
    && !/[，。！？；：、]/u.test(prevLast)
    && (prevHanTail.length <= 1 || mergedHanLen <= MAX_CJK_LINE_LENGTH + 6)
  ) {
    return true;
  }
  if (/^[A-Za-z0-9]{1,4}(?:[.。]|$)/u.test(next)) {
    const mergedLen = prev.length + next.length;
    if (mergedLen <= MAX_CJK_LINE_LENGTH + 10) {
      return true;
    }
  }
  if (nextHanHead.length > 0 && nextHanHead.length <= 3) {
    const mergedLen = prev.length + next.length;
    if (mergedLen <= MAX_CJK_LINE_LENGTH + 6) {
      return true;
    }
  }
  if (/[A-Za-z]$/.test(prev) && /^[a-z]/.test(next)) {
    return true;
  }
  return false;
}

function joinSubtitleText(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trimStart();
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]$/.test(left)
    && /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]/.test(right)
  ) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

function rebalanceTimedLineBoundaries(
  items: Array<{ text: string; start: number; end: number }>,
): Array<{ text: string; start: number; end: number }> {
  const out = items.map((item) => ({ ...item }));
  for (let i = 0; i < out.length - 1; i += 1) {
    const current = out[i];
    const next = out[i + 1];
    if (!current || !next) {
      continue;
    }
    let left = current.text.trimEnd();
    let right = next.text.trimStart();
    if (!left || !right) {
      continue;
    }

    const carryHan = right.match(/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u)?.[0];
    if ((endsWithSingleHanChar(left) || startsWithAttachableHanParticle(right)) && carryHan) {
      left = `${left}${carryHan}`;
      right = right.slice(carryHan.length).trimStart();
    }

    const carryLatin = right.match(/^[a-z]+/u)?.[0];
    if (/[A-Za-z]$/.test(left) && carryLatin && carryLatin.length <= 3) {
      left = `${left}${carryLatin}`;
      right = right.slice(carryLatin.length).trimStart();
    }

    current.text = left;
    next.text = right;
    if (!next.text) {
      current.end = next.end;
      out.splice(i + 1, 1);
      i -= 1;
    }
  }
  return out;
}

function lineCanFit(text: string): boolean {
  const words = text.split(/\s+/u).filter(Boolean);
  return (
    text.length <= MAX_LATIN_LINE_LENGTH && words.length <= MAX_LATIN_LINE_WORDS
  );
}

function findBestChineseBreakPoint(
  text: string,
  start: number,
  hardEnd: number,
): number {
  const minStart = Math.min(hardEnd - 1, start + Math.floor(MAX_CJK_LINE_LENGTH * 0.55));
  for (let i = hardEnd; i > minStart; i -= 1) {
    const prev = text[i - 1] ?? "";
    const next = text[i] ?? "";
    if (isProtectedLatinBoundary(text, i)) {
      continue;
    }
    if (/[，。！？；：、,.!?;:\s）】》」』]/u.test(prev)) {
      return i;
    }
  }
  for (let i = hardEnd; i > minStart; i -= 1) {
    if (isProtectedLatinBoundary(text, i)) {
      continue;
    }
    return i;
  }
  return hardEnd;
}

function isAsciiWordChar(char: string): boolean {
  return /[A-Za-z0-9'-]/.test(char);
}

function isProtectedLatinBoundary(text: string, index: number): boolean {
  const prev = text[index - 1] ?? "";
  const next = text[index] ?? "";
  if (!prev || !next) {
    return false;
  }
  const latinLike = /[A-Za-z0-9.'-]/;
  return latinLike.test(prev) && latinLike.test(next);
}

function startsWithClosingOrPunctuation(text: string): boolean {
  return /^[，。！？；：、,.!?;:）】》」』]/u.test(text);
}

function endsWithSingleHanChar(text: string): boolean {
  const tail = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/u)?.[0] ?? "";
  return tail.length === 1;
}

function startsWithAttachableHanParticle(text: string): boolean {
  return /^[们的了着吗呢吧啊呀嘛么]/u.test(text);
}

function countPauseMarks(text: string): number {
  const matches = text.match(/[，。！？；：,.!?;:]/gu);
  return matches?.length ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 字幕展示用中文标点（英文旁白也统一），小数点等数字场景保留 ASCII `.`。 */
function latinPunctuationToChinese(text: string): string {
  let s = text;
  s = s.replace(/([A-Za-z0-9])\.\s+([A-Za-z0-9])/gu, "$1.$2");
  s = s.replace(/,/gu, "，");
  s = s.replace(/;/gu, "；");
  s = s.replace(/!/gu, "！");
  s = s.replace(/\?/gu, "？");
  s = s.replace(/:/gu, "：");
  s = s.replace(/\.{3,}/gu, "…");
  s = s.replace(/…{2,}/gu, "…");
  s = s.replace(/(?<![A-Za-z0-9])\.(?![A-Za-z0-9])/gu, "。");
  s = s.replace(/\(([^)]+)\)/gu, "（$1）");
  let quoteParity = 0;
  s = s.replace(/\u0022/g, () => (quoteParity++ % 2 === 0 ? "\u201c" : "\u201d"));
  return s;
}

function sanitizeSubtitleText(text: string): string {
  const widthNormalized = text.normalize("NFKC");
  const noControlChars = widthNormalized
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, " ")
    .replace(/[�□■▢▣▤▥▦▧▨▩◻◼◽◾]/gu, " ");
  const fixedBoundaries = noControlChars
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([,!?;:])([A-Za-z0-9])/gu, "$1 $2");
  const punctNormalized = latinPunctuationToChinese(fixedBoundaries);
  const keepCorePunctuation = punctNormalized.replace(
    /[^\p{L}\p{N}\p{Script=Han}\s0-9.，。！？；：、（）「」『』《》\u201c\u201d\u2018\u2019'"()\-…]/gu,
    " ",
  );
  return keepCorePunctuation.replace(/\s+/gu, " ").trim();
}

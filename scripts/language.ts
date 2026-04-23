export type NarrationLanguage = "zh" | "en";

const HAN_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const HAN_CHAR_GLOBAL_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const LATIN_CHAR_GLOBAL_RE = /[A-Za-z]/g;

export function hasHanCharacters(text: string): boolean {
  return HAN_CHAR_RE.test(text);
}

export function detectNarrationLanguage(text: string): NarrationLanguage {
  const hanCount = countMatches(text, HAN_CHAR_GLOBAL_RE);
  const latinCount = countMatches(text, LATIN_CHAR_GLOBAL_RE);
  return hanCount > latinCount ? "zh" : "en";
}

export function normalizeNarrationWhitespace(text: string): string {
  const collapsed = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*([，。！？；：、])/gu, "$1")
    .replace(/([（《“‘【])\s+/gu, "$1")
    .replace(/\s+([）》”’】])/gu, "$1")
    .trim();

  return collapsed.replace(
    /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/gu,
    "$1$2",
  );
}

export function measureSubtitleUnits(text: string): number {
  let total = 0;
  for (const char of text) {
    if (/\s/u.test(char)) {
      total += 0.2;
      continue;
    }
    if (HAN_CHAR_RE.test(char)) {
      total += 1;
      continue;
    }
    if (/[A-Z]/.test(char)) {
      total += 0.7;
      continue;
    }
    if (/[a-z0-9]/.test(char)) {
      total += 0.55;
      continue;
    }
    total += 0.35;
  }
  return Math.max(1, total);
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches?.length ?? 0;
}

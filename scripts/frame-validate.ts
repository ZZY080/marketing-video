import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Segment } from "./types";
import { fail } from "./utils";

const SLIDE_FILE_REGEX = /^slide-(\d{3})\.(png|jpg)$/i;
const SLIDE_PREFIX_REGEX = /^slide-(\d{3})\./i;

interface SlideFileMeta {
  name: string;
  index: number;
}

export interface SlideFrameValidationResult {
  slideCount: number;
  files: string[];
}

export async function validateSlideFramesAgainstSegments(
  slidesDir: string,
  segments: Segment[],
): Promise<SlideFrameValidationResult> {
  const names = await readdir(slidesDir);
  const unsupported = names
    .filter((name) => SLIDE_PREFIX_REGEX.test(name))
    .filter((name) => !SLIDE_FILE_REGEX.test(name));
  if (unsupported.length > 0) {
    fail(
      `检测到不支持的幻灯片文件格式：${unsupported.join(", ")}。仅支持 slide-NNN.png 或 slide-NNN.jpg。`,
    );
  }

  const slides = names
    .map((name): SlideFileMeta | null => {
      const match = SLIDE_FILE_REGEX.exec(name);
      if (!match) {
        return null;
      }
      return { name, index: Number.parseInt(match[1] ?? "", 10) };
    })
    .filter((item): item is SlideFileMeta => item !== null)
    .sort((a, b) => a.index - b.index);

  if (slides.length === 0) {
    fail("未找到可渲染的幻灯片图片，请先执行 ppt-screenshot。");
  }

  for (let i = 0; i < slides.length; i += 1) {
    const expected = i + 1;
    const actual = slides[i]?.index ?? -1;
    if (actual !== expected) {
      fail(
        `幻灯片编号不连续：期望 slide-${pad3(expected)}，但找到 ${slides[i]?.name ?? "未知文件"}。`,
      );
    }
  }

  if (segments.length !== slides.length) {
    fail(
      `segments 数量与幻灯片数量不一致：segments=${String(segments.length)}，slides=${String(slides.length)}。`,
    );
  }

  for (const segment of segments) {
    if (!Number.isInteger(segment.slideIndex) || segment.slideIndex <= 0) {
      fail(`第 ${String(segment.index)} 段 slideIndex 非法：${String(segment.slideIndex)}。`);
    }
    const expectedName = `slide-${pad3(segment.slideIndex)}`;
    const exists = slides.some((slide) => slide.index === segment.slideIndex);
    if (!exists) {
      fail(
        `第 ${String(segment.index)} 段引用了不存在的 slideIndex=${String(segment.slideIndex)}（期望文件前缀 ${expectedName}）。`,
      );
    }
  }

  return {
    slideCount: slides.length,
    files: slides.map((item) => path.join(slidesDir, item.name)),
  };
}

function pad3(input: number): string {
  return String(input).padStart(3, "0");
}

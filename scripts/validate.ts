import { readFile } from "node:fs/promises";
import { fail } from "./utils";

const FORBIDDEN_SNIPPETS = [
  "Liora Video Template",
  "Template note:",
  "Template Guidance",
  "Starter template notes",
  "Use this area for",
  "Use this frame for",
  "Primary Visual",
  "Supporting Visual",
  "Reference Visual",
  "Closing Visual",
  "Instructional Sequence",
  "Scene 1",
  "Scene 2",
  "Scene 3",
  // templates/default.html 内置的英文占位标签 / 配图说明，终稿中应替换为目标语言或真实文案
  "Cover Visual",
  "Context Visual",
  "Evidence Visual",
  "Flow Visual",
  "Insight Visual",
  "Layout Visual",
  "Declaration Visual",
  "Country scene, map, or market image tied to the opening hook",
];

const FORBIDDEN_PLACEHOLDER_TOKENS = ["IMG", "FIG", "END", "MAP"];
const REQUIRED_FIRST_SLIDE_CLASSES = [
  "cover-logo",
  "hero-grid",
  "media-mosaic",
];
const REQUIRED_LAST_SLIDE_CLASSES = ["cta-shell", "cta-panel"];
const REQUIRED_LAST_SLIDE_SNIPPETS = [
  process.env.MARKETING_VIDEO_REQUIRED_CTA_URL?.trim() ||
    "https://www.leadvisor.net",
];
const FORBIDDEN_TEXT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "HTML 占位符（&lt;...&gt;）",
    pattern: /&lt;\s*[^<>&]{1,120}\s*&gt;/gi,
  },
  { label: "TODO/TBD 占位标记", pattern: /\b(?:TODO|TBD|PLACEHOLDER)\b/gi },
  { label: "中文占位标记", pattern: /(?:待补充|待填写|占位文本|示例文案)/g },
  {
    label: "过程性口播残留（本视频会讲清/试点评估逻辑）",
    pattern: /(?:本视频会讲清|试点评估逻辑)/g,
  },
];

interface ValidateSlidesHtmlOptions {
  allowUnresolvedImagePlaceholders?: boolean;
  allowPlaceholderTokens?: boolean;
  allowSlidesWithoutVisuals?: boolean;
}

export async function validateSlidesHtml(
  htmlPath: string,
  options: ValidateSlidesHtmlOptions = {},
): Promise<void> {
  const html = await readFile(htmlPath, "utf-8");
  validateSlidesHtmlContent(html, options);
}

export function validateSlidesHtmlContent(
  html: string,
  options: ValidateSlidesHtmlOptions = {},
): void {
  const issues: string[] = [];

  const slideCount = [
    ...html.matchAll(/<section\b[^>]*class=(['"])[^'"]*\bslide\b[^'"]*\1/gi),
  ].length;
  if (slideCount === 0) {
    issues.push("slides.html 中没有 .slide 页面。");
  }
  const slideSections = extractSlideSections(html);
  if (slideSections.length > 0) {
    const firstSlide = slideSections[0] ?? "";
    const lastSlide = slideSections[slideSections.length - 1] ?? "";
    for (const className of REQUIRED_FIRST_SLIDE_CLASSES) {
      if (!hasClass(firstSlide, className)) {
        issues.push(`首屏缺少模板关键结构：.${className}`);
      }
    }
    for (const className of REQUIRED_LAST_SLIDE_CLASSES) {
      if (!hasClass(lastSlide, className)) {
        issues.push(`尾屏缺少模板关键结构：.${className}`);
      }
    }
    for (const snippet of REQUIRED_LAST_SLIDE_SNIPPETS) {
      if (!lastSlide.includes(snippet)) {
        issues.push(`尾屏缺少必需品牌信息：${snippet}`);
      }
    }
  }

  if (/<img\b[^>]*src=(['"])file:\/\/\/[\s\S]*?\1/gi.test(html)) {
    issues.push(
      "检测到 file:/// 绝对图片路径，请改为相对路径（例如 ../../assets/... 或 ./images/...）。",
    );
  }

  const visibleText = extractVisibleText(html);
  for (const rule of FORBIDDEN_TEXT_PATTERNS) {
    if (rule.pattern.test(visibleText)) {
      issues.push(`检测到疑似残留占位文案：${rule.label}`);
    }
  }

  for (const snippet of FORBIDDEN_SNIPPETS) {
    if (html.includes(snippet)) {
      issues.push(`检测到模板/过程文案残留: ${snippet}`);
    }
  }

  const unresolvedPlaceholders = [
    ...html.matchAll(
      /<div\b[^>]*class=(['"])[^'"]*\bimage-placeholder\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/gi,
    ),
  ]
    .map((match) => match[2] ?? "")
    .filter((inner) => !/<img\b/i.test(inner));
  if (
    !options.allowUnresolvedImagePlaceholders &&
    unresolvedPlaceholders.length > 0
  ) {
    issues.push(
      `仍有 ${String(unresolvedPlaceholders.length)} 个 image-placeholder 未放入 <img>。`,
    );
  }

  if (!options.allowPlaceholderTokens) {
    for (const token of FORBIDDEN_PLACEHOLDER_TOKENS) {
      const tokenRe = new RegExp(`>\\s*${token}\\s*<`, "i");
      if (tokenRe.test(html)) {
        issues.push(`检测到占位符标记残留: ${token}`);
      }
    }
  }

  if (!options.allowSlidesWithoutVisuals) {
    slideSections.forEach((slide, index) => {
      const contentOnlySlide = stripBrandingBlocks(slide);
      const hasVisual =
        /<div\b[^>]*class=(['"])[^'"]*\bimage-placeholder\b[^'"]*\1[^>]*>/i.test(
          contentOnlySlide,
        ) || /<img\b[^>]*>/i.test(contentOnlySlide);
      if (!hasVisual) {
        issues.push(
          `第 ${String(index + 1)} 页缺少真正的视觉素材区（image-placeholder 或非 logo 的 <img>）；品牌 logo 不算主视觉。`,
        );
      }
    });
  }

  if (issues.length > 0) {
    fail(`slides.html 未通过终检:\n- ${issues.join("\n- ")}`);
  }
}

function extractSlideSections(html: string): string[] {
  return [
    ...html.matchAll(
      /<section\b[^>]*class=(['"])[^'"]*\bslide\b[^'"]*\1[^>]*>[\s\S]*?<\/section>/gi,
    ),
  ]
    .map((match) => match[0] ?? "")
    .filter(Boolean);
}

function hasClass(htmlSnippet: string, className: string): boolean {
  const classRe = new RegExp(
    `class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1`,
    "i",
  );
  return classRe.test(htmlSnippet);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractVisibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripBrandingBlocks(html: string): string {
  return html.replace(
    /<div\b[^>]*class=(['"])[^'"]*\bcorner-logo\b[^'"]*\1[^>]*>[\s\S]*?<\/div>/gi,
    " ",
  );
}

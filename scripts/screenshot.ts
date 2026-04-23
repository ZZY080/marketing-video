import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateImage } from "./image";
import {
  ensureDir,
  fail,
  formatErrorDetail,
  formatIndex,
  logError,
  logInfo,
  logWarn,
} from "./utils";
import { validateSlidesHtmlContent } from "./validate";

export interface ScreenshotResult {
  count: number;
  paths: string[];
}

export async function screenshotSlides(
  htmlPath: string,
  outputDir: string,
): Promise<ScreenshotResult> {
  await ensureDir(outputDir);
  const resolvedPath = path.resolve(htmlPath);
  const imagesDir = path.join(path.dirname(resolvedPath), "images");
  await ensureDir(imagesDir);

  const sourceHtml = await readFile(resolvedPath, "utf-8");
  const htmlWithBase = injectBaseHref(sourceHtml, path.dirname(resolvedPath));
  const prepared = await prepareHtmlForScreenshot(htmlWithBase, imagesDir);
  if (prepared.placeholdersHydrated > 0) {
    logInfo(
      `自动补图完成：${String(prepared.placeholdersHydrated)} 个占位区已替换为图片。`,
    );
  }
  if (prepared.unresolvedPlaceholders.length > 0) {
    fail(
      `仍有未解析的占位区，已中止截图。\n${prepared.unresolvedPlaceholders.join("\n")}`,
    );
  }
  validateSlidesHtmlContent(prepared.html);

  const persistedHtml = stripBaseHref(prepared.html);
  await writeFile(resolvedPath, persistedHtml, "utf-8");
  logInfo(`已将补图后的 slides.html 写回：${resolvedPath}`);

  let chromium: typeof import("playwright").chromium;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    fail("playwright is not installed. Run: npm install playwright");
  }

  const tempHtmlPath = path.join(
    os.tmpdir(),
    `marketing-video-${Date.now()}-${path.basename(resolvedPath)}`,
  );
  const offlineReadyHtml = stripRemoteFontLinks(prepared.html);
  await writeFile(tempHtmlPath, offlineReadyHtml, "utf-8");

  let browser: import("playwright").Browser;
  try {
    browser = await chromium.launch({ channel: "chrome" });
  } catch {
    logWarn("未检测到可用的 Chrome channel，回退到 Playwright 自带 Chromium。");
    browser = await chromium.launch();
  }
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    // Use "domcontentloaded" so decks can keep the latest template's remote font
    // links without hanging forever on background requests. Then try to wait for
    // fonts, but degrade gracefully if the font network never settles.
    await page.goto(`file://${tempHtmlPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    try {
      await page.waitForFunction(
        `(() => {
          if (!("fonts" in document) || !document.fonts?.ready) {
            return true;
          }
          return document.fonts.ready.then(() => true).catch(() => true);
        })()`,
        {
          timeout: 8_000,
        },
      );
    } catch {
      logWarn("字体资源未在时限内就绪，继续使用当前可用字体截图。");
    }
    await page.waitForTimeout(300);

    const slides = page.locator(".slide");
    const count = await slides.count();
    if (count === 0) {
      fail("slides.html contains no .slide elements.");
    }

    const screenshotPaths: string[] = [];
    for (let i = 0; i < count; i++) {
      const outPath = path.join(outputDir, `slide-${formatIndex(i + 1)}.png`);
      await slides.nth(i).screenshot({ path: outPath });
      screenshotPaths.push(outPath);
      logInfo(
        `Screenshot ${String(i + 1)}/${String(count)}: slide-${formatIndex(i + 1)}.png`,
      );
    }

    return { count, paths: screenshotPaths };
  } finally {
    await browser.close();
  }
}

interface PlaceholderMeta {
  slideIndex: number;
  placeholderIndex: number;
  pageTitle: string;
  pageContext: string;
  tag: string;
  title: string;
  copy: string;
}

interface PreparedHtml {
  html: string;
  placeholdersHydrated: number;
  unresolvedPlaceholders: string[];
}

interface PlaceholderBlock {
  start: number;
  end: number;
}

interface PlaceholderParseIssue {
  placeholderIndex: number;
  reason: string;
}

async function prepareHtmlForScreenshot(
  html: string,
  imagesDir: string,
): Promise<PreparedHtml> {
  const slideMatches = [
    ...html.matchAll(
      /<section\b[^>]*class=(['"])[^'"]*\bslide\b[^'"]*\1[^>]*>[\s\S]*?<\/section>/gi,
    ),
  ];
  if (slideMatches.length === 0) {
    fail("slides.html contains no .slide elements.");
  }

  let nextHtml = html;
  let hydratedCount = 0;
  const unresolvedPlaceholders: string[] = [];

  for (let slideIndex = 0; slideIndex < slideMatches.length; slideIndex++) {
    const slideHtml = slideMatches[slideIndex]?.[0];
    if (!slideHtml) {
      continue;
    }

    const parsed = extractImagePlaceholderBlocks(slideHtml);
    for (const issue of parsed.issues) {
      unresolvedPlaceholders.push(
        `slide ${String(slideIndex + 1)} placeholder ${String(issue.placeholderIndex)}: ${issue.reason}`,
      );
    }
    const placeholders = parsed.blocks;
    if (placeholders.length === 0) {
      continue;
    }

    let nextSlideHtml = slideHtml;
    let delta = 0;
    const pageTitle = firstText(slideHtml, ["t-hero", "t-display", "t-title"]);
    const pageContext = collectTexts(slideHtml, [
      "t-subtitle",
      "t-body",
      "check-list li",
      "module-card h3",
      "module-card p",
      "stat-label",
      "tip-list li",
    ])
      .slice(0, 10)
      .join(" | ");

    for (
      let placeholderIndex = 0;
      placeholderIndex < placeholders.length;
      placeholderIndex++
    ) {
      const placeholder = placeholders[placeholderIndex];
      if (!placeholder) {
        continue;
      }
      const start = placeholder.start + delta;
      const end = placeholder.end + delta;
      const placeholderHtml = nextSlideHtml.slice(start, end);
      if (!placeholderHtml || /<img\b/i.test(placeholderHtml)) {
        continue;
      }

      const meta: PlaceholderMeta = {
        slideIndex: slideIndex + 1,
        placeholderIndex: placeholderIndex + 1,
        pageTitle,
        pageContext,
        tag: textForClass(placeholderHtml, "placeholder-tag"),
        title: textForClass(placeholderHtml, "placeholder-title"),
        copy: textForClass(placeholderHtml, "placeholder-copy"),
      };

      const fileName = `auto-placeholder-s${formatIndex(meta.slideIndex)}-${formatIndex(meta.placeholderIndex)}.jpg`;
      const outputPath = path.join(imagesDir, fileName);
      if (!(await pathExists(outputPath))) {
        const prompt = buildPlaceholderPrompt(meta);
        try {
          await generateImage({
            prompt,
            outputPath,
            imageSize: "2K",
            aspectRatio: "16:9",
            guidanceScale: 1.5,
          });
          logInfo(
            `生成占位配图：slide ${String(meta.slideIndex)} / ${fileName}`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logError(
            `占位配图生成失败 slide ${String(meta.slideIndex)} placeholder ${String(meta.placeholderIndex)}（${fileName}）。完整错误：\n${formatErrorDetail(error)}`,
          );
          unresolvedPlaceholders.push(
            `slide ${String(meta.slideIndex)} placeholder ${String(meta.placeholderIndex)}: ${message}`,
          );
          logWarn(
            `占位配图未生成，已保留占位块；摘要：${message}（完整信息见上条 [错误]）`,
          );
          continue;
        }
      }

      const replacement = replacePlaceholderWithImage(
        placeholderHtml,
        outputPath,
        meta,
      );
      nextSlideHtml = `${nextSlideHtml.slice(0, start)}${replacement}${nextSlideHtml.slice(end)}`;
      delta += replacement.length - (end - start);
      hydratedCount += 1;
    }

    nextHtml = nextHtml.replace(slideHtml, nextSlideHtml);
  }

  return {
    html: nextHtml,
    placeholdersHydrated: hydratedCount,
    unresolvedPlaceholders,
  };
}

function replacePlaceholderWithImage(
  placeholderHtml: string,
  outputPath: string,
  meta: PlaceholderMeta,
): string {
  const imageAlt = escapeHtmlAttr(
    meta.pageTitle || meta.title || `Slide ${String(meta.slideIndex)} visual`,
  );
  const relativeImagePath = `./images/${path.basename(outputPath)}`;
  return placeholderHtml.replace(
    />([\s\S]*)<\/div>$/i,
    `><img src="${relativeImagePath}" alt="${imageAlt}" class="image-fill" loading="eager" decoding="sync"> </div>`,
  );
}

function extractImagePlaceholderBlocks(slideHtml: string): {
  blocks: PlaceholderBlock[];
  issues: PlaceholderParseIssue[];
} {
  const blocks: PlaceholderBlock[] = [];
  const issues: PlaceholderParseIssue[] = [];
  const openTagRe =
    /<div\b[^>]*class=(['"])[^'"]*\bimage-placeholder\b[^'"]*\1[^>]*>/gi;
  let placeholderIndex = 0;
  for (const match of slideHtml.matchAll(openTagRe)) {
    placeholderIndex += 1;
    const fullTag = match[0];
    const start = match.index;
    if (typeof start !== "number" || !fullTag) {
      issues.push({
        placeholderIndex,
        reason: "placeholder open tag 解析失败。",
      });
      continue;
    }
    const openTagEnd = start + fullTag.length;
    const end = findMatchingDivEnd(slideHtml, openTagEnd);
    if (end < 0) {
      issues.push({
        placeholderIndex,
        reason: "未找到匹配的 </div>，占位块结构可能损坏。",
      });
      continue;
    }
    blocks.push({
      start,
      end,
    });
  }
  return { blocks, issues };
}

function findMatchingDivEnd(html: string, fromIndex: number): number {
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = fromIndex;

  let match = tagRe.exec(html);
  while (match) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return tagRe.lastIndex;
      }
    } else {
      depth += 1;
    }
    match = tagRe.exec(html);
  }
  return -1;
}

function firstText(html: string, classes: string[]): string {
  for (const className of classes) {
    const value = textForClass(html, className);
    if (value) {
      return value;
    }
  }
  return "";
}

function collectTexts(html: string, selectors: string[]): string[] {
  const texts: string[] = [];
  for (const selector of selectors) {
    const tagAndClass = selector.match(/^([a-z0-9]+)\.([a-z0-9-]+)$/i);
    const listClass = selector.match(/^([a-z0-9-]+) li$/i);
    if (tagAndClass) {
      texts.push(...textsForTagAndClass(html, tagAndClass[1], tagAndClass[2]));
      continue;
    }
    if (listClass) {
      texts.push(...textsForListItemsUnderClass(html, listClass[1]));
      continue;
    }
    texts.push(...textsForClassAll(html, selector));
  }
  return texts.filter(Boolean);
}

function textForClass(html: string, className: string): string {
  return textsForClassAll(html, className)[0] ?? "";
}

function textsForClassAll(html: string, className: string): string[] {
  const re = new RegExp(
    `<[^>]*class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "gi",
  );
  const result: string[] = [];
  for (const match of html.matchAll(re)) {
    const text = stripTags(match[2] ?? "");
    if (text) {
      result.push(text);
    }
  }
  return result;
}

function textsForTagAndClass(
  html: string,
  tagName: string,
  className: string,
): string[] {
  const re = new RegExp(
    `<${escapeRegExp(tagName)}\\b[^>]*class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`,
    "gi",
  );
  const result: string[] = [];
  for (const match of html.matchAll(re)) {
    const text = stripTags(match[2] ?? "");
    if (text) {
      result.push(text);
    }
  }
  return result;
}

function textsForListItemsUnderClass(
  html: string,
  className: string,
): string[] {
  const containers = [
    ...html.matchAll(
      new RegExp(
        `<[^>]*class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
        "gi",
      ),
    ),
  ];
  const result: string[] = [];
  for (const container of containers) {
    const body = container[2] ?? "";
    for (const li of body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const text = stripTags(li[1] ?? "");
      if (text) {
        result.push(text);
      }
    }
  }
  return result;
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildPlaceholderPrompt(meta: PlaceholderMeta): string {
  const placeholderIntent = [meta.tag, meta.title, meta.copy]
    .filter(Boolean)
    .join(" — ");
  const pageSignal = [meta.pageTitle, meta.pageContext]
    .filter(Boolean)
    .join(" | ");
  const core =
    pageSignal ||
    placeholderIntent ||
    `slide ${String(meta.slideIndex)} contextual visual`;
  return [
    "Create a polished presentation visual that is tightly aligned with this slide's specific topic.",
    "Use the slide topic and key points to choose concrete subject matter; do not generate generic abstract filler.",
    // ── NO TEXT RULE (hard constraint) ───────────────────────────────────────────
    // Generated images are embedded directly inside slides. Any visible text,
    // letter, digit, symbol, watermark, logo, caption or annotation inside the
    // image will collide with the slide’s own typography and is strictly banned.
    "CRITICAL — ABSOLUTELY NO TEXT IN THE IMAGE: zero letters, digits, words, labels, captions, watermarks, logos, symbols, or annotations anywhere — not on signs, screens, documents, walls, objects, clothing, or any surface. The image must be 100% text-free and logo-free.",
    "Style: clean editorial, premium, trustworthy, photorealistic or high-quality illustration, no text, no logos, no watermark.",
    "Visual language: soft violet accents on light or appropriately dark background, modern clean composition, 16:9 framing.",
    `Slide semantics: ${core}.`,
    placeholderIntent ? `Placeholder intent: ${placeholderIntent}.` : "",
  ].join(" ");
}

function injectBaseHref(html: string, baseDir: string): string {
  const href = `file://${baseDir.replace(/\\/g, "/")}/`;
  if (/<base\b/i.test(html)) {
    return html;
  }
  if (/<head>/i.test(html)) {
    return html.replace(/<head>/i, `<head>\n  <base href="${href}">`);
  }
  return html;
}

/** Remove temporary file:// base so persisted slides.html keeps relative ./images/ paths valid. */
function stripBaseHref(html: string): string {
  return html.replace(/<base\b[^>]*>\s*/gi, "");
}

function stripRemoteFontLinks(html: string): string {
  return html
    .replace(
      /<link\b[^>]*href="https:\/\/fonts\.googleapis\.com\/[^"]*"[^>]*>\s*/gi,
      "",
    )
    .replace(/<link\b[^>]*href="https:\/\/fonts\.gstatic\.com"[^>]*>\s*/gi, "")
    .replace(
      /<link\b[^>]*rel="preconnect"[^>]*href="https:\/\/fonts\.googleapis\.com"[^>]*>\s*/gi,
      "",
    )
    .replace(
      /<link\b[^>]*rel="preconnect"[^>]*href="https:\/\/fonts\.gstatic\.com"[^>]*>\s*/gi,
      "",
    );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

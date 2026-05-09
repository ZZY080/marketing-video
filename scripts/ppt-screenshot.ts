import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDir, execCommand, fail } from "./utils";

const PDF_EXPORT_SUFFIX = ".pdf";
const PPT_EXTENSIONS = new Set([".pptx", ".ppt"]);
const PDF_EXTENSIONS = new Set([".pdf"]);

interface ExportOptions {
  pptxPath: string;
  outputDir: string;
}

export interface PptScreenshotResult {
  count: number;
  files: string[];
}

export async function screenshotPpt(options: ExportOptions): Promise<PptScreenshotResult> {
  const sourcePath = path.resolve(options.pptxPath);
  const ext = path.extname(sourcePath).toLowerCase();
  if (!PPT_EXTENSIONS.has(ext) && !PDF_EXTENSIONS.has(ext)) {
    fail(`不支持的文件类型：${ext || "unknown"}。仅支持 .pptx / .ppt / .pdf。`);
  }
  await stat(sourcePath).catch(() => {
    fail(`未找到输入文件：${sourcePath}`);
  });

  await ensureDir(options.outputDir);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "marketing-video-ppt-"));
  const tempPdfDir = path.join(tempRoot, "pdf");
  const tempPngDir = path.join(tempRoot, "png");

  try {
    await ensureDir(tempPdfDir);
    await ensureDir(tempPngDir);

    const pdfPath = await resolvePdfPath({
      sourcePath,
      extension: ext,
      tempPdfDir,
    });
    const pdftoppmBinary = await detectBinary(["pdftoppm"]);
    if (!pdftoppmBinary) {
      fail("缺少 pdftoppm，无法将 PDF 转为 PNG。");
    }

    const tempPrefix = path.join(tempPngDir, "slide");
    await execCommand(pdftoppmBinary, [
      "-png",
      "-r",
      "150",
      "-scale-to-x",
      "1920",
      "-scale-to-y",
      "1080",
      pdfPath,
      tempPrefix,
    ]);

    const exportedPngs = await collectPngPages(tempPngDir);
    if (exportedPngs.length === 0) {
      fail("PPT 导出失败：未生成任何幻灯片图片。");
    }

    await clearExistingSlides(options.outputDir);

    const writtenFiles: string[] = [];
    for (let i = 0; i < exportedPngs.length; i += 1) {
      const src = path.join(tempPngDir, exportedPngs[i] ?? "");
      const dstName = `slide-${String(i + 1).padStart(3, "0")}.png`;
      const dst = path.join(options.outputDir, dstName);
      await rename(src, dst);
      writtenFiles.push(dst);
    }

    return { count: writtenFiles.length, files: writtenFiles };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function resolvePdfPath(input: {
  sourcePath: string;
  extension: string;
  tempPdfDir: string;
}): Promise<string> {
  if (PDF_EXTENSIONS.has(input.extension)) {
    return input.sourcePath;
  }

  const officeBinary = await detectBinary(["soffice", "libreoffice"]);
  if (!officeBinary) {
    fail("缺少 LibreOffice（soffice/libreoffice），无法自动导出 PPT。");
  }
  await execCommand(officeBinary, [
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    input.tempPdfDir,
    input.sourcePath,
  ]);
  return resolveExportedPdfPath(input.tempPdfDir, input.sourcePath);
}

async function detectBinary(candidates: string[]): Promise<string | null> {
  for (const cmd of candidates) {
    try {
      await execCommand("which", [cmd]);
      return cmd;
    } catch {
      // continue
    }
  }
  return null;
}

async function resolveExportedPdfPath(pdfDir: string, pptxPath: string): Promise<string> {
  const base = path.basename(pptxPath, path.extname(pptxPath));
  const exact = path.join(pdfDir, `${base}${PDF_EXPORT_SUFFIX}`);
  try {
    await stat(exact);
    return exact;
  } catch {
    const files = await readdir(pdfDir);
    const firstPdf = files.find((name) => name.toLowerCase().endsWith(PDF_EXPORT_SUFFIX));
    if (!firstPdf) {
      fail("PPT 转 PDF 失败：未找到导出的 PDF 文件。");
    }
    return path.join(pdfDir, firstPdf);
  }
}

async function collectPngPages(tempPngDir: string): Promise<string[]> {
  const files = await readdir(tempPngDir);
  return files
    .filter((name) => /^slide-\d+\.png$/i.test(name))
    .sort((a, b) => {
      const ai = Number.parseInt(a.replace(/\D+/g, ""), 10);
      const bi = Number.parseInt(b.replace(/\D+/g, ""), 10);
      return ai - bi;
    });
}

async function clearExistingSlides(slidesDir: string): Promise<void> {
  const files = await readdir(slidesDir);
  const targets = files.filter((name) => /^slide-\d{3}\.(png|jpg)$/i.test(name));
  await Promise.all(targets.map((name) => rm(path.join(slidesDir, name), { force: true })));
}

#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { initEnv } from "./env";
import { generateImage, taskImagePath } from "./image";
import { buildTaskPaths, MEDIA_ROOT } from "./paths";
import { renderSegmentsAndConcat } from "./render";
import { writeSrtFiles } from "./srt";
import { synthesizeSegments } from "./tts";
import type { Segment } from "./types";
import { checkBinary, ensureDir, fail, logInfo } from "./utils";
import { validateSlidesHtml } from "./validate";

initEnv();

const program = new Command();

program
  .name("marketing-video")
  .description("营销视频工具：图片生成、幻灯片截图、TTS、字幕与成片渲染。");

program
  .command("init")
  .description("初始化目录结构（media/assets,inbound,wip,outbound）")
  .action(async () => {
    try {
      await ensureDir(path.join(MEDIA_ROOT, "assets"));
      await ensureDir(path.join(MEDIA_ROOT, "inbound"));
      await ensureDir(path.join(MEDIA_ROOT, "wip"));
      await ensureDir(path.join(MEDIA_ROOT, "outbound"));
      logInfo(`初始化完成：${MEDIA_ROOT}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] init 失败: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("screenshot")
  .description(
    "补图并写回 slides.html → slides/slide-*.png；成片前请人工检查 PNG（见 AGENTS.md Visual QA）",
  )
  .requiredOption("--task-id <id>", "Task ID")
  .action(async (opts: { taskId: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      await ensureDir(paths.slidesDir);
      await validateSlidesHtml(paths.slidesHtmlPath, {
        allowUnresolvedImagePlaceholders: true,
        allowPlaceholderTokens: true,
      });
      const { screenshotSlides } = await import("./screenshot");
      const result = await screenshotSlides(
        paths.slidesHtmlPath,
        paths.slidesDir,
      );
      logInfo(`Captured ${String(result.count)} slide screenshots.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Error] screenshot failed: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("validate")
  .description(
    "对 slides.html 做终检，阻止模板残留、过程文案和未替换占位块进入成片",
  )
  .requiredOption("--task-id <id>", "Task ID")
  .action(async (opts: { taskId: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      await validateSlidesHtml(paths.slidesHtmlPath);
      logInfo("slides.html 终检通过。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] validate 失败: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("image")
  .description("根据 prompt 生成 JPEG 配图，供 slides.html 内部通过 <img> 引用")
  .requiredOption("--task-id <id>", "任务 ID")
  .requiredOption("--prompt <text>", "完整图片提示词")
  .option(
    "--filename <name>",
    "输出文件名（默认写入 wip/<task-id>/images/）",
    "image.jpg",
  )
  .option("--output-path <path>", "覆盖默认输出路径")
  .option("--image-size <size>", "1K 或 2K", "2K")
  .option("--aspect-ratio <r>", "16:9 | 9:16 | 1:1 | 3:4 | 4:3", "16:9")
  .option("--guidance-scale <n>", "引导强度", "1.5")
  .action(
    async (opts: {
      taskId: string;
      prompt: string;
      filename?: string;
      outputPath?: string;
      imageSize?: string;
      aspectRatio?: string;
      guidanceScale?: string;
    }) => {
      try {
        const paths = buildTaskPaths(opts.taskId);
        await ensureDir(paths.imagesDir);
        const aspectRatio = parseAspectRatio(opts.aspectRatio ?? "16:9");
        const guidanceScale = parseGuidanceScale(opts.guidanceScale ?? "1.5");
        const imageSize = parseImageSize(opts.imageSize ?? "2K");
        const outputPath = opts.outputPath?.trim()
          ? path.resolve(opts.outputPath.trim())
          : taskImagePath(
              paths.imagesDir,
              normalizeImageFileName(opts.filename ?? "image.jpg"),
            );
        const writtenPath = await generateImage({
          prompt: opts.prompt,
          outputPath,
          imageSize,
          aspectRatio,
          guidanceScale,
        });
        logInfo(`图片已生成：${writtenPath}`);
        const relPath = path.relative(paths.wipDir, writtenPath);
        if (relPath && !relPath.startsWith("..") && !path.isAbsolute(relPath)) {
          const htmlPath = relPath.split(path.sep).join("/");
          logInfo(`在 slides.html 中可引用：./${htmlPath}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[错误] image 失败: ${message}`);
        process.exitCode = 1;
      }
    },
  );

program
  .command("tts")
  .description("segments.json → audio/*.mp3，并写回带时长 segments")
  .requiredOption("--task-id <id>", "任务 ID")
  .option(
    "--voice <voice>",
    "MiniMax voice_id；默认 English_Explanatory_Man",
    "English_Explanatory_Man",
  )
  .option("--tts-speed <n>", "0.5–2.0", "1.0")
  .action(async (opts: { taskId: string; voice: string; ttsSpeed: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      await ensureDir(paths.audioDir);
      await synthesizeSegments(paths.segmentsPath, paths.audioDir, opts.voice, {
        speed: parseTtsSpeed(opts.ttsSpeed),
      });
      logInfo("TTS 完成，segments.json 已更新。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] tts 失败: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("srt")
  .description("根据 segments 生成字幕文件")
  .requiredOption("--task-id <id>", "任务 ID")
  .action(async (opts: { taskId: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      await ensureDir(paths.subtitlesDir);
      const raw = await readFile(paths.segmentsPath, "utf-8");
      const data = JSON.parse(raw) as { segments?: Segment[] };
      const segments = Array.isArray(data.segments) ? data.segments : [];
      if (segments.length === 0) {
        fail("segments.json 无分段。");
      }
      const { allSrtPath } = await writeSrtFiles(segments, paths.subtitlesDir);
      logInfo(`字幕已写入：${allSrtPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] srt 失败: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("render")
  .description("幻灯片图片 + 音频 + 字幕 → 片段与成片 mp4")
  .requiredOption("--task-id <id>", "任务 ID")
  .option(
    "--out <path>",
    "输出视频路径（默认 <MEDIA_ROOT>/outbound/<task-id>.mp4）",
  )
  .action(async (opts: { taskId: string; out?: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId, opts.out?.trim());
      await ensureDir(paths.clipsDir);
      await checkBinary("ffmpeg");
      await checkBinary("ffprobe");
      const raw = await readFile(paths.segmentsPath, "utf-8");
      const data = JSON.parse(raw) as { segments?: Segment[] };
      const segments = Array.isArray(data.segments) ? data.segments : [];
      if (segments.length === 0) {
        fail("segments.json 无分段。");
      }
      const missingAudio = segments.some(
        (s) => !s.audioPath || !s.durationSeconds,
      );
      if (missingAudio) {
        fail("请先执行 tts，确保每段含 audioPath 与 durationSeconds。");
      }
      await renderSegmentsAndConcat({
        segments,
        slidesDir: paths.slidesDir,
        subtitlesDir: paths.subtitlesDir,
        clipsDir: paths.clipsDir,
        concatPath: paths.concatPath,
        outputPath: paths.outputPath,
      });
      logInfo(`成片：${paths.outputPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] render 失败: ${message}`);
      process.exitCode = 1;
    }
  });

function parseTtsSpeed(raw: string): number {
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n) || n < 0.5 || n > 2.0) {
    fail(`无效的 --tts-speed：${raw}（MiniMax 支持 0.5–2.0）`);
  }
  return n;
}

function parseImageSize(raw: string): "1K" | "2K" {
  if (raw === "1K" || raw === "2K") {
    return raw;
  }
  fail(`无效的 --image-size：${raw}（仅支持 1K 或 2K）`);
}

function parseAspectRatio(
  raw: string,
): "16:9" | "9:16" | "1:1" | "3:4" | "4:3" {
  const allowed = ["16:9", "9:16", "1:1", "3:4", "4:3"] as const;
  if (allowed.includes(raw as (typeof allowed)[number])) {
    return raw as (typeof allowed)[number];
  }
  fail(`无效的 --aspect-ratio：${raw}`);
}

function parseGuidanceScale(raw: string): number {
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n)) {
    fail(`无效的 --guidance-scale：${raw}`);
  }
  return n;
}

function normalizeImageFileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    fail("无效的 --filename：不能为空。");
  }
  if (trimmed !== path.basename(trimmed)) {
    fail("无效的 --filename：只能填写文件名，不能包含目录。");
  }
  const ext = path.extname(trimmed);
  if (!ext) {
    return `${trimmed}.jpg`;
  }
  if (ext.toLowerCase() !== ".jpg" && ext.toLowerCase() !== ".jpeg") {
    fail("无效的 --filename：输出格式仅支持 .jpg 或 .jpeg。");
  }
  return trimmed;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[错误] 命令执行失败: ${message}`);
  process.exit(1);
});

#!/usr/bin/env node
import { Command } from "commander";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initEnv } from "./env";
import { generateImage, taskImagePath } from "./image";
import { buildTaskPaths, MEDIA_ROOT } from "./paths";
import { screenshotPpt } from "./ppt-screenshot";
import { validateSlideFramesAgainstSegments } from "./frame-validate";
import { renderSegmentsAndConcat } from "./render";
import { importStoryboardToSegments } from "./script-import";
import { runQualityChecks } from "./qa";
import { writeSrtFiles } from "./srt";
import { synthesizeSegments } from "./tts";
import type { Segment } from "./types";
import { checkBinary, ensureDir, execCommand, fail, logInfo, logWarn } from "./utils";

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
  .command("ppt-screenshot")
  .description("将 slides.pptx 自动导出为 slides/slide-001.png ...")
  .requiredOption("--task-id <id>", "Task ID")
  .option("--pptx-path <path>", "覆盖默认 PPT 路径（默认 wip/<task-id>/slides.pptx）")
  .option("--pdf-path <path>", "直接使用 PDF 输入（建议用 PowerPoint 导出的 PDF）")
  .option("--strict-pdf", "强制使用 PDF 作为导出源（缺失则失败）", false)
  .action(async (opts: { taskId: string; pptxPath?: string; pdfPath?: string; strictPdf?: boolean }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      await ensureDir(paths.slidesDir);
      const inputPath = await resolvePptScreenshotInputPath(paths.pptxPath, opts, {
        preferPowerPointPdf: true,
        requirePdfSource: opts.strictPdf === true,
      });
      const result = await screenshotPpt({ pptxPath: inputPath, outputDir: paths.slidesDir });
      logInfo(`已导出 ${String(result.count)} 张 PPT 幻灯片。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] ppt-screenshot 失败: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("run-interactive")
  .description("交互式完整流程：逐步执行并在每步人工确认后继续")
  .requiredOption("--task-id <id>", "任务 ID")
  .option("--pptx-path <path>", "覆盖默认 PPT 路径（默认 wip/<task-id>/slides.pptx）")
  .option("--pdf-path <path>", "直接使用 PDF 输入（建议用 PowerPoint 导出的 PDF）")
  .option(
    "--voice <voice>",
    "MiniMax voice_id；默认 auto（按段落语言自动选音色）",
    "auto",
  )
  .option("--tts-speed <n>", "0.5–2.0", "1.0")
  .option("--subtitle-mode <mode>", "semantic | strict-single", "semantic")
  .option("--max-duration-drift-ratio <n>", "允许的时长偏差比例，默认 0.03", "0.03")
  .option(
    "--approve-stage <stage>",
    "非交互模式下人工确认当前阶段后继续：screenshot|narration|tts|subtitle|qa",
  )
  .option(
    "--out <path>",
    "输出视频路径（默认 <MEDIA_ROOT>/outbound/<task-id>.mp4）",
  )
  .action(
    async (opts: {
      taskId: string;
      pptxPath?: string;
      pdfPath?: string;
      voice: string;
      ttsSpeed: string;
      subtitleMode: string;
      maxDurationDriftRatio: string;
      approveStage?: string;
      out?: string;
    }) => {
      try {
        const interactive = input.isTTY && output.isTTY;
        const paths = buildTaskPaths(opts.taskId, opts.out?.trim());
        await ensureDir(paths.wipDir);
        await ensureDir(paths.slidesDir);
        await ensureDir(paths.audioDir);
        await ensureDir(paths.subtitlesDir);
        await ensureDir(paths.clipsDir);

        const slideSourcePath = await resolvePptScreenshotInputPath(paths.pptxPath, opts, {
          preferPowerPointPdf: true,
          requirePdfSource: true,
        });
        logInfo(`步骤 1/6：导出 PPT 帧（source=${slideSourcePath}）`);
        const screenshotResult = await screenshotPpt({
          pptxPath: slideSourcePath,
          outputDir: paths.slidesDir,
        });
        logInfo(`已导出 ${String(screenshotResult.count)} 张图片，请先人工预审：`);
        for (const filePath of screenshotResult.files) {
          logInfo(`- ${filePath}`);
        }
        await askForApproval({
          interactive,
          taskId: opts.taskId,
          stage: "screenshot",
          approvedStage: opts.approveStage,
          wipDir: paths.wipDir,
          prompt: "截图预审是否满意？（输入 y 继续，n 中止）",
          rejectTips: [
          "请逐页检查标题/正文是否缺字或被截断。",
          `优先复核截图目录：${paths.slidesDir}`,
          `若有版式偏差，请在 PowerPoint 导出 PDF 后重试：${path.join(paths.wipDir, "slides.pdf")}`,
          ],
        });

        logInfo("步骤 2/6：导出每页解读供人工预审");
        const segmentsForNarrationReview = await readSegments(paths.segmentsPath);
        const narrationReviewPath = await exportNarrationReviewFile({
          wipDir: paths.wipDir,
          slidesDir: paths.slidesDir,
          segments: segmentsForNarrationReview,
        });
        logInfo(`每页解读审阅文件已写入：${narrationReviewPath}`);
        await askForApproval({
          interactive,
          taskId: opts.taskId,
          stage: "narration",
          approvedStage: opts.approveStage,
          wipDir: paths.wipDir,
          prompt: "每页解读预审是否满意？（输入 y 继续，n 中止）",
          rejectTips: [
          `请逐页审阅解读文稿：${narrationReviewPath}`,
          "重点检查每页讲解是否准确对应当前 PPT 页面。",
          "如需修改，请更新 segments.json 后重新执行 run-interactive。",
          ],
        });

        logInfo("步骤 3/6：生成 TTS 音频");
        await synthesizeSegments(paths.segmentsPath, paths.audioDir, opts.voice, {
          speed: parseTtsSpeed(opts.ttsSpeed),
        });
        await askForApproval({
          interactive,
          taskId: opts.taskId,
          stage: "tts",
          approvedStage: opts.approveStage,
          wipDir: paths.wipDir,
          prompt: "TTS 结果是否满意？（输入 y 继续，n 中止）",
          rejectTips: [
          `请抽听音频目录中的片段：${paths.audioDir}`,
          "如需调整语速可重跑并修改 --tts-speed（范围 0.5-2.0）。",
          "如需固定音色可重跑并传 --voice <voice_id>。",
          ],
        });

        logInfo("步骤 4/6：生成字幕");
        const segmentsForSrt = await readSegments(paths.segmentsPath);
        const { allSrtPath } = await writeSrtFiles(segmentsForSrt, paths.subtitlesDir, {
          subtitleMode: parseSubtitleMode(opts.subtitleMode),
        });
        logInfo(`字幕已写入：${allSrtPath}`);
        await askForApproval({
          interactive,
          taskId: opts.taskId,
          stage: "subtitle",
          approvedStage: opts.approveStage,
          wipDir: paths.wipDir,
          prompt: "字幕结果是否满意？（输入 y 继续，n 中止）",
          rejectTips: [
          `请优先预审总字幕：${allSrtPath}`,
          `逐段字幕目录：${paths.subtitlesDir}`,
          "若字幕切换不理想，可重跑 srt 并调整 --subtitle-mode。",
          ],
        });

        logInfo("步骤 5/6：自动 QA 检查");
        const segmentsForQa = await readSegments(paths.segmentsPath);
        await runQualityChecks({
          subtitlesDir: paths.subtitlesDir,
          segments: segmentsForQa,
          options: {
            maxDurationDriftRatio: parseDriftRatio(opts.maxDurationDriftRatio),
          },
        });
        logInfo("QA 通过。");
        await askForApproval({
          interactive,
          taskId: opts.taskId,
          stage: "qa",
          approvedStage: opts.approveStage,
          wipDir: paths.wipDir,
          prompt: "QA 通过，是否继续渲染成片？（输入 y 继续，n 中止）",
          rejectTips: [
          "建议先抽查至少 2 页（开头/中段）确认语音与字幕对齐。",
          `如需人工复核，请查看字幕目录：${paths.subtitlesDir}`,
          "确认无误后重新执行 run-interactive 并继续。",
          ],
        });

        logInfo("步骤 6/6：渲染视频");
        await checkBinary("ffmpeg");
        await checkBinary("ffprobe");
        const segmentsForRender = await readSegments(paths.segmentsPath);
        await validateSlideFramesAgainstSegments(paths.slidesDir, segmentsForRender);
        const missingAudio = segmentsForRender.some((s) => !s.audioPath || !s.durationSeconds);
        if (missingAudio) {
          fail("请先执行 tts，确保每段含 audioPath 与 durationSeconds。");
        }
        await renderSegmentsAndConcat({
          segments: segmentsForRender,
          slidesDir: paths.slidesDir,
          subtitlesDir: paths.subtitlesDir,
          clipsDir: paths.clipsDir,
          concatPath: paths.concatPath,
          outputPath: paths.outputPath,
        });
        logInfo(`交互式流程完成，成片：${paths.outputPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[错误] run-interactive 失败: ${message}`);
        process.exitCode = 1;
      }
    },
  );

program
  .command("screenshot")
  .description("已弃用：HTML 截图流程已移除，请改用 ppt-screenshot")
  .requiredOption("--task-id <id>", "Task ID")
  .action(async () => {
    try {
      fail("命令 screenshot 已弃用。请执行：npm run video -- ppt-screenshot --task-id <id>");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] screenshot 已弃用: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("validate")
  .description("已弃用：HTML 校验流程已移除")
  .requiredOption("--task-id <id>", "Task ID")
  .action(async () => {
    try {
      fail("命令 validate 已弃用。PPT-only 流程请使用：ppt-screenshot -> tts -> srt -> render");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] validate 已弃用: ${message}`);
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
  .command("script-import")
  .description("将 scene/shot 脚本 JSON 转换为 segments.json")
  .requiredOption("--task-id <id>", "任务 ID")
  .option(
    "--script-path <path>",
    "脚本 JSON 路径（默认 wip/<task-id>/script.json）",
  )
  .option("--timeline-mode <mode>", "tts | script（script 按 shot.duration_sec 作为目标时长）", "tts")
  .action(async (opts: { taskId: string; scriptPath?: string; timelineMode: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      await ensureDir(paths.wipDir);
      const scriptPath = opts.scriptPath?.trim()
        ? path.resolve(opts.scriptPath.trim())
        : path.join(paths.wipDir, "script.json");
      const shotMapPath = path.join(paths.wipDir, "shot-map.json");
      const result = await importStoryboardToSegments({
        scriptPath,
        segmentsPath: paths.segmentsPath,
        shotMapPath,
        timelineMode: parseTimelineMode(opts.timelineMode),
      });
      logInfo(
        `脚本导入完成：segments=${String(result.segmentCount)}，跳过无旁白镜头=${String(result.skippedSilentShots)}`,
      );
      logInfo(`已写入：${result.segmentsPath}`);
      logInfo(`镜头映射：${result.shotMapPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] script-import 失败: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("tts")
  .description("segments.json → audio/*.mp3，并写回带时长 segments")
  .requiredOption("--task-id <id>", "任务 ID")
  .option(
    "--voice <voice>",
    "MiniMax voice_id；默认 auto（按段落语言自动选音色）",
    "auto",
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
  .option("--subtitle-mode <mode>", "semantic | strict-single", "semantic")
  .action(async (opts: { taskId: string; subtitleMode: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      await ensureDir(paths.subtitlesDir);
      const raw = await readFile(paths.segmentsPath, "utf-8");
      const data = JSON.parse(raw) as { segments?: Segment[] };
      const segments = Array.isArray(data.segments) ? data.segments : [];
      if (segments.length === 0) {
        fail("segments.json 无分段。");
      }
      const { allSrtPath } = await writeSrtFiles(segments, paths.subtitlesDir, {
        subtitleMode: parseSubtitleMode(opts.subtitleMode),
      });
      logInfo(`字幕已写入：${allSrtPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] srt 失败: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("qa")
  .description("渲染前质量检查：字幕单行、无标点、时长偏差")
  .requiredOption("--task-id <id>", "任务 ID")
  .option("--max-duration-drift-ratio <n>", "允许的时长偏差比例，默认 0.03", "0.03")
  .action(async (opts: { taskId: string; maxDurationDriftRatio: string }) => {
    try {
      const paths = buildTaskPaths(opts.taskId);
      const raw = await readFile(paths.segmentsPath, "utf-8");
      const data = JSON.parse(raw) as { segments?: Segment[] };
      const segments = Array.isArray(data.segments) ? data.segments : [];
      if (segments.length === 0) {
        fail("segments.json 无分段。");
      }
      await runQualityChecks({
        subtitlesDir: paths.subtitlesDir,
        segments,
        options: {
          maxDurationDriftRatio: parseDriftRatio(opts.maxDurationDriftRatio),
        },
      });
      logInfo("QA 通过：字幕单行/无标点/时长偏差满足阈值。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[错误] qa 失败: ${message}`);
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
      await validateSlideFramesAgainstSegments(paths.slidesDir, segments);
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

async function readSegments(segmentsPath: string): Promise<Segment[]> {
  const raw = await readFile(segmentsPath, "utf-8");
  const data = JSON.parse(raw) as { segments?: Segment[] };
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (segments.length === 0) {
    fail("segments.json 无分段。");
  }
  return segments;
}

async function askForApproval(inputArgs: {
  interactive: boolean;
  taskId: string;
  stage: "screenshot" | "narration" | "tts" | "subtitle" | "qa";
  approvedStage?: string;
  wipDir: string;
  prompt: string;
  rejectTips: string[];
}): Promise<void> {
  if (!inputArgs.interactive) {
    if (inputArgs.approvedStage === inputArgs.stage) {
      logInfo(`已通过 --approve-stage=${inputArgs.stage} 确认，继续执行。`);
      return;
    }
    const approvalPath = path.join(inputArgs.wipDir, "PENDING_APPROVAL.md");
    const body = [
      "# Pending Manual Approval",
      "",
      `Stage: ${inputArgs.stage}`,
      "",
      "This run is in non-interactive mode, so manual confirmation is required.",
      "",
      "## What to review",
      ...inputArgs.rejectTips.map((tip) => `- ${tip}`),
      "",
      "## Continue command",
      `npm run video -- run-interactive --task-id ${inputArgs.taskId} --approve-stage ${inputArgs.stage}`,
      "",
    ].join("\n");
    await writeFile(approvalPath, `${body}\n`, "utf-8");
    fail(
      `当前为非交互终端，已写入人工确认文件：${approvalPath}。确认后请用 --approve-stage ${inputArgs.stage} 继续。`,
    );
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${inputArgs.prompt}\n> `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      for (const tip of inputArgs.rejectTips) {
        logInfo(`建议：${tip}`);
      }
      fail("用户未确认通过，流程已中止。");
    }
  } finally {
    rl.close();
  }
}

async function resolvePptScreenshotInputPath(
  defaultPptxPath: string,
  opts: { pptxPath?: string; pdfPath?: string },
  options?: {
    preferPowerPointPdf?: boolean;
    requirePdfSource?: boolean;
  },
): Promise<string> {
  if (opts.pptxPath?.trim() && opts.pdfPath?.trim()) {
    fail("`--pptx-path` 与 `--pdf-path` 不能同时传。");
  }
  let inputPath = opts.pdfPath?.trim()
    ? path.resolve(opts.pdfPath.trim())
    : opts.pptxPath?.trim()
      ? path.resolve(opts.pptxPath.trim())
      : defaultPptxPath;
  if (!opts.pdfPath?.trim() && !opts.pptxPath?.trim()) {
    const siblingPdfPath = path.join(path.dirname(defaultPptxPath), "slides.pdf");
    const hasSiblingPdf = await stat(siblingPdfPath)
      .then(() => true)
      .catch(() => false);
    if (hasSiblingPdf) {
      inputPath = siblingPdfPath;
      logInfo("检测到同目录 slides.pdf，已优先使用 PDF 导出以避免字体替换导致的丢字。");
    } else if (options?.preferPowerPointPdf) {
      const exported = await tryExportPdfWithPowerPoint(defaultPptxPath, siblingPdfPath);
      if (exported) {
        inputPath = siblingPdfPath;
        logInfo("已通过 PowerPoint 自动导出 slides.pdf，并将其作为导出源。");
      } else if (options.requirePdfSource) {
        fail(
          "未找到 slides.pdf，且自动调用 PowerPoint 导出失败。请手动在 PowerPoint 导出 slides.pdf 后重试。",
        );
      }
    }
  }
  if (
    options?.requirePdfSource &&
    path.extname(inputPath).toLowerCase() !== ".pdf"
  ) {
    fail("当前流程要求使用 PDF 作为导出源，请传 --pdf-path 或先准备 slides.pdf。");
  }
  return inputPath;
}

async function tryExportPdfWithPowerPoint(
  pptxPath: string,
  outputPdfPath: string,
): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  const escapedPptx = escapeAppleScriptPath(pptxPath);
  const escapedPdf = escapeAppleScriptPath(outputPdfPath);
  const script = [
    `set pptxFile to POSIX file "${escapedPptx}"`,
    `set pdfFile to POSIX file "${escapedPdf}"`,
    'tell application "Microsoft PowerPoint"',
    "open pptxFile",
    "save active presentation in pdfFile as save as PDF",
    "close active presentation saving no",
    "end tell",
  ].join("\n");

  try {
    await execCommand("osascript", ["-e", script]);
    await stat(outputPdfPath);
    return true;
  } catch (error) {
    logWarn(`自动调用 PowerPoint 导出 PDF 失败：${String(error)}`);
    return false;
  }
}

function escapeAppleScriptPath(filePath: string): string {
  return filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function exportNarrationReviewFile(input: {
  wipDir: string;
  slidesDir: string;
  segments: Segment[];
}): Promise<string> {
  const reviewDir = path.join(input.wipDir, "review");
  await ensureDir(reviewDir);
  const reviewPath = path.join(reviewDir, "slide-narration-review.md");
  const lines: string[] = [
    "# Slide Narration Review",
    "",
    "Please review each slide narration before TTS.",
    "",
  ];
  for (const segment of input.segments) {
    const slideFile = `slide-${String(segment.slideIndex).padStart(3, "0")}.png`;
    const slidePath = path.join(input.slidesDir, slideFile);
    lines.push(`## Slide ${String(segment.slideIndex).padStart(3, "0")} / Segment ${String(segment.index).padStart(3, "0")}`);
    lines.push(`- Slide image: ${slidePath}`);
    lines.push("- Narration:");
    lines.push("");
    lines.push(segment.narration.trim() || "(empty)");
    lines.push("");
  }
  await writeFile(reviewPath, `${lines.join("\n")}\n`, "utf-8");
  return reviewPath;
}

function parseTimelineMode(raw: string): "tts" | "script" {
  if (raw === "tts" || raw === "script") {
    return raw;
  }
  fail(`无效的 --timeline-mode：${raw}（仅支持 tts 或 script）`);
}

function parseSubtitleMode(raw: string): "semantic" | "strict-single" {
  if (raw === "semantic" || raw === "strict-single") {
    return raw;
  }
  fail(`无效的 --subtitle-mode：${raw}（仅支持 semantic 或 strict-single）`);
}

function parseDriftRatio(raw: string): number {
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    fail(`无效的 --max-duration-drift-ratio：${raw}`);
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

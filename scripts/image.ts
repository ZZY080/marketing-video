/**
 * Generate slide images via the Gemini API:
 * - **Imagen** models (`imagen-*`): `models.generateImages` — see https://ai.google.dev/gemini-api/docs/imagen
 * - **Nano Banana** (`gemini-*-image*` 等): `models.generateContent` + image modality — see https://ai.google.dev/gemini-api/docs/image-generation
 *
 * One API call per image. Does not modify slides.html — callers insert files via <img>.
 */
import {
  GoogleGenAI,
  Modality,
  type GenerateContentResponse,
} from "@google/genai";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { initEnv } from "./env";
import {
  ensureDir,
  fail,
  formatErrorDetail,
  logError,
  logInfo,
  logWarn,
} from "./utils";

initEnv();

const DEFAULT_GUIDANCE = 1.5;
const DEFAULT_ASPECT = "16:9";

function uniqModelCandidates(models: string[]): string[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    const t = m.trim();
    if (!t || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

/** Imagen 系列使用 generateImages；官方型号见 Imagen 文档。 */
function isImagenModelId(model: string): boolean {
  return model.startsWith("imagen-");
}

/** Default Nano Banana model (generateContent + IMAGE); Imagen ids are fallbacks. */
const IMAGE_MODEL_CANDIDATES = uniqModelCandidates([
  process.env.GOOGLE_IMAGE_MODEL?.trim() ?? "",
  "gemini-2.5-flash-image",
  "imagen-4.0-generate-001",
  "imagen-4.0-fast-generate-001",
]);

function resolveOutputPathForMime(
  requestedPath: string,
  mimeType?: string,
): string {
  if (mimeType === "image/png" || mimeType === "image/webp") {
    return requestedPath.replace(/\.(jpe?g)$/i, ".png");
  }
  return requestedPath;
}

function extractBase64ImageFromGenerateContentResponse(
  response: GenerateContentResponse,
): { base64: string; mimeType?: string } | undefined {
  const fromGetter = response.data;
  if (typeof fromGetter === "string" && fromGetter.length > 0) {
    return { base64: fromGetter };
  }
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) return undefined;
  for (const part of parts) {
    const id = part.inlineData;
    if (id?.data) {
      return { base64: id.data, mimeType: id.mimeType };
    }
  }
  return undefined;
}

export interface GenerateImageInput {
  prompt: string;
  /** Where to write the image (e.g. wip/<task-id>/images/cover.jpg). */
  outputPath: string;
  imageSize?: "1K" | "2K";
  aspectRatio?: "16:9" | "9:16" | "1:1" | "3:4" | "4:3";
  guidanceScale?: number;
}

type Aspect = NonNullable<GenerateImageInput["aspectRatio"]>;

/** Predictable helper path for HTML slide image assets. */
export function taskImagePath(
  imagesDir: string,
  fileName = "image.jpg",
): string {
  return path.join(imagesDir, fileName);
}

export async function generateImage(
  input: GenerateImageInput,
): Promise<string> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    fail("generateImage: prompt 不能为空。");
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    fail("缺少 GEMINI_API_KEY，无法生成图片。");
  }

  const out = path.resolve(input.outputPath);
  await ensureDir(path.dirname(out));

  const ai = new GoogleGenAI({ apiKey });
  const aspectRatio = (input.aspectRatio ?? DEFAULT_ASPECT) as Aspect;
  const imageSize = input.imageSize ?? "2K";
  const guidanceScale = input.guidanceScale ?? DEFAULT_GUIDANCE;

  logInfo(
    `generateImage 开始：输出 ${out}，画幅 ${aspectRatio}，尺寸 ${imageSize}，引导 ${String(guidanceScale)}，提示词长度 ${String(prompt.length)} 字符。`,
  );

  let lastError: unknown;
  for (const model of IMAGE_MODEL_CANDIDATES) {
    try {
      logInfo(
        `正在调用图片模型：${model}（${isImagenModelId(model) ? "Imagen generateImages" : "Gemini generateContent+IMAGE"}）`,
      );

      if (isImagenModelId(model)) {
        const response = await ai.models.generateImages({
          model,
          prompt,
          config: {
            numberOfImages: 1,
            aspectRatio,
            imageSize,
            outputMimeType: "image/jpeg",
            guidanceScale,
          },
        });

        const imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;
        if (!imageBytes) {
          const responseDump = inspect(response, {
            depth: 10,
            maxArrayLength: 20,
            maxStringLength: 4000,
            colors: false,
          });
          logError(
            `模型 ${model} 返回中缺少 imageBytes（generatedImages[0].image.imageBytes）。完整响应摘要：\n${responseDump}`,
          );
          fail(
            `图片生成失败：模型 ${model} 未返回 imageBytes。详见上方 [错误] 日志中的 API 响应。`,
          );
        }

        await writeFile(out, Buffer.from(imageBytes, "base64"));
        logInfo(`generateImage 成功：${out}（Imagen 模型 ${model}）`);
        return out;
      }

      const gcResponse = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseModalities: [Modality.IMAGE],
          imageConfig: {
            aspectRatio,
            imageSize,
          },
        },
      });

      const extracted =
        extractBase64ImageFromGenerateContentResponse(gcResponse);
      if (!extracted) {
        const responseDump = inspect(gcResponse, {
          depth: 10,
          maxArrayLength: 20,
          maxStringLength: 4000,
          colors: false,
        });
        logError(
          `模型 ${model}（generateContent）未返回可写入的图像数据。响应摘要：\n${responseDump}`,
        );
        fail(
          `图片生成失败：模型 ${model} 未返回内联图像数据。详见上方 [错误] 日志。`,
        );
      }

      const writePath = resolveOutputPathForMime(out, extracted.mimeType);
      await ensureDir(path.dirname(writePath));
      await writeFile(writePath, Buffer.from(extracted.base64, "base64"));
      logInfo(`generateImage 成功：${writePath}（Gemini 图像模型 ${model}）`);
      return writePath;
    } catch (error) {
      lastError = error;
      logError(
        `图片模型 ${model} 调用失败，详情如下：\n${formatErrorDetail(error)}`,
      );
      logWarn(`图片模型 ${model} 未成功，将尝试下一候选模型（若有）。`);
    }
  }

  logError(
    `generateImage 全部候选模型均失败。最后一次错误：\n${formatErrorDetail(lastError)}`,
  );
  const short =
    lastError instanceof Error
      ? lastError.message
      : String(lastError ?? "unknown");
  fail(`图片生成失败（所有候选模型已用尽）：${short}`);
}

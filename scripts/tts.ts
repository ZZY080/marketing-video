import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Segment, SubtitleCue } from "./types";
import { execCommand, fail, formatIndex, logInfo, logWarn } from "./utils";

/** 标准自然语速 */
const DEFAULT_TTS_SPEED = 1.0;

const DEFAULT_MINIMAX_MODEL = "speech-2.8-hd";
const DEFAULT_MINIMAX_ENDPOINT = "https://api.minimaxi.com/v1/t2a_v2";
const DEFAULT_MINIMAX_VOICE_ID = "English_Explanatory_Man";
const AUTO_VOICE = "auto";

interface MiniMaxResponse {
  data?: {
    audio?: string;
    status?: number;
    subtitle_file?: string;
  } | null;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  } | null;
}

interface MiniMaxSubtitleItem {
  text?: string;
  time_begin?: number;
  time_end?: number;
}

export interface SynthesizeOptions {
  /** MiniMax voice_setting.speed，默认 1.0。 */
  speed?: number;
}

export async function synthesizeSegments(
  segmentsPath: string,
  audioDir: string,
  voice: string,
  options?: SynthesizeOptions,
): Promise<Segment[]> {
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    fail("缺少 MINIMAX_API_KEY，无法执行 MiniMax TTS。");
  }

  const raw = await readFile(segmentsPath, "utf-8");
  const data = JSON.parse(raw) as { title?: string; segments?: Segment[] };
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (segments.length === 0) {
    fail("segments.json 中没有可用于 TTS 的分段。");
  }

  const next: Segment[] = [];
  const speed = resolveTtsSpeed(options?.speed);
  const endpoint = DEFAULT_MINIMAX_ENDPOINT;
  const model = DEFAULT_MINIMAX_MODEL;
  const voiceId = resolveMiniMaxVoiceId(voice, segments);
  logInfo(`TTS voice: ${voiceId}`);

  for (const segment of segments) {
    const narration = segment.narration.trim();
    if (!narration) {
      fail(`第 ${String(segment.index)} 段 narration 为空，无法生成音频。`);
    }
    const indexText = formatIndex(segment.index);
    const outputPath = path.join(audioDir, `segment-${indexText}.mp3`);
    logInfo(`正在生成第 ${String(segment.index)} 段音频...`);

    const { audioBytes, subtitleCues } = await requestMiniMaxTts({
      endpoint,
      apiKey,
      model,
      voiceId,
      speed,
      text: narration,
    });
    await writeFile(outputPath, audioBytes);
    const durationSeconds = await probeDuration(outputPath);
    if (durationSeconds <= 0) {
      fail(`第 ${String(segment.index)} 段音频时长异常。`);
    }

    next.push({
      ...segment,
      audioPath: outputPath,
      durationSeconds,
      subtitleCues,
    });
  }

  const merged = {
    ...data,
    segments: next,
  };
  await writeFile(
    segmentsPath,
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf-8",
  );
  return next;
}

function resolveTtsSpeed(override?: number): number {
  let base = DEFAULT_TTS_SPEED;
  if (override !== undefined && Number.isFinite(override)) {
    base = override;
  }
  return Math.min(2.0, Math.max(0.5, base));
}

function resolveMiniMaxVoiceId(rawVoice: string, _segments: Segment[]): string {
  const voice = rawVoice.trim();
  if (voice && voice.toLowerCase() !== AUTO_VOICE) {
    return voice;
  }
  return DEFAULT_MINIMAX_VOICE_ID;
}

async function requestMiniMaxTts(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  voiceId: string;
  speed: number;
  text: string;
}): Promise<{ audioBytes: Buffer; subtitleCues: SubtitleCue[] }> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      text: input.text,
      stream: false,
      voice_setting: {
        voice_id: input.voiceId,
        speed: input.speed,
        vol: 1,
        pitch: 0,
        emotion: "calm",
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
      subtitle_enable: true,
      output_format: "hex",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    fail(
      `MiniMax TTS 请求失败（HTTP ${String(response.status)}）：${text.slice(0, 500)}`,
    );
  }

  const json = (await response.json()) as MiniMaxResponse;
  const statusCode = Number(json.base_resp?.status_code ?? -1);
  if (statusCode !== 0) {
    fail(
      `MiniMax TTS 返回错误：status_code=${String(statusCode)}，status_msg=${json.base_resp?.status_msg ?? "unknown"}`,
    );
  }

  const audioHex = json.data?.audio?.trim();
  if (!audioHex) {
    fail("MiniMax TTS 未返回可用 audio 数据。");
  }

  try {
    const audioBytes = Buffer.from(audioHex, "hex");
    const subtitleCues = await fetchMiniMaxSubtitleCues(
      json.data?.subtitle_file,
    );
    return { audioBytes, subtitleCues };
  } catch (error) {
    fail(`MiniMax TTS 音频解码失败：${(error as Error).message}`);
  }
}

async function fetchMiniMaxSubtitleCues(
  subtitleFileUrl: string | undefined,
): Promise<SubtitleCue[]> {
  if (!subtitleFileUrl) {
    return [];
  }
  try {
    const response = await fetch(subtitleFileUrl);
    if (!response.ok) {
      logWarn(`下载 TTS 字幕时间戳失败：HTTP ${String(response.status)}。`);
      return [];
    }
    const json = (await response.json()) as unknown;
    if (!Array.isArray(json)) {
      return [];
    }
    const cues = (json as MiniMaxSubtitleItem[])
      .map((item) => {
        const text = String(item.text ?? "").trim();
        const begin = Number(item.time_begin);
        const end = Number(item.time_end);
        if (!text || !Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) {
          return null;
        }
        return {
          text,
          startSeconds: begin / 1000,
          endSeconds: end / 1000,
        } satisfies SubtitleCue;
      })
      .filter((item): item is SubtitleCue => item !== null)
      .sort((a, b) => a.startSeconds - b.startSeconds);
    return cues;
  } catch (error) {
    logWarn(`解析 TTS 字幕时间戳失败：${(error as Error).message}`);
    return [];
  }
}

async function probeDuration(filePath: string): Promise<number> {
  const result = await execCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    filePath,
  ]);
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

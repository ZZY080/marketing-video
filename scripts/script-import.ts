import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Segment } from "./types";
import { fail } from "./utils";

interface StoryboardShot {
  shot_id?: number;
  duration_sec?: number;
  voiceover?: string | null;
}

interface StoryboardScene {
  scene_id?: number;
  shots?: StoryboardShot[];
}

interface StoryboardInput {
  title?: string;
  scenes?: StoryboardScene[];
}

interface ShotMapItem {
  segmentIndex: number;
  slideIndex: number;
  sceneId: number | null;
  shotId: number | null;
  durationSec: number | null;
}

export interface ImportStoryboardResult {
  segmentCount: number;
  skippedSilentShots: number;
  segmentsPath: string;
  shotMapPath: string;
}

export async function importStoryboardToSegments(input: {
  scriptPath: string;
  segmentsPath: string;
  shotMapPath: string;
  timelineMode: "tts" | "script";
}): Promise<ImportStoryboardResult> {
  const raw = await readFile(input.scriptPath, "utf-8");
  const parsed = JSON.parse(raw) as StoryboardInput;

  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  if (scenes.length === 0) {
    fail("脚本缺少 scenes，无法生成 segments.json。");
  }

  const segments: Segment[] = [];
  const shotMap: ShotMapItem[] = [];
  let skippedSilentShots = 0;

  for (const scene of scenes) {
    const shots = Array.isArray(scene.shots) ? scene.shots : [];
    for (const shot of shots) {
      const voiceover = typeof shot.voiceover === "string" ? shot.voiceover.trim() : "";
      if (!voiceover) {
        skippedSilentShots += 1;
        continue;
      }
      const index = segments.length + 1;
      segments.push({
        index,
        slideIndex: index,
        narration: voiceover,
        targetDurationSeconds: input.timelineMode === "script"
          ? normalizeDuration(shot.duration_sec)
          : undefined,
      });
      shotMap.push({
        segmentIndex: index,
        slideIndex: index,
        sceneId: toNumberOrNull(scene.scene_id),
        shotId: toNumberOrNull(shot.shot_id),
        durationSec: toNumberOrNull(shot.duration_sec),
      });
    }
  }

  if (segments.length === 0) {
    fail("脚本中没有可用于旁白生成的 voiceover 文本。");
  }

  const title = (parsed.title ?? path.basename(input.scriptPath)).trim();
  await writeFile(
    input.segmentsPath,
    `${JSON.stringify({ title, segments }, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(
    input.shotMapPath,
    `${JSON.stringify({ title, items: shotMap }, null, 2)}\n`,
    "utf-8",
  );

  return {
    segmentCount: segments.length,
    skippedSilentShots,
    segmentsPath: input.segmentsPath,
    shotMapPath: input.shotMapPath,
  };
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizeDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

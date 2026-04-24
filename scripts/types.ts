export interface SubtitleCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface Segment {
  index: number;
  slideIndex: number;
  narration: string;
  targetDurationSeconds?: number;
  audioPath?: string;
  durationSeconds?: number;
  subtitleCues?: SubtitleCue[];
}

export interface TaskPaths {
  wipDir: string;
  outlinePath: string;
  pptxPath: string;
  slidesHtmlPath: string;
  segmentsPath: string;
  imagesDir: string;
  slidesDir: string;
  audioDir: string;
  subtitlesDir: string;
  clipsDir: string;
  concatPath: string;
  outputPath: string;
}

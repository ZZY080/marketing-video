export interface Segment {
  index: number;
  slideIndex: number;
  narration: string;
  audioPath?: string;
  durationSeconds?: number;
}

export interface TaskPaths {
  wipDir: string;
  outlinePath: string;
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

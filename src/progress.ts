export type ScanProgressStage =
  | "inspect-repository"
  | "discovering-providers"
  | "parsing-sessions"
  | "aggregating-metrics"
  | "selecting-evidence"
  | "resolving-model"
  | "generating-story"
  | "generating-insights"
  | "validating-story-pack"
  | "uploading"
  | "accepted"
  | "failed";

export type ScanProgressEvent = {
  stage: ScanProgressStage;
  state: "start" | "progress" | "complete" | "warning" | "failed";
  message: string;
  provider?: string;
  model?: string;
  current?: number;
  total?: number;
  elapsedMs?: number;
};

export type ScanProgressReporter = (event: ScanProgressEvent) => void;

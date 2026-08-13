import path from "node:path";
import type { AnalysisTier, NarrativeProvider, ProjectSnapshot, ProviderId } from "./contract.js";
import { ScannerError } from "./errors.js";
import { writeLocalReportFiles, type WrittenReportFiles } from "./exporters/write-report.js";
import { createByokNarrativeGenerator, createOllamaNarrativeGenerator, LocalNarrativeGenerationError } from "./narrative/local.js";
import { localCapabilityProfile } from "./narrative/local-capability.js";
import type { ScanProgressReporter } from "./progress.js";
import { buildProjectSnapshot, type ScanOptions } from "./scanner.js";
import {
  CLOUD_STANDARD_MAX_ASSISTANT_DECISIONS_PER_SESSION,
  CLOUD_STANDARD_MAX_CHARS_PER_EXCERPT,
  CLOUD_STANDARD_MAX_EXCERPTS,
  CLOUD_STANDARD_MAX_EXCERPTS_PER_SESSION,
  CLOUD_STANDARD_MAX_TOTAL_EXCERPT_CHARS,
  DEEP_MAX_ASSISTANT_DECISIONS_PER_SESSION,
  DEEP_MAX_CHARS_PER_EXCERPT,
  DEEP_MAX_EXCERPTS,
  DEEP_MAX_EXCERPTS_PER_SESSION,
  DEEP_MAX_TOTAL_EXCERPT_BYTES,
} from "./sources/narrative-evidence.js";

export type GenerateNarrativeMode = "local" | "byok" | "off";

export type GenerateReportRequest = {
  repositoryPath: string;
  outputDirectory: string;
  consent: "local-scan";
  mode: GenerateNarrativeMode;
  provider?: NarrativeProvider;
  model?: string | null;
  analysisTier?: AnalysisTier;
  projectName?: string;
  providers?: ProviderId[];
  since?: string;
  until?: string;
  overwrite?: boolean;
  onProgress?: ScanProgressReporter;
};

export type GenerateReportResult = {
  snapshot: ProjectSnapshot;
  files: WrittenReportFiles;
  mode: GenerateNarrativeMode;
};

function byokAvailable(): boolean {
  return Boolean(
    process.env.BUILDSTORY_OPENROUTER_API_KEY?.trim()
    || process.env.BUILDSTORY_OPENAI_API_KEY?.trim()
    || process.env.BUILDSTORY_BYOK_API_KEY?.trim(),
  );
}

export function resolveGenerateMode(explicit?: GenerateNarrativeMode | "auto"): GenerateNarrativeMode {
  if (explicit && explicit !== "auto") return explicit;
  return byokAvailable() ? "byok" : "local";
}

export function defaultGenerateOutputDirectory(cwd = process.cwd()): string {
  return path.join(cwd, "buildstory");
}

function scanOptionsForGenerate(request: GenerateReportRequest): ScanOptions {
  const mode = request.mode;
  const analysisTier = request.analysisTier ?? "standard";
  const local = mode === "local";
  const byok = mode === "byok";
  const localCapability = local ? localCapabilityProfile() : null;
  const deep = analysisTier === "deep" && byok;
  const deepBudget = deep ? {
    maxExcerpts: DEEP_MAX_EXCERPTS,
    maxCharsPerExcerpt: DEEP_MAX_CHARS_PER_EXCERPT,
    maxTotalChars: DEEP_MAX_TOTAL_EXCERPT_BYTES,
    maxTotalBytes: DEEP_MAX_TOTAL_EXCERPT_BYTES,
    maxExcerptsPerSession: DEEP_MAX_EXCERPTS_PER_SESSION,
    maxAssistantDecisionsPerSession: DEEP_MAX_ASSISTANT_DECISIONS_PER_SESSION,
    policyVersion: "deep-evidence-v2" as const,
  } : undefined;
  const standardBudget = byok && !deep ? {
    maxExcerpts: CLOUD_STANDARD_MAX_EXCERPTS,
    maxCharsPerExcerpt: CLOUD_STANDARD_MAX_CHARS_PER_EXCERPT,
    maxTotalChars: CLOUD_STANDARD_MAX_TOTAL_EXCERPT_CHARS,
    maxExcerptsPerSession: CLOUD_STANDARD_MAX_EXCERPTS_PER_SESSION,
    maxAssistantDecisionsPerSession: CLOUD_STANDARD_MAX_ASSISTANT_DECISIONS_PER_SESSION,
  } : undefined;
  return {
    repositoryPath: request.repositoryPath,
    ...(request.projectName ? { projectName: request.projectName } : {}),
    consent: "local-scan",
    ...(request.providers ? { providers: request.providers } : {}),
    ...(request.since ? { since: request.since } : {}),
    ...(request.until ? { until: request.until } : {}),
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    ...(local || byok
      ? {
          narrative: { mode: "local" as const, model: request.model ?? null },
          ...(localCapability ? { narrativeEvidenceBudget: localCapability.evidenceBudget } : {}),
          ...(byok ? { narrativeEvidenceBudget: deepBudget ?? standardBudget ?? {} } : {}),
        }
      : { narrative: { mode: "off" as const, model: null } }),
    ...(local ? { narrativeGenerator: createOllamaNarrativeGenerator(request.model, localCapability ?? undefined) } : {}),
    ...(byok ? {
      narrativeGenerator: createByokNarrativeGenerator(
        request.model,
        request.provider === "openai" ? "openai" : "openrouter",
        analysisTier,
      ),
    } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
  };
}

export async function generateLocalReport(request: GenerateReportRequest): Promise<GenerateReportResult> {
  if (request.consent !== "local-scan") {
    throw new ScannerError("CONSENT_REQUIRED", "generate requires --consent local-scan before any AI session source is read.", 2);
  }
  let snapshot: ProjectSnapshot;
  try {
    snapshot = await buildProjectSnapshot(scanOptionsForGenerate(request));
  } catch (error) {
    if (error instanceof LocalNarrativeGenerationError && request.mode !== "off") {
      throw new ScannerError(
        "GENERATE_PROVIDER_UNAVAILABLE",
        `${error.message} Install Ollama for local mode, set BUILDSTORY_OPENROUTER_API_KEY or BUILDSTORY_OPENAI_API_KEY for BYOK, or pass --off for a metrics-only report. generate never sends excerpts to Buildstory.`,
        2,
      );
    }
    throw error;
  }
  request.onProgress?.({ stage: "validating-story-pack", state: "complete", message: "Writing local report files." });
  const files = await writeLocalReportFiles(snapshot, request.outputDirectory);
  return { snapshot, files, mode: request.mode };
}

import os from "node:os";
import type { ExcerptBudget } from "../sources/narrative-evidence.js";

export type LocalCapabilityProfile = {
  id: "safe" | "balanced" | "enhanced";
  label: string;
  contextTokens: number;
  evidenceBudget: ExcerptBudget;
  memoryGiB: number;
  logicalCpus: number;
};

export function localCapabilityProfile(system: { totalMemoryBytes: number; logicalCpus: number } = {
  totalMemoryBytes: os.totalmem(),
  logicalCpus: os.cpus().length,
}): LocalCapabilityProfile {
  const memoryGiB = Math.max(0, Math.round((system.totalMemoryBytes / 1024 ** 3) * 10) / 10);
  const logicalCpus = Math.max(1, Math.trunc(system.logicalCpus));

  if (memoryGiB >= 24 && logicalCpus >= 8) {
    return {
      id: "enhanced",
      label: "enhanced local",
      contextTokens: 32_768,
      evidenceBudget: {
        maxExcerpts: 80,
        maxCharsPerExcerpt: 900,
        maxTotalChars: 60_000,
        maxExcerptsPerSession: 10,
        maxAssistantDecisionsPerSession: 5,
      },
      memoryGiB,
      logicalCpus,
    };
  }

  if (memoryGiB >= 16 && logicalCpus >= 4) {
    return {
      id: "balanced",
      label: "balanced local",
      contextTokens: 24_576,
      evidenceBudget: {
        maxExcerpts: 64,
        maxCharsPerExcerpt: 800,
        maxTotalChars: 48_000,
        maxExcerptsPerSession: 8,
        maxAssistantDecisionsPerSession: 4,
      },
      memoryGiB,
      logicalCpus,
    };
  }

  return {
    id: "safe",
    label: "safe local",
    contextTokens: 16_384,
    evidenceBudget: {
      maxExcerpts: 40,
      maxCharsPerExcerpt: 600,
      maxTotalChars: 20_000,
      maxExcerptsPerSession: 6,
      maxAssistantDecisionsPerSession: 3,
    },
    memoryGiB,
    logicalCpus,
  };
}

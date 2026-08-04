import path from "node:path";
import { isPathWithin } from "../repository.js";
import type { SessionSummary } from "../contract.js";

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

/**
 * Classifies a session's working directory relative to the selected
 * repository root. Returns `null` when the working directory is outside the
 * repository, which callers treat as "not scoped to this scan".
 */
export function relationToRepository(
  repositoryRoot: string,
  cwd: string,
): SessionSummary["workingDirectoryRelation"] | null {
  if (!path.isAbsolute(cwd)) return null;
  const root = normalizeForComparison(repositoryRoot);
  const candidate = normalizeForComparison(cwd);
  if (!isPathWithin(root, candidate)) return null;
  return root === candidate ? "repository-root" : "subdirectory";
}

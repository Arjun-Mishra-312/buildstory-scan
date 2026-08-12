import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GitAggregateMetrics, QualityWarning, RepositoryIdentity, TimeWindow } from "./contract.js";
import { sha256 } from "./canonical-json.js";
import { ScannerError } from "./errors.js";
import { cleanIdentifier } from "./redaction.js";
import type { Redactor } from "./redaction.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface RepositoryInspection {
  rootPath: string;
  identity: RepositoryIdentity;
  headTimestamp: string | null;
  commands: Set<string>;
}

interface CanonicalRemote {
  host: string;
  path: string;
}

async function runGit(
  repositoryPath: string,
  args: string[],
  options: { optional?: boolean } = {},
): Promise<string | null> {
  try {
    const result = await execFileAsync(
      "git",
      ["--no-optional-locks", "-C", repositoryPath, ...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
          LANG: "C",
        },
      },
    );
    return result.stdout;
  } catch {
    if (options.optional) return null;
    throw new ScannerError(
      "GIT_INSPECTION_FAILED",
      "The selected directory is not a readable Git worktree, or Git is unavailable.",
    );
  }
}

function normalizedLocalIdentity(value: string): string {
  const normalized = path.normalize(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function canonicalizeRemote(remote: string): CanonicalRemote | null {
  const trimmed = remote.trim();
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
  if (scpLike?.[1] && scpLike[2] && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return {
      host: scpLike[1].toLocaleLowerCase("en-US"),
      path: scpLike[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, ""),
    };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:" || !parsed.hostname) return null;
    return {
      host: parsed.hostname.toLocaleLowerCase("en-US"),
      path: parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, ""),
    };
  } catch {
    return null;
  }
}

function parseIsoDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function inspectRepository(selectedPath: string, redactor: Redactor, projectName?: string): Promise<RepositoryInspection> {
  let selectedRealPath: string;
  try {
    const stat = await lstat(selectedPath);
    if (!stat.isDirectory()) {
      throw new ScannerError("REPOSITORY_NOT_DIRECTORY", "The selected repository path must be a directory.");
    }
    selectedRealPath = await realpath(selectedPath);
  } catch (error) {
    if (error instanceof ScannerError) throw error;
    throw new ScannerError("REPOSITORY_UNREADABLE", "The selected repository directory cannot be read.");
  }

  const topLevelOutput = await runGit(selectedRealPath, ["rev-parse", "--show-toplevel"]);
  const rawRoot = topLevelOutput?.trim();
  if (!rawRoot) {
    throw new ScannerError("GIT_WORKTREE_REQUIRED", "The selected path must be inside a non-bare Git worktree.");
  }
  const rootPath = await realpath(rawRoot);
  const commands = new Set<string>(["git-rev-parse"]);

  const [headOutput, branchOutput, bareOutput, remoteOutput, headTimeOutput] = await Promise.all([
    runGit(rootPath, ["rev-parse", "--verify", "HEAD"], { optional: true }),
    runGit(rootPath, ["branch", "--show-current"], { optional: true }),
    runGit(rootPath, ["rev-parse", "--is-bare-repository"]),
    runGit(rootPath, ["config", "--get", "remote.origin.url"], { optional: true }),
    runGit(rootPath, ["show", "-s", "--format=%cI", "HEAD"], { optional: true }),
  ]);
  commands.add("git-config");
  commands.add("git-show");

  const headCommitCandidate = headOutput?.trim().toLocaleLowerCase("en-US") ?? "";
  const headCommit = /^[a-f0-9]{40,64}$/.test(headCommitCandidate) ? headCommitCandidate : null;
  const branchCandidate = branchOutput?.trim() ?? "";
  const branch = branchCandidate ? cleanIdentifier(branchCandidate, 256) : null;
  const canonicalRemote = remoteOutput ? canonicalizeRemote(remoteOutput) : null;
  const fingerprintBasis = canonicalRemote ? "canonical-remote" : "local-path";
  const fingerprintInput = canonicalRemote
    ? `${canonicalRemote.host}/${canonicalRemote.path}`
    : normalizedLocalIdentity(rootPath);

  const remote = canonicalRemote
    ? {
        repositoryPathHash: sha256(canonicalRemote.path),
      }
    : null;

  return {
    rootPath,
    identity: {
      fingerprint: sha256(fingerprintInput),
      fingerprintBasis,
       displayName: cleanIdentifier(projectName ?? path.basename(rootPath), 160),
      vcs: "git",
      rootPathIncluded: false,
      headCommit,
      branch,
      detachedHead: headCommit !== null && branch === null,
      remote,
      bare: bareOutput?.trim() === "true",
    },
    headTimestamp: parseIsoDate(headTimeOutput),
    commands,
  };
}

function nonNegativeInteger(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseWorkingTreeStatus(output: string): GitAggregateMetrics["workingTree"] {
  const records = output.split("\0");
  let stagedEntries = 0;
  let modifiedEntries = 0;
  let untrackedEntries = 0;
  let conflictedEntries = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const status = record.slice(0, 2);
    if (status === "??") {
      untrackedEntries += 1;
      continue;
    }
    if (status === "!!") continue;
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status)) {
      conflictedEntries += 1;
    }
    if (status[0] !== " ") stagedEntries += 1;
    if (status[1] !== " ") modifiedEntries += 1;
    if (status[0] === "R" || status[0] === "C") index += 1;
  }

  return {
    isDirty: stagedEntries + modifiedEntries + untrackedEntries + conflictedEntries > 0,
    stagedEntries,
    modifiedEntries,
    untrackedEntries,
    conflictedEntries,
  };
}

function parseShortStat(output: string): Pick<GitAggregateMetrics, "fileTouches" | "insertions" | "deletions"> {
  let fileTouches = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of output.split(/\r?\n/)) {
    const files = /(\d+) files? changed/.exec(line)?.[1];
    const added = /(\d+) insertions?\(\+\)/.exec(line)?.[1];
    const removed = /(\d+) deletions?\(-\)/.exec(line)?.[1];
    fileTouches = Math.min(Number.MAX_SAFE_INTEGER, fileTouches + nonNegativeInteger(files));
    insertions = Math.min(Number.MAX_SAFE_INTEGER, insertions + nonNegativeInteger(added));
    deletions = Math.min(Number.MAX_SAFE_INTEGER, deletions + nonNegativeInteger(removed));
  }
  return { fileTouches, insertions, deletions };
}

export function parseGitAiStats(output: string): NonNullable<GitAggregateMetrics["aiAttribution"]> {
  const raw = JSON.parse(output) as { human_additions?: unknown; ai_additions?: unknown; ai_accepted?: unknown; tool_model_breakdown?: Record<string, { ai_additions?: unknown; ai_accepted?: unknown }> };
  const count = (value: unknown) => nonNegativeInteger(typeof value === "number" || typeof value === "string" ? String(value) : undefined);
  const toolModels = Object.entries(raw.tool_model_breakdown ?? {}).map(([key, values]) => {
    const separator = key.indexOf("/");
    return { tool: cleanIdentifier(separator >= 0 ? key.slice(0, separator) : key, 80), model: cleanIdentifier(separator >= 0 ? key.slice(separator + 1) : "unknown", 120), aiAdditions: count(values.ai_additions), aiAccepted: count(values.ai_accepted) };
  }).sort((left, right) => left.tool.localeCompare(right.tool) || left.model.localeCompare(right.model));
  return { source: "git-ai", optIn: true, humanAdditions: count(raw.human_additions), aiAdditions: count(raw.ai_additions), aiAccepted: count(raw.ai_accepted), toolModels };
}

export async function collectGitMetrics(
  repository: RepositoryInspection,
  window: TimeWindow,
  includeGitAiAttribution = false,
): Promise<{ metrics: GitAggregateMetrics; warnings: QualityWarning[] }> {
  const warnings: QualityWarning[] = [];
  const range = [`--since=${window.start}`, `--until=${window.end}`, "HEAD"];

  const statusOutput = await runGit(
    repository.rootPath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    { optional: true },
  );
  repository.commands.add("git-status");
  const workingTree = statusOutput === null
    ? { isDirty: false, stagedEntries: 0, modifiedEntries: 0, untrackedEntries: 0, conflictedEntries: 0 }
    : parseWorkingTreeStatus(statusOutput);
  if (statusOutput === null) {
    warnings.push({
      code: "GIT_STATUS_UNAVAILABLE",
      severity: "warning",
      message: "Working-tree status could not be read; status aggregates are zero.",
    });
  }

  if (repository.identity.headCommit === null) {
    warnings.push({
      code: "GIT_HISTORY_UNAVAILABLE",
      severity: "info",
      message: "The repository has no readable HEAD commit; history aggregates are zero.",
    });
    return {
      metrics: { commits: 0, mergeCommits: 0, contributors: 0, fileTouches: 0, insertions: 0, deletions: 0, workingTree },
      warnings,
    };
  }

  const [commitOutput, mergeOutput, authorOutput, statOutput] = await Promise.all([
    runGit(repository.rootPath, ["rev-list", "--count", ...range], { optional: true }),
    runGit(repository.rootPath, ["rev-list", "--count", "--merges", ...range], { optional: true }),
    runGit(repository.rootPath, ["log", `--since=${window.start}`, `--until=${window.end}`, "--format=%ae", "HEAD"], { optional: true }),
    runGit(repository.rootPath, ["log", `--since=${window.start}`, `--until=${window.end}`, "--format=", "--shortstat", "HEAD"], { optional: true }),
  ]);
  repository.commands.add("git-rev-list");
  repository.commands.add("git-log-shortstat");

  if ([commitOutput, mergeOutput, authorOutput, statOutput].some((value) => value === null)) {
    warnings.push({
      code: "GIT_HISTORY_UNAVAILABLE",
      severity: "warning",
      message: "Some Git history aggregates could not be read and may be incomplete.",
    });
  }

  const contributorDigests = new Set(
    (authorOutput ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim().toLocaleLowerCase("en-US"))
      .filter(Boolean)
      .map((value) => sha256(value)),
  );
  const shortStat = parseShortStat(statOutput ?? "");
  let aiAttribution: GitAggregateMetrics["aiAttribution"];
  if (includeGitAiAttribution) {
    try {
      const result = await execFileAsync("git-ai", ["stats", "--json"], { cwd: repository.rootPath, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      aiAttribution = parseGitAiStats(result.stdout);
      repository.commands.add("git-ai-stats");
    } catch {
      warnings.push({ code: "GIT_AI_ATTRIBUTION_UNAVAILABLE", severity: "info", message: "Git AI attribution was requested but content-free stats were unavailable." });
    }
  }

  return {
    metrics: {
      commits: nonNegativeInteger(commitOutput?.trim()),
      mergeCommits: nonNegativeInteger(mergeOutput?.trim()),
      contributors: contributorDigests.size,
      ...shortStat,
      ...(aiAttribution ? { aiAttribution } : {}),
      workingTree,
    },
    warnings,
  };
}

export function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

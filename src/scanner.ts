import type {
  EvidenceReference,
  Milestone,
  ProjectSnapshot,
  QualityWarning,
  TimeWindow,
  TokenUsage,
  UsageSummary,
} from "./contract.js";
import {
  CONSENT_STATEMENT_VERSION,
  PROJECT_SNAPSHOT_SCHEMA_VERSION,
  SCANNER_NAME,
  SCANNER_VERSION,
} from "./contract.js";
import { canonicalJson, compareStrings, sha256, shortHash } from "./canonical-json.js";
import { ScannerError } from "./errors.js";
import { collectGitMetrics, inspectRepository } from "./repository.js";
import { detectKnownSecrets, Redactor } from "./redaction.js";
import { detectPrivateLocations } from "./privacy-boundary.js";
import { CodexSessionAdapter } from "./sources/codex.js";
import type { ProviderDiscoveryResult, ProviderSession, SessionProviderAdapter } from "./sources/types.js";
import { validateProjectSnapshot } from "./validation.js";

const DEFAULT_LOOKBACK_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const UNIX_EPOCH = "1970-01-01T00:00:00.000Z";

export interface ScanOptions {
  repositoryPath: string;
  consent: "local-scan";
  since?: string;
  until?: string;
  codexHome?: string;
  adapters?: SessionProviderAdapter[];
}

export interface RepositoryInspectReport {
  schemaVersion: "repository-inspect-1.0.0";
  collectionMode: "local-read-only";
  repository: ProjectSnapshot["repository"];
  sessionSourcesRead: false;
  networkAccessed: false;
}

function parseExplicitDate(label: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ScannerError("INVALID_TIME_WINDOW", `${label} must be an ISO 8601 date-time.`);
  }
  return parsed.toISOString();
}

function maximum(values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => value !== null).sort(compareStrings);
  return present.at(-1) ?? null;
}

function deriveTimeWindow(
  options: Pick<ScanOptions, "since" | "until">,
  sessions: ProviderSession[],
  headTimestamp: string | null,
): TimeWindow {
  const explicitStart = parseExplicitDate("--since", options.since);
  const explicitEnd = parseExplicitDate("--until", options.until);
  const latestSession = maximum(sessions.map((session) => session.summary.endedAt));
  const inferredEnd = maximum([latestSession, headTimestamp]) ?? UNIX_EPOCH;
  const end = explicitEnd ?? inferredEnd;
  let start: string;
  let startBasis: TimeWindow["startBasis"];

  if (explicitStart) {
    start = explicitStart;
    startBasis = "explicit";
  } else if (!explicitEnd && latestSession === null && headTimestamp === null) {
    start = UNIX_EPOCH;
    startBasis = "empty-repository";
  } else {
    start = new Date(new Date(end).getTime() - DEFAULT_LOOKBACK_MILLISECONDS).toISOString();
    startBasis = "default-lookback";
  }

  if (start > end) {
    throw new ScannerError(
      "INVALID_TIME_WINDOW",
      "The effective --since value is later than --until or the latest observed activity; provide an explicit --until.",
    );
  }
  return {
    start,
    end,
    timezone: "UTC",
    startBasis,
    endBasis: explicitEnd
      ? "explicit"
      : latestSession !== null && latestSession === inferredEnd
        ? "latest-session"
        : headTimestamp !== null
          ? "head-commit"
          : "unix-epoch",
  };
}

function intersectsWindow(session: ProviderSession, window: TimeWindow): boolean {
  return session.summary.endedAt >= window.start && session.summary.startedAt <= window.end;
}

function sumTokens(values: Array<TokenUsage | null>): TokenUsage | null {
  const present = values.filter((value): value is TokenUsage => value !== null);
  if (present.length === 0) return null;
  return present.reduce<TokenUsage>(
    (total, value) => ({
      inputTokens: safeSum(total.inputTokens, value.inputTokens),
      cachedInputTokens: safeSum(total.cachedInputTokens, value.cachedInputTokens),
      outputTokens: safeSum(total.outputTokens, value.outputTokens),
      reasoningOutputTokens: safeSum(total.reasoningOutputTokens, value.reasoningOutputTokens),
      totalTokens: safeSum(total.totalTokens, value.totalTokens),
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
  );
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function aggregateUsage(sessions: ProviderSession[]): UsageSummary {
  const tools = new Map<string, { callCount: number; sessions: Set<string> }>();
  const models = new Map<string, { provider: string; turnCount: number; sessions: Set<string> }>();
  for (const session of sessions) {
    for (const [name, count] of session.toolCounts) {
      const aggregate = tools.get(name) ?? { callCount: 0, sessions: new Set<string>() };
      aggregate.callCount += count;
      aggregate.sessions.add(session.summary.sessionRef);
      tools.set(name, aggregate);
    }
    for (const [name, model] of session.modelCounts) {
      const key = `${model.provider}\0${name}`;
      const aggregate = models.get(key) ?? { provider: model.provider, turnCount: 0, sessions: new Set<string>() };
      aggregate.turnCount += model.turns;
      aggregate.sessions.add(session.summary.sessionRef);
      models.set(key, aggregate);
    }
  }

  return {
    tools: [...tools.entries()]
      .map(([name, value]) => ({ name, callCount: value.callCount, sessionCount: value.sessions.size }))
      .sort((left, right) => compareStrings(left.name, right.name)),
    models: [...models.entries()]
      .map(([key, value]) => ({
        provider: value.provider,
        name: key.slice(key.indexOf("\0") + 1),
        turnCount: value.turnCount,
        sessionCount: value.sessions.size,
      }))
      .sort((left, right) => compareStrings(left.provider, right.provider) || compareStrings(left.name, right.name)),
    totalToolCalls: sessions.reduce((sum, session) => sum + session.summary.toolCalls, 0),
    totalTurns: sessions.reduce((sum, session) => sum + session.summary.turns, 0),
    tokenUsage: sumTokens(sessions.map((session) => session.summary.tokenUsage)),
  };
}

function createSessionMilestone(session: ProviderSession): Milestone {
  const evidenceRefs = session.evidence.map((item) => item.evidenceId).sort(compareStrings);
  return {
    milestoneId: `mil_${shortHash(`session-activity\0${session.summary.sessionRef}`, 20)}`,
    kind: "session-activity",
    title: "Codex session activity",
    summary: session.summary.summary,
    occurredAt: session.summary.endedAt,
    evidenceRefs,
  };
}

function deduplicateWarnings(warnings: QualityWarning[], includedSessionRefs: Set<string>): QualityWarning[] {
  const unique = new Map<string, QualityWarning>();
  for (const item of warnings) {
    if (item.sessionRef && !includedSessionRefs.has(item.sessionRef)) continue;
    const key = `${item.code}\0${item.severity}\0${item.message}\0${item.sessionRef ?? ""}`;
    unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) =>
    compareStrings(left.code, right.code) || compareStrings(left.sessionRef ?? "", right.sessionRef ?? ""),
  );
}

function qualityLevel(warnings: QualityWarning[], skippedFiles: number): ProjectSnapshot["quality"]["level"] {
  const warningCount = warnings.filter((item) => item.severity === "warning").length;
  if (warningCount === 0 && skippedFiles === 0) return "high";
  if (warningCount <= 5 && skippedFiles <= 5) return "medium";
  return "low";
}

export async function inspectSelectedRepository(repositoryPath: string): Promise<RepositoryInspectReport> {
  const redactor = new Redactor();
  const inspection = await inspectRepository(repositoryPath, redactor);
  return {
    schemaVersion: "repository-inspect-1.0.0",
    collectionMode: "local-read-only",
    repository: inspection.identity,
    sessionSourcesRead: false,
    networkAccessed: false,
  };
}

export async function buildProjectSnapshot(options: ScanOptions): Promise<ProjectSnapshot> {
  if (options.consent !== "local-scan") {
    throw new ScannerError("CONSENT_REQUIRED", "Explicit local-scan consent is required before reading AI session sources.");
  }

  const redactor = new Redactor();
  const repository = await inspectRepository(options.repositoryPath, redactor);
  const adapters = options.adapters ?? [new CodexSessionAdapter(options.codexHome ? { codexHome: options.codexHome } : {})];
  if (adapters.length !== 1 || adapters[0]?.provider !== "codex") {
    throw new ScannerError("UNSUPPORTED_PROVIDER", "ProjectSnapshot 1.0.0 supports the Codex provider only.");
  }

  const discoveries = await Promise.all(
    adapters.map((adapter) => adapter.discover({
      repositoryRoot: repository.rootPath,
      repositoryFingerprint: repository.identity.fingerprint,
      redactor,
    })),
  );
  const allSessions = discoveries.flatMap((result) => result.sessions);
  const timeWindow = deriveTimeWindow(options, allSessions, repository.headTimestamp);
  const includedSessions = allSessions.filter((session) => intersectsWindow(session, timeWindow));
  const includedSessionRefs = new Set(includedSessions.map((session) => session.summary.sessionRef));
  const gitResult = await collectGitMetrics(repository, timeWindow);
  const usage = aggregateUsage(includedSessions);

  const evidence: EvidenceReference[] = includedSessions.flatMap((session) => session.evidence);
  const milestones = includedSessions.map(createSessionMilestone);
  if (gitResult.metrics.commits > 0) {
    const seed = canonicalJson({
      repository: repository.identity.fingerprint,
      window: timeWindow,
      metrics: gitResult.metrics,
    });
    const gitEvidence: EvidenceReference = {
      evidenceId: `ev_${shortHash(`git-aggregate\0${seed}`, 20)}`,
      source: "git",
      kind: "git-aggregate",
      observedAt: timeWindow.end,
      digest: sha256(seed),
    };
    evidence.push(gitEvidence);
    milestones.push({
      milestoneId: `mil_${shortHash(`repository-activity\0${gitEvidence.evidenceId}`, 20)}`,
      kind: "repository-activity",
      title: "Repository activity",
      summary: `${gitResult.metrics.commits} commit${gitResult.metrics.commits === 1 ? "" : "s"} observed in the selected time window.`,
      occurredAt: timeWindow.end,
      evidenceRefs: [gitEvidence.evidenceId],
    });
  }

  const discoveryWarnings = discoveries.flatMap((result) => result.warnings);
  const allWarnings = deduplicateWarnings([...discoveryWarnings, ...gitResult.warnings], includedSessionRefs);
  const sourceFilesSkipped = discoveries.reduce((sum, result) => sum + result.filesSkipped, 0);

  const redaction = redactor.summary(true);
  const snapshotWithoutId: Omit<ProjectSnapshot, "scanId"> = {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: timeWindow.end,
    sourceSelection: {
      providers: discoveries.map((result: ProviderDiscoveryResult) => ({
        provider: result.provider,
        selected: true,
        repositoryScoped: true,
        rootsConsidered: result.rootsConsidered,
        filesDiscovered: result.filesDiscovered,
        sessionsMatched: result.sessionsMatched,
        sessionsIncluded: result.sessions.filter((session) => includedSessionRefs.has(session.summary.sessionRef)).length,
      })),
      consent: {
        mode: "explicit-cli",
        statementVersion: CONSENT_STATEMENT_VERSION,
        approvedActions: [
          "read-repository-metadata",
          "read-selected-local-session-metadata",
          "write-local-snapshot",
        ],
        deniedActions: ["network-upload"],
      },
    },
    repository: repository.identity,
    timeWindow,
    sessions: includedSessions.map((session) => session.summary),
    usage,
    git: gitResult.metrics,
    milestones: milestones.sort((left, right) => compareStrings(left.occurredAt, right.occurredAt) || compareStrings(left.milestoneId, right.milestoneId)),
    evidence: evidence.sort((left, right) => compareStrings(left.evidenceId, right.evidenceId)),
    redaction,
    provenance: {
      scanner: { name: SCANNER_NAME, version: SCANNER_VERSION },
      collectionMode: "local-read-only",
      sessionFormat: "codex-jsonl",
      deterministicSerialization: "lexicographic-json",
      repositoryCommands: [...repository.commands].sort(compareStrings),
      sourceFilesConsidered: discoveries.reduce((sum, result) => sum + result.filesDiscovered, 0),
      sourceFilesParsed: discoveries.reduce((sum, result) => sum + result.filesParsed, 0),
      sourceFilesSkipped,
    },
    quality: {
      level: qualityLevel(allWarnings, sourceFilesSkipped),
      warningCount: allWarnings.length,
      warnings: allWarnings,
      assumptions: [
        "Codex sessions are repository-scoped from session or turn-context working-directory metadata.",
        "User-turn and assistant-message counts prefer event records and fall back to response records to avoid double counting.",
        "When no explicit start is supplied, the scanner uses a deterministic 30-day lookback from the effective end.",
        "Git fileTouches is the sum of per-commit changed-file counts and is not a unique-file count.",
      ],
    },
  };

  const scanId = `scan_${shortHash(canonicalJson(snapshotWithoutId), 24)}` as const;
  const snapshot: ProjectSnapshot = { ...snapshotWithoutId, scanId };
  const leakedCategories = detectKnownSecrets(canonicalJson(snapshot));
  if (leakedCategories.length > 0) {
    throw new ScannerError(
      "FINAL_REDACTION_CHECK_FAILED",
      "The fail-closed output check found a possible secret. No snapshot was emitted.",
    );
  }
  if (detectPrivateLocations(snapshot).length > 0) {
    throw new ScannerError(
      "FINAL_LOCATION_CHECK_FAILED",
      "The fail-closed output check found a possible URL, host, or path. No snapshot was emitted.",
    );
  }
  validateProjectSnapshot(snapshot);
  return snapshot;
}

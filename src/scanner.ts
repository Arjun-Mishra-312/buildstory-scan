import type {
  EvidenceReference,
  Milestone,
  NarrativeEvidenceBundle,
  GeneratedNarrative,
  ProjectSnapshot,
  ProviderId,
  ProviderSelection,
  QualityWarning,
  TimeWindow,
  TokenUsage,
  UsageSummary,
} from "./contract.js";
import {
  CONSENT_STATEMENT_VERSION,
  NARRATIVE_EVIDENCE_BUNDLE_VERSION,
  NARRATIVE_EVIDENCE_CONSENT_VERSION,
  PROJECT_SNAPSHOT_SCHEMA_VERSION,
  SCANNER_NAME,
  SCANNER_VERSION,
} from "./contract.js";
import { canonicalJson, compareStrings, sha256, shortHash } from "./canonical-json.js";
import { ScannerError } from "./errors.js";
import { collectGitMetrics, inspectRepository } from "./repository.js";
import { detectKnownSecrets, Redactor } from "./redaction.js";
import { detectPrivateLocations } from "./privacy-boundary.js";
import {
  DEFAULT_MAX_CHARS_PER_EXCERPT,
  DEFAULT_MAX_EXCERPTS,
  DEFAULT_MAX_TOTAL_EXCERPT_CHARS,
  selectNarrativeEvidence,
} from "./sources/narrative-evidence.js";
import { createAdapters, defaultProviderIds, isRegisteredProvider } from "./sources/registry.js";
import type { ProviderDiscoveryResult, ProviderSession, RawExcerptCandidate, SessionProviderAdapter } from "./sources/types.js";
import { validateProjectSnapshot } from "./validation.js";
import { computeBuilderProfile, defaultProfileNarrative } from "./insights/profile.js";
import type { LocalNarrativeGenerator } from "./narrative/local.js";
import type { ScanProgressReporter } from "./progress.js";
import { createDefaultStoryPack, sanitizeStoryPack, sectionsFromStoryPack } from "./narrative/story-pack.js";
import { estimateSessionCostMicroUsd, SESSION_PRICING_TABLE_VERSION } from "./session-pricing.js";

const DEFAULT_LOOKBACK_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const UNIX_EPOCH = "1970-01-01T00:00:00.000Z";

export interface ScanOptions {
  repositoryPath: string;
  projectName?: string;
  consent: "local-scan";
  since?: string;
  until?: string;
  /** Optional local offset used to label peak-hour analysis without collecting a location. */
  utcOffsetMinutes?: number;
  /** Providers to scan. Defaults to every provider whose adapter declares metadata support. */
  providers?: ProviderId[];
  codexHome?: string;
  claudeCodeHome?: string;
  antigravityHome?: string;
  cursorHome?: string;
  adapters?: SessionProviderAdapter[];
  /**
   * Opt-in narrative-evidence excerpt extraction. Requires its own
   * separately-consented flow (CLI --with-evidence plus a typed --review
   * confirmation) - never enabled implicitly by a plain scan.
   */
  narrativeEvidence?: {
    maxExcerpts?: number;
    maxCharsPerExcerpt?: number;
    maxTotalChars?: number;
  };
  /** Explicit generation mode. Absent means cloud for legacy evidence callers, otherwise off. */
  narrative?: {
    mode: "local" | "cloud" | "off";
    model?: string | null;
  };
  /** Injected so tests and alternative local runtimes never need a model or network. */
  narrativeGenerator?: LocalNarrativeGenerator;
  /** Content-free lifecycle events for CLI/UI progress rendering. */
  onProgress?: ScanProgressReporter;
}

function reportProgress(options: Pick<ScanOptions, "onProgress">, event: Parameters<NonNullable<ScanOptions["onProgress"]>>[0]): void {
  options.onProgress?.(event);
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
  options: Pick<ScanOptions, "since" | "until" | "utcOffsetMinutes">,
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
  if (options.utcOffsetMinutes !== undefined &&
    (!Number.isSafeInteger(options.utcOffsetMinutes) || options.utcOffsetMinutes < -840 || options.utcOffsetMinutes > 840)) {
    throw new ScannerError("INVALID_TIME_WINDOW", "utcOffsetMinutes must be an integer between -840 and 840.");
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
    ...(options.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: options.utcOffsetMinutes } : {}),
  };
}

function intersectsWindow(session: ProviderSession, window: TimeWindow): boolean {
  return session.summary.endedAt >= window.start && session.summary.startedAt <= window.end;
}

const OPTIONAL_TOKEN_FIELDS = [
  "cacheCreationInputTokens",
  "cacheCreation1hInputTokens",
  "cacheCreation5mInputTokens",
  "cacheReadInputTokens",
] as const satisfies ReadonlyArray<keyof TokenUsage>;

function sumTokens(values: Array<TokenUsage | null>): TokenUsage | null {
  const present = values.filter((value): value is TokenUsage => value !== null);
  if (present.length === 0) return null;
  const totals: { -readonly [K in keyof TokenUsage]-?: number } = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const seenOptional = new Set<keyof TokenUsage>();
  for (const value of present) {
    totals.inputTokens = safeSum(totals.inputTokens, value.inputTokens);
    totals.cachedInputTokens = safeSum(totals.cachedInputTokens, value.cachedInputTokens);
    totals.outputTokens = safeSum(totals.outputTokens, value.outputTokens);
    totals.reasoningOutputTokens = safeSum(totals.reasoningOutputTokens, value.reasoningOutputTokens);
    totals.totalTokens = safeSum(totals.totalTokens, value.totalTokens);
    for (const field of OPTIONAL_TOKEN_FIELDS) {
      const fieldValue = value[field];
      if (fieldValue === undefined) continue;
      seenOptional.add(field);
      totals[field] = safeSum(totals[field], fieldValue);
    }
  }

  const result: TokenUsage = {
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    outputTokens: totals.outputTokens,
    reasoningOutputTokens: totals.reasoningOutputTokens,
    totalTokens: totals.totalTokens,
  };
  for (const field of OPTIONAL_TOKEN_FIELDS) {
    if (seenOptional.has(field)) result[field] = totals[field];
  }
  return result;
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function aggregateUsage(sessions: ProviderSession[]): UsageSummary {
  const tools = new Map<string, { callCount: number; sessions: Set<string> }>();
  const models = new Map<string, { provider: string; turnCount: number; sessions: Set<string>; tokenUsage: TokenUsage[] }>();
  for (const session of sessions) {
    for (const [name, count] of session.toolCounts) {
      const aggregate = tools.get(name) ?? { callCount: 0, sessions: new Set<string>() };
      aggregate.callCount += count;
      aggregate.sessions.add(session.summary.sessionRef);
      tools.set(name, aggregate);
    }
    for (const [name, model] of session.modelCounts) {
      const key = `${model.provider}\0${name}`;
      const aggregate = models.get(key) ?? { provider: model.provider, turnCount: 0, sessions: new Set<string>(), tokenUsage: [] };
      aggregate.turnCount += model.turns;
      aggregate.sessions.add(session.summary.sessionRef);
      if (model.tokenUsage) aggregate.tokenUsage.push(model.tokenUsage);
      models.set(key, aggregate);
    }
  }

  let totalMicroUsd: number | null = null;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const modelEntries = [...models.entries()].map(([key, value]) => {
    const name = key.slice(key.indexOf("\0") + 1);
    const tokenUsage = sumTokens(value.tokenUsage);
    const costMicroUsd = tokenUsage ? estimateSessionCostMicroUsd(name, tokenUsage) : null;
    if (tokenUsage) {
      if (costMicroUsd === null) {
        unpricedTokens += tokenUsage.totalTokens;
      } else {
        pricedTokens += tokenUsage.totalTokens;
        totalMicroUsd = (totalMicroUsd ?? 0) + costMicroUsd;
      }
    }
    return {
      provider: value.provider,
      name,
      turnCount: value.turnCount,
      sessionCount: value.sessions.size,
      tokenUsage,
      costMicroUsd,
    };
  });

  return {
    tools: [...tools.entries()]
      .map(([name, value]) => ({ name, callCount: value.callCount, sessionCount: value.sessions.size }))
      .sort((left, right) => compareStrings(left.name, right.name)),
    models: modelEntries.sort((left, right) => compareStrings(left.provider, right.provider) || compareStrings(left.name, right.name)),
    totalToolCalls: sessions.reduce((sum, session) => sum + session.summary.toolCalls, 0),
    totalTurns: sessions.reduce((sum, session) => sum + session.summary.turns, 0),
    tokenUsage: sumTokens(sessions.map((session) => session.summary.tokenUsage)),
    cost: { totalMicroUsd, pricedTokens, unpricedTokens, pricingTableVersion: SESSION_PRICING_TABLE_VERSION },
  };
}

/** Human-facing label for a provider id. Shared verbatim with the web app's deterministic-text check. */
export function providerLabel(provider: ProviderId): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "gemini-antigravity") return "Gemini Antigravity";
  if (provider === "cursor") return "Cursor";
  return "Codex";
}

const ROOT_UNAVAILABLE_WARNING_CODES = new Set([
  "CODEX_ROOT_UNAVAILABLE",
  "CLAUDE_CODE_ROOT_UNAVAILABLE",
  "GEMINI_ANTIGRAVITY_ROOT_UNAVAILABLE",
  "CURSOR_ROOT_UNAVAILABLE",
]);

/** Content-free discovery outcome for one provider, surfaced in sourceSelection.providers[].diagnostic. */
function providerDiagnostic(adapter: SessionProviderAdapter, result: ProviderDiscoveryResult): NonNullable<ProviderSelection["diagnostic"]> {
  if (!adapter.descriptor.capabilities.metadata) return "format-unsupported";
  if (result.warnings.some((item) => ROOT_UNAVAILABLE_WARNING_CODES.has(item.code))) return "not-installed";
  if (result.filesDiscovered === 0) return "no-project-directory";
  if (result.sessionsMatched === 0) return "no-matching-sessions";
  return "scanned";
}

/**
 * Assumption strings the web app's upload boundary re-derives and compares
 * byte-for-byte, so a scanner-generated snapshot can be told apart from
 * hand-written text. Generic assumptions always apply; provider-specific
 * ones are appended only when that provider actually contributed sessions,
 * in `providerIds` order (which is always sorted).
 */
export function assumptionsForProviders(providerIds: ProviderId[]): string[] {
  const assumptions = [
    "When no explicit start is supplied, the scanner uses a deterministic 30-day lookback from the effective end.",
    "Git fileTouches is the sum of per-commit changed-file counts and is not a unique-file count.",
    "Estimated cost is priced from a static, versioned table of known model families; a model not in that table shows tokens only, never a guessed price.",
  ];
  if (providerIds.includes("codex")) {
    assumptions.push(
      "Codex sessions are repository-scoped from session or turn-context working-directory metadata.",
      "User-turn and assistant-message counts prefer event records and fall back to response records to avoid double counting.",
      "Codex token usage is a cumulative session-wide snapshot, not tied to a specific model event; a session that switches models attributes its tokens and estimated cost to whichever model had the most turns.",
    );
  }
  if (providerIds.includes("cursor")) {
    assumptions.push(
      "Cursor sessions are repository-scoped from each workspace's workspace.json folder path.",
      "Cursor's local conversation format is unverified; session content metrics are best-effort and may undercount or miss activity.",
    );
  }
  if (providerIds.includes("claude-code")) {
    assumptions.push(
      "Claude Code sessions are repository-scoped from the working directory recorded on transcript lines.",
      "Claude Code turn counts exclude tool-result continuation lines; only author-authored messages are counted as turns.",
      "Claude Code token usage is summed per assistant message rather than read from a cumulative counter.",
      "Claude Code subagent invocations and their token usage are counted from a sibling transcript directory when present.",
    );
  }
  return assumptions;
}

function createSessionMilestone(session: ProviderSession): Milestone {
  const evidenceRefs = session.evidence.map((item) => item.evidenceId).sort(compareStrings);
  return {
    milestoneId: `mil_${shortHash(`session-activity\0${session.summary.sessionRef}`, 20)}`,
    kind: "session-activity",
    title: `${providerLabel(session.summary.provider)} session activity`,
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

function sanitizeLocalNarrative(
  sections: GeneratedNarrative["sections"],
  defaults: GeneratedNarrative["sections"],
  redactor: Redactor,
): { sections: GeneratedNarrative["sections"]; fallbacksUsed: string[] } {
  const fallbacksUsed: string[] = [];
  const clean = (name: string, value: unknown, fallback: string, limit: number): string => {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate) {
      fallbacksUsed.push(name);
      return fallback;
    }
    const cleaned = redactor.cleanExcerpt(candidate, limit);
    if (!cleaned) {
      fallbacksUsed.push(name);
      return fallback;
    }
    return cleaned;
  };
  const cleanList = (name: string, value: unknown, fallback: string[], limit: number): string[] => {
    const candidates = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    const cleaned = candidates
      .slice(0, 5)
      .map((item) => redactor.cleanExcerpt(item.trim(), limit))
      .filter((item): item is string => Boolean(item));
    if (!cleaned.length) {
      fallbacksUsed.push(name);
      return fallback;
    }
    return cleaned;
  };
  return {
    sections: {
      headline: clean("headline", sections.headline, defaults.headline, 120),
      narrative: clean("narrative", sections.narrative, defaults.narrative, 2_000),
      turningPoint: clean("turningPoint", sections.turningPoint, defaults.turningPoint, 300),
      learnings: cleanList("learnings", sections.learnings, defaults.learnings, 200),
      decisionPatterns: cleanList("decisionPatterns", sections.decisionPatterns, defaults.decisionPatterns, 300),
      standoutTraits: cleanList("standoutTraits", sections.standoutTraits, defaults.standoutTraits, 300),
      growthEdge: clean("growthEdge", sections.growthEdge, defaults.growthEdge, 500),
    },
    fallbacksUsed: [...new Set(fallbacksUsed)].sort(compareStrings),
  };
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
  const narrativeMode = options.narrative?.mode ?? (options.narrativeEvidence ? "cloud" : "off");
  if (narrativeMode === "local" && options.narrativeEvidence) {
    throw new ScannerError("NARRATIVE_MODE_CONFLICT", "Local narrative mode never carries narrativeEvidence excerpts. Choose local generation or cloud evidence, not both.");
  }
  if (narrativeMode === "cloud" && !options.narrativeEvidence && options.narrative?.mode === "cloud") {
    throw new ScannerError("CLOUD_EVIDENCE_REQUIRED", "Cloud narrative mode requires --with-evidence and an explicit review of the redacted excerpts.");
  }

  reportProgress(options, { stage: "inspect-repository", state: "start", message: "Inspecting repository metadata." });
  const redactor = new Redactor();
  const repository = await inspectRepository(options.repositoryPath, redactor, options.projectName);
  reportProgress(options, { stage: "inspect-repository", state: "complete", message: `Repository identified as ${repository.identity.displayName}.` });
  const selectedProviders = options.providers ?? defaultProviderIds();
  const adapters = (
    options.adapters ??
    createAdapters(selectedProviders, {
      ...(options.codexHome ? { codexHome: options.codexHome } : {}),
      ...(options.claudeCodeHome ? { claudeCodeHome: options.claudeCodeHome } : {}),
      ...(options.antigravityHome ? { antigravityHome: options.antigravityHome } : {}),
      ...(options.cursorHome ? { cursorHome: options.cursorHome } : {}),
    })
  ).slice().sort((left, right) => compareStrings(left.provider, right.provider));

  if (adapters.length === 0) {
    throw new ScannerError("UNSUPPORTED_PROVIDER", "At least one session provider must be selected.");
  }
  const providerIds = adapters.map((adapter) => adapter.provider);
  if (new Set(providerIds).size !== providerIds.length) {
    throw new ScannerError("UNSUPPORTED_PROVIDER", "Each session provider adapter must be distinct.");
  }
  for (const id of providerIds) {
    if (!isRegisteredProvider(id)) {
      throw new ScannerError(
        "UNSUPPORTED_PROVIDER",
        `ProjectSnapshot ${PROJECT_SNAPSHOT_SCHEMA_VERSION} does not support the "${id}" provider.`,
      );
    }
  }

  reportProgress(options, { stage: "discovering-providers", state: "start", message: `Discovering ${adapters.length} session providers.` });
  const discoveries = await Promise.all(
    adapters.map((adapter) => adapter.discover({
      repositoryRoot: repository.rootPath,
      repositoryFingerprint: repository.identity.fingerprint,
      redactor,
    })),
  );
  discoveries.forEach((result, index) => reportProgress(options, {
    stage: "discovering-providers",
    state: "progress",
    provider: result.provider,
    current: index + 1,
    total: discoveries.length,
    message: `${result.provider}: ${result.filesDiscovered} files, ${result.sessionsMatched} sessions matched.`,
  }));
  reportProgress(options, { stage: "discovering-providers", state: "complete", message: "Provider discovery complete." });
  const allSessions = discoveries.flatMap((result) => result.sessions);
  reportProgress(options, { stage: "parsing-sessions", state: "start", message: "Parsing repository-scoped session records." });
  reportProgress(options, { stage: "parsing-sessions", state: "complete", message: `${allSessions.length} repository-scoped sessions parsed.` });
  const timeWindow = deriveTimeWindow(options, allSessions, repository.headTimestamp);
  const includedSessions = allSessions.filter((session) => intersectsWindow(session, timeWindow));
  const includedSessionRefs = new Set(includedSessions.map((session) => session.summary.sessionRef));
  reportProgress(options, { stage: "aggregating-metrics", state: "start", message: "Aggregating Git history and usage metrics." });
  const gitResult = await collectGitMetrics(repository, timeWindow);
  const usage = aggregateUsage(includedSessions);
  reportProgress(options, {
    stage: "aggregating-metrics",
    state: "complete",
    message: `Aggregated ${includedSessions.length} sessions and ${gitResult.metrics.commits} commits.`,
  });

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

  const needsNarrativeEvidenceSelection = narrativeMode === "local" || Boolean(options.narrativeEvidence);
  let narrativeEvidence: NarrativeEvidenceBundle | undefined;
  let localPromptExcerpts: Array<{ role: string; text: string; sessionRef: string }> = [];
  if (needsNarrativeEvidenceSelection) {
    reportProgress(options, { stage: "selecting-evidence", state: "start", message: "Selecting and redacting narrative evidence." });
    const requestedBudget = options.narrativeEvidence;
    const budget = {
      maxExcerpts: requestedBudget?.maxExcerpts ?? DEFAULT_MAX_EXCERPTS,
      maxCharsPerExcerpt: requestedBudget?.maxCharsPerExcerpt ?? DEFAULT_MAX_CHARS_PER_EXCERPT,
      maxTotalChars: requestedBudget?.maxTotalChars ?? DEFAULT_MAX_TOTAL_EXCERPT_CHARS,
    };
    const eventContext = {
      repositoryRoot: repository.rootPath,
      repositoryFingerprint: repository.identity.fingerprint,
      redactor,
    };
    const evidenceAdapters = adapters.filter(
      (adapter) => adapter.descriptor.capabilities.narrativeEvidence && adapter.readEvents && adapter.extractCandidates,
    );
    const sessionGroups: Array<{ provider: ProviderId; sessionRef: string; candidates: RawExcerptCandidate[] }> = [];
    for (const adapter of evidenceAdapters) {
      const providerSessions = includedSessions.filter((session) => session.summary.provider === adapter.provider);
      for (const session of providerSessions) {
        const events = await adapter.readEvents!(session, eventContext);
        const candidates = adapter.extractCandidates!(session.summary.sessionRef, events);
        sessionGroups.push({ provider: adapter.provider, sessionRef: session.summary.sessionRef, candidates });
      }
    }
    const selection = selectNarrativeEvidence(sessionGroups, redactor, budget);
    localPromptExcerpts = selection.excerpts.map((excerpt) => ({ role: excerpt.role, text: excerpt.text, sessionRef: excerpt.sessionRef }));
    let emptyReason: NarrativeEvidenceBundle["emptyReason"];
    if (selection.excerpts.length === 0) {
      emptyReason =
        evidenceAdapters.length === 0
          ? "no-supported-provider-evidence"
          : selection.candidates === 0
            ? "no-candidates-in-window"
            : "all-candidates-rejected";
    }
    if (narrativeMode === "cloud") narrativeEvidence = {
      bundleVersion: NARRATIVE_EVIDENCE_BUNDLE_VERSION,
      generatedAt: timeWindow.end,
      policy: { ...budget, excerptSelection: "deterministic-heuristic-v1" },
      consent: {
        mode: "explicit-cli-review",
        statementVersion: NARRATIVE_EVIDENCE_CONSENT_VERSION,
        approvedActions: ["send-redacted-excerpts-to-configured-cloud-model"],
      },
      excerpts: selection.excerpts.slice().sort((left, right) => compareStrings(left.excerptId, right.excerptId)),
      discarded: {
        candidates: selection.candidates,
        rejectedByRedaction: selection.rejectedByRedaction,
        rejectedByBudget: selection.rejectedByBudget,
      },
      ...(emptyReason ? { emptyReason } : {}),
    };
    reportProgress(options, { stage: "selecting-evidence", state: "complete", message: `${selection.excerpts.length} redacted excerpts selected.` });
  }

  const snapshotWithoutId: Omit<ProjectSnapshot, "scanId"> = {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: timeWindow.end,
    sourceSelection: {
      providers: discoveries.map((result: ProviderDiscoveryResult, index) => ({
        provider: result.provider,
        selected: true,
        repositoryScoped: true,
        rootsConsidered: result.rootsConsidered,
        filesDiscovered: result.filesDiscovered,
        sessionsMatched: result.sessionsMatched,
        sessionsIncluded: result.sessions.filter((session) => includedSessionRefs.has(session.summary.sessionRef)).length,
        warnings: result.warnings.length,
        diagnostic: providerDiagnostic(adapters[index]!, result),
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
    sessions: includedSessions
      .slice()
      .sort((left, right) =>
        compareStrings(left.summary.startedAt, right.summary.startedAt) ||
        compareStrings(left.summary.sessionRef, right.summary.sessionRef),
      )
      .map((session) => session.summary),
    usage,
    git: gitResult.metrics,
    milestones: milestones.sort((left, right) => compareStrings(left.occurredAt, right.occurredAt) || compareStrings(left.milestoneId, right.milestoneId)),
    evidence: evidence.sort((left, right) => compareStrings(left.evidenceId, right.evidenceId)),
    redaction: redactor.summary(true),
    provenance: {
      scanner: { name: SCANNER_NAME, version: SCANNER_VERSION },
      collectionMode: "local-read-only",
      sessionFormats: [...new Set(discoveries.map((result) => result.sessionFormat))].sort(compareStrings),
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
      assumptions: assumptionsForProviders(providerIds),
    },
    ...(narrativeEvidence ? { narrativeEvidence } : {}),
  };

  let generatedNarrative: GeneratedNarrative | undefined;
  if (narrativeMode === "local" && options.narrativeGenerator) {
    const profile = computeBuilderProfile({
      sessions: snapshotWithoutId.sessions,
      usage: snapshotWithoutId.usage,
      git: snapshotWithoutId.git,
      timeWindow: snapshotWithoutId.timeWindow,
    });
    const result = await options.narrativeGenerator({
      snapshot: snapshotWithoutId,
      profile,
      excerpts: localPromptExcerpts,
      redactor,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const defaults = defaultProfileNarrative(profile);
    const sanitized = sanitizeLocalNarrative(result.sections, defaults.sections, redactor);
    const defaultPack = createDefaultStoryPack(snapshotWithoutId as ProjectSnapshot, profile, []);
    const storyPackCandidate = result.storyPack ?? defaultPack;
    const sanitizedPack = sanitizeStoryPack(storyPackCandidate, defaultPack, redactor);
    generatedNarrative = {
      version: "2.0.0",
      generatedAt: timeWindow.end,
      mode: "local",
      provider: result.provider,
      model: result.model,
      sections: result.storyPack ? sectionsFromStoryPack(sanitizedPack.storyPack) : sanitized.sections,
      storyPack: sanitizedPack.storyPack,
      fallbacksUsed: [...new Set([
        ...result.fallbacksUsed,
        ...sanitized.fallbacksUsed,
        ...sanitizedPack.fallbacksUsed,
      ])].sort(compareStrings),
    };
    snapshotWithoutId.generatedNarrative = generatedNarrative;
  }

  snapshotWithoutId.redaction = redactor.summary(true);

  const scanId = `scan_${shortHash(canonicalJson(snapshotWithoutId), 24)}` as const;
  const snapshot: ProjectSnapshot = { ...snapshotWithoutId, scanId };
  const leakedCategories = detectKnownSecrets(canonicalJson(snapshot));
  if (leakedCategories.length > 0) {
    throw new ScannerError(
      "FINAL_REDACTION_CHECK_FAILED",
      "The fail-closed output check found a possible secret. No snapshot was emitted.",
    );
  }
  // Runs over narrativeEvidence.excerpts[].text too. Excerpts are
  // redacted by replacement (see Redactor.cleanExcerpt), not abort - but a
  // pattern this check still catches after that pass means the
  // replacement missed something, and the correct response is to fail the
  // whole snapshot closed, the same as every other field, not to carve out
  // a special case for excerpts here.
  if (detectPrivateLocations(snapshot).length > 0) {
    throw new ScannerError(
      "FINAL_LOCATION_CHECK_FAILED",
      "The fail-closed output check found a possible URL, host, or path. No snapshot was emitted.",
    );
  }
  reportProgress(options, { stage: "validating-story-pack", state: "start", message: "Validating the structured story pack and redacted snapshot." });
  validateProjectSnapshot(snapshot);
  reportProgress(options, { stage: "validating-story-pack", state: "complete", message: "Snapshot and story pack validated." });
  return snapshot;
}

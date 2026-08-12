/** Portable TypeScript mirror of schema/project-snapshot.schema.json. */

export const PROJECT_SNAPSHOT_SCHEMA_VERSION = "1.7.0" as const;
export const SCANNER_NAME = "buildstory" as const;
export const SCANNER_VERSION = "1.1.1" as const;
export const CONSENT_STATEMENT_VERSION = "1.0" as const;
/** Separate, additional consent for the opt-in narrativeEvidence bundle only. */
export const NARRATIVE_EVIDENCE_CONSENT_VERSION = "1.0" as const;
export const NARRATIVE_EVIDENCE_BUNDLE_VERSION = "1.0.0" as const;
export const EVENT_SPINE_VERSION = "1.0.0" as const;

export type IsoDateTime = string;
export type Sha256Digest = `sha256:${string}`;
/**
 * Connection-level mode, chosen on the dashboard and carried by the stored
 * upload grant. "byok" is a locally-generated mode like "local" - the model
 * call goes to a cloud provider the creator configured with their own key,
 * but the key and the resulting excerpts never reach Buildstory, only the
 * redacted prose does. It is distinct from GeneratedNarrative.mode below,
 * which stays "local" for both "local" and "byok" scans - only `provider`
 * distinguishes Ollama from a BYOK model in the uploaded snapshot.
 */
export type NarrativeMode = "local" | "byok" | "cloud" | "off";
export type NarrativeProvider = "openrouter" | "openai" | "ollama" | "openai-compatible";
export type AnalysisTier = "standard" | "deep";

/**
 * Every AI coding-session source this scanner can read. gemini-antigravity
 * and cursor are best-effort adapters built from researched, unverified
 * local formats (no real local install was available to confirm against) -
 * see their ProviderDescriptor.formatVersions, which is always prefixed
 * "unverified-" until a real fixture confirms the format.
 */
export type ProviderId = "codex" | "claude-code" | "gemini-antigravity" | "cursor";

export type SessionFormat = "codex-jsonl" | "claude-code-jsonl" | "gemini-antigravity-jsonl" | "cursor-sqlite";

export interface ProjectSnapshot {
  schemaVersion: typeof PROJECT_SNAPSHOT_SCHEMA_VERSION;
  scanId: `scan_${string}`;
  generatedAt: IsoDateTime;
  sourceSelection: SourceSelection;
  repository: RepositoryIdentity;
  timeWindow: TimeWindow;
  sessions: SessionSummary[];
  usage: UsageSummary;
  git: GitAggregateMetrics;
  milestones: Milestone[];
  evidence: EvidenceReference[];
  redaction: RedactionSummary;
  provenance: Provenance;
  quality: QualitySummary;
  /**
   * Deterministic, content-free chronology derived only from already-approved
   * session metadata and opaque evidence references. It never contains source
   * text, paths, URLs, commit messages, diffs, or tool arguments/results.
   */
  eventSpine?: EventSpine;
  /**
   * Opt-in only: present exclusively when the creator explicitly ran the
   * excerpts flow, reviewed the exact bundle, and typed the confirmation.
   * Absent from every default scan. This is the ONLY field on
   * ProjectSnapshot that may contain excerpted session text; every other
   * field remains permanently content-free.
   */
  narrativeEvidence?: NarrativeEvidenceBundle;
  /** Local-only prose. Cloud narratives are generated server-side and never enter the upload. */
  generatedNarrative?: GeneratedNarrative;
}

export type BuildEventKind =
  | "session-start"
  | "planning"
  | "model-shift"
  | "exploration"
  | "mutation"
  | "verification"
  | "delegation"
  | "session-outcome"
  | "repository-milestone";

export type BuildEventPhase = "discover" | "decide" | "deliver";

export interface BuildEvent {
  eventId: `evt_${string}`;
  occurredAt: IsoDateTime;
  kind: BuildEventKind;
  phase: BuildEventPhase;
  /** Fixed scanner-authored label selected from the event kind. */
  label: string;
  /** Opaque session reference; absent for repository-wide milestones. */
  sessionRef?: string;
  provider?: ProviderId | "git";
  /** Count attached to the event (turns, calls, models, or invocations). */
  magnitude: number;
  measurement: "turns" | "distinct-tools" | "models" | "invocations" | "status" | "milestone";
  /** Session aggregates do not reveal the exact instant of an inner event. */
  temporalPrecision: "exact" | "estimated";
  sourceRefs: string[];
  privacy: "metadata-only";
}

export interface EventSpine {
  version: typeof EVENT_SPINE_VERSION;
  generatedAt: IsoDateTime;
  events: BuildEvent[];
  coverage: {
    sessions: number;
    milestones: number;
    events: number;
  };
}

export type NarrativeExcerptRole =
  | "session-title"
  | "user-intent"
  | "plan-transition"
  | "assistant-decision"
  | "outcome";

export interface NarrativeExcerpt {
  excerptId: string;
  sessionRef: string;
  occurredAt: IsoDateTime;
  role: NarrativeExcerptRole;
  /** Redacted (paths/URLs/hosts replaced), truncated, control-character-free. */
  text: string;
}

export type NarrativeEvidenceEmptyReason =
  | "no-supported-provider-evidence"
  | "no-candidates-in-window"
  | "all-candidates-rejected";

export interface NarrativeEvidenceBundle {
  bundleVersion: typeof NARRATIVE_EVIDENCE_BUNDLE_VERSION;
  generatedAt: IsoDateTime;
  policy: {
    maxExcerpts: number;
    maxCharsPerExcerpt: number;
    maxTotalChars: number;
    maxTotalBytes?: number;
    excerptSelection: "deterministic-heuristic-v1" | "deep-evidence-v2";
  };
  /** Separate from sourceSelection.consent; specifically authorizes this bundle's transmission. */
  consent: {
    mode: "explicit-cli-review";
    statementVersion: typeof NARRATIVE_EVIDENCE_CONSENT_VERSION;
    approvedActions: ["send-redacted-excerpts-to-configured-cloud-model"];
  };
  excerpts: NarrativeExcerpt[];
  discarded: {
    candidates: number;
    rejectedByRedaction: number;
    rejectedByBudget: number;
  };
  /** Present only when excerpts is empty, so the portal can explain why no narrative will be generated instead of just showing nothing. */
  emptyReason?: NarrativeEvidenceEmptyReason;
}

export interface SourceSelection {
  providers: ProviderSelection[];
  /** Collection consent only. Transport consent is separately command-scoped and receipt-audited. */
  consent: {
    mode: "explicit-cli";
    statementVersion: typeof CONSENT_STATEMENT_VERSION;
    approvedActions: [
      "read-repository-metadata",
      "read-selected-local-session-metadata",
      "write-local-snapshot",
    ];
    deniedActions: ["network-upload"];
  };
}

export type ProviderDiagnosticCode =
  | "not-installed"
  | "no-project-directory"
  | "no-matching-sessions"
  | "format-unsupported"
  | "scope-unknown"
  | "scanned";

export interface ProviderSelection {
  provider: ProviderId;
  selected: true;
  repositoryScoped: true;
  rootsConsidered: number;
  filesDiscovered: number;
  sessionsMatched: number;
  sessionsIncluded: number;
  warnings?: number;
  /**
   * Content-free outcome for this provider's discovery pass. Omitted keeps
   * pre-1.3.0 reading code working (absence has always meant "scanned").
   */
  diagnostic?: ProviderDiagnosticCode;
}

export interface RepositoryIdentity {
  fingerprint: Sha256Digest;
  fingerprintBasis: "canonical-remote" | "local-path";
  displayName: string;
  vcs: "git";
  rootPathIncluded: false;
  headCommit: string | null;
  branch: string | null;
  detachedHead: boolean;
  remote: {
    repositoryPathHash: Sha256Digest;
  } | null;
  bare: boolean;
}

export interface TimeWindow {
  start: IsoDateTime;
  end: IsoDateTime;
  timezone: "UTC";
  /**
   * "full-history" is the current default (no --since: start at the
   * earliest observed session). "default-lookback" and "empty-repository"
   * are retained only so snapshots emitted by older scanner versions keep
   * validating - the scanner no longer produces them.
   */
  startBasis: "explicit" | "full-history" | "default-lookback" | "empty-repository";
  endBasis: "explicit" | "latest-session" | "head-commit" | "unix-epoch";
  /** Optional coarse local-time offset used only to make work-pattern hours meaningful. */
  utcOffsetMinutes?: number;
}

export type GeneratedNarrativeSections = {
  headline: string;
  narrative: string;
  turningPoint: string;
  learnings: string[];
  decisionPatterns: string[];
  standoutTraits: string[];
  growthEdge: string;
};

export type StoryPackPhase = "discover" | "decide" | "deliver";
export type StoryPackMomentKind = "discovery" | "decision" | "breakthrough" | "delivery";

export type SignalFamily = "rhythm" | "tooling" | "conversation" | "spend" | "output" | "evidence";

/**
 * A true, ranked, publishable fact computed entirely from deterministic
 * snapshot data - no model call, no possibility of hallucination. See
 * insights/signals.ts for computeSignals(). The LLM layer may only write
 * framing over a signal's own headline/detail/value; it can never invent a
 * number, and validateStoryPackComponent rejects any byTheNumbers.signalId
 * that doesn't name a signal actually returned by computeSignals - the same
 * way it already rejects an unknown sourceRef.
 */
export interface Signal {
  id: string;
  family: SignalFamily;
  headline: string;
  detail: string;
  value: number;
  unit: string;
  /** 0-100, a deterministic distance-from-baseline per family. Higher = more surprising. */
  notability: number;
  /** Auditable, mirrors profile.ts's score.formula house style. */
  formula: string;
  sourceRefs: string[];
}

export interface StoryPackSource {
  ref: string;
  provider: ProviderId | "git";
  sessionRef?: string;
  occurredAt: IsoDateTime;
  evidenceRefs: string[];
  excerptRef?: string;
  metrics: {
    turns: number;
    assistantMessages: number;
    toolCalls: number;
  };
}

export interface ReportStoryPackV2 {
  version: "2.0.0";
  sources: StoryPackSource[];
  hero: { headline: string; summary: string };
  buildArc: Array<{
    phase: StoryPackPhase;
    headline: string;
    summary: string;
    sourceRefs: string[];
  }>;
  moments: Array<{
    phase: StoryPackPhase;
    kind: StoryPackMomentKind;
    title: string;
    whatHappened: string;
    whyItMattered: string;
    sourceRefs: string[];
  }>;
  turningPoint: { quote: string; sourceRefs: string[] };
  decisions: Array<{
    title: string;
    rationale: string;
    outcome: string;
    sourceRefs: string[];
  }>;
  learnings: Array<{ title: string; detail: string; sourceRefs: string[] }>;
  standoutTraits: Array<{ title: string; detail: string; sourceRefs: string[] }>;
  /** `nextStep` is deliberately optional - see the matching comment in the web package's scanner-project-snapshot.ts. */
  growthEdge: {
    title: string;
    observation: string;
    nextStep?: string;
    sourceRefs: string[];
  };
  /** Deterministic, ranked facts - present on every tier and every narrative mode, including "off". See insights/signals.ts. */
  signals: Signal[];
}

export type StoryPackConfidence = "high" | "medium" | "low";
export type StoryPackFinding = { title: string; summary: string; sourceRefs: string[]; confidence: StoryPackConfidence };
/** @deprecated Cut from generation (see the report-redesign sprint); kept only so a pack stored before that change still typechecks. */
export type StoryPackRecommendation = StoryPackFinding & { priority: "now" | "next" | "later"; rationale: string };
/** An LLM-written finding that frames one specific computed Signal - never a number the model invented. */
export type StoryPackSignalFinding = StoryPackFinding & { signalId: string };
export interface ReportStoryPackV3 extends Omit<ReportStoryPackV2, "version"> {
  version: "3.0.0";
  analysisTier: AnalysisTier;
  deepAnalysis?: {
    /** The one-sentence hook. Replaces the old `executiveSynthesis`. */
    openingLine: StoryPackFinding;
    /** How this builder distinctively works, grounded in computed ratios. Replaces `engineeringPatterns`. */
    signatureMoves: StoryPackFinding[];
    /** LLM framing over a computed Signal - the anti-hallucination mechanism. Every entry's signalId must name a real signal. */
    byTheNumbers: StoryPackSignalFinding[];
    /** Friction as narrative, not audit findings. Replaces `frictionAndRecovery`. */
    whereItGotHard: StoryPackFinding[];
    chapterChanges: StoryPackFinding[];
    coverage: { sessionsSeen: number; excerptsUsed: number; evidenceBytes: number; windowStart: IsoDateTime; windowEnd: IsoDateTime };
    /** @deprecated Renamed to `openingLine`. */
    executiveSynthesis?: StoryPackFinding;
    /** @deprecated Renamed to `signatureMoves`. */
    engineeringPatterns?: StoryPackFinding[];
    /** @deprecated Renamed to `whereItGotHard`. */
    frictionAndRecovery?: StoryPackFinding[];
    /** @deprecated Cut from generation - advice/recommendations are off-vision for this product. */
    decisionReview?: StoryPackFinding[];
    /** @deprecated Cut from generation. */
    risksAndEvidenceGaps?: StoryPackFinding[];
    /** @deprecated Cut from generation - the report surfaces facts, not next steps. */
    nextBuildActions?: StoryPackRecommendation[];
  };
}
export type ReportStoryPack = ReportStoryPackV2 | ReportStoryPackV3;

export interface GeneratedNarrative {
  version: "1.0.0" | "2.0.0" | "3.0.0";
  generatedAt: IsoDateTime;
  mode: "local";
  provider: string;
  model: string;
  sections: GeneratedNarrativeSections;
  /** Present for new reports; legacy sections remain readable during rollout. */
  storyPack?: ReportStoryPack;
  fallbacksUsed: string[];
}

export type SessionStatus = "completed" | "aborted" | "incomplete" | "unknown";

export interface SessionSummary {
  sessionRef: string;
  provider: ProviderId;
  sourceKind: "active" | "archived" | "custom";
  startedAt: IsoDateTime;
  endedAt: IsoDateTime;
  status: SessionStatus;
  workingDirectoryRelation: "repository-root" | "subdirectory";
  summary: string;
  turns: number;
  assistantMessages: number;
  toolCalls: number;
  modelRefs: string[];
  toolRefs: string[];
  tokenUsage: TokenUsage | null;
  /** Turns issued while the session was in a plan-first/ask-before-edit mode. Omitted where the provider does not expose this signal. */
  planModeTurns?: number;
  /** Subagent/sub-session invocations attributed to this session. Omitted where the provider does not expose this signal. */
  subagentInvocations?: number;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Prompt-cache write tokens (total). Omitted where the provider does not report cache writes. */
  cacheCreationInputTokens?: number;
  /** Prompt-cache write tokens billed at the 1-hour cache-write rate. */
  cacheCreation1hInputTokens?: number;
  /** Prompt-cache write tokens billed at the 5-minute cache-write rate. */
  cacheCreation5mInputTokens?: number;
  /** Prompt-cache read/hit tokens (typically billed far below input rate). */
  cacheReadInputTokens?: number;
}

export interface UsageSummary {
  tools: Array<{
    name: string;
    callCount: number;
    sessionCount: number;
  }>;
  models: Array<{
    provider: string;
    name: string;
    /** Normalized model-response calls; retained as turnCount for 1.6 wire compatibility. */
    turnCount: number;
    sessionCount: number;
    /**
     * Exact for Claude Code after response-id deduplication and Codex after
     * per-token_count ledger attribution. Null where no session reported usage.
     */
    tokenUsage: TokenUsage | null;
    /** Null when `name` isn't in the static session-pricing table — never a fabricated price. */
    costMicroUsd: number | null;
  }>;
  totalToolCalls: number;
  totalTurns: number;
  tokenUsage: TokenUsage | null;
  /** Aggregate cost roll-up across every priced model; see session-pricing.ts. */
  cost: UsageCostSummary;
  /** Absent on a snapshot from a scanner older than 1.7.0 - coverage is unknown, not zero. */
  coverage?: UsageCoverage;
}

export interface UsageCostSummary {
  /** Null only when zero models in this snapshot are in the pricing table. */
  totalMicroUsd: number | null;
  /** Total tokens (across all token kinds) belonging to a priced model. */
  pricedTokens: number;
  /** Total tokens belonging to a model absent from the pricing table. */
  unpricedTokens: number;
  pricingTableVersion: string;
}

/**
 * How completely this snapshot's usage/cost figures reflect what the
 * scanner actually observed on disk. Exists so a build receipt never
 * silently presents a partial number as if it were the whole story - see
 * scanner.ts's time-window filtering and session_pricing.ts's per-record
 * pricing.
 */
export interface UsageCoverage {
  /** Sessions matched and parsed by any provider adapter, before time-window filtering. */
  sessionsDiscovered: number;
  /** Sessions actually included in this snapshot's usage/cost/session totals, after time-window filtering. */
  sessionsIncluded: number;
  /** sessionsDiscovered - sessionsIncluded. */
  sessionsSkipped: number;
  /**
   * Why a discovered session didn't make it into this snapshot. Only
   * "outside-window" is populated today - the scanner does not yet
   * attribute an adapter-internal drop (an unusable timestamp, a
   * sessionRef collision, an unreadable file) to a specific session count,
   * though each remains visible as its own quality warning.
   */
  skipped: Array<{
    reason: "outside-window" | "no-timestamp" | "duplicate-session-id" | "parse-failed" | "file-unreadable";
    count: number;
  }>;
  /** Models with some tokens priced and some not (e.g. straddling a dated pricing entry's effective window) - see session-pricing.ts. */
  partiallyPricedModels: number;
}

export interface GitAggregateMetrics {
  commits: number;
  mergeCommits: number;
  contributors: number;
  fileTouches: number;
  insertions: number;
  deletions: number;
  aiAttribution?: {
    source: "git-ai";
    optIn: true;
    humanAdditions: number;
    aiAdditions: number;
    aiAccepted: number;
    toolModels: Array<{ tool: string; model: string; aiAdditions: number; aiAccepted: number }>;
  };
  workingTree: {
    isDirty: boolean;
    stagedEntries: number;
    modifiedEntries: number;
    untrackedEntries: number;
    conflictedEntries: number;
  };
}

export interface Milestone {
  milestoneId: string;
  kind: "session-activity" | "repository-activity";
  title: string;
  summary: string;
  occurredAt: IsoDateTime;
  evidenceRefs: string[];
}

export interface EvidenceReference {
  evidenceId: string;
  source: ProviderId | "git";
  kind: "session-boundary" | "tool-activity" | "git-aggregate";
  observedAt: IsoDateTime;
  digest: Sha256Digest;
  sessionRef?: string;
  eventOrdinal?: number;
}

export type RedactionCategory =
  | "private-key"
  | "anthropic-key"
  | "aws-access-key"
  | "github-token"
  | "gitlab-token"
  | "slack-token"
  | "stripe-key"
  | "twilio-key"
  | "openai-key"
  | "huggingface-token"
  | "npm-token"
  | "pypi-token"
  | "google-api-key"
  | "oauth-token"
  | "azure-storage-key"
  | "cloudflare-token"
  | "jwt"
  | "authorization"
  | "credential-url"
  | "sensitive-assignment"
  | "high-entropy"
  | "control-character";

export interface RedactionSummary {
  applied: boolean;
  findings: number;
  categories: Array<{
    category: RedactionCategory;
    count: number;
  }>;
  metadataValuesScanned: number;
  metadataValuesTruncated: number;
  transcriptBodiesDiscarded: number;
  toolPayloadsDiscarded: number;
  finalLeakCheckPassed: boolean;
  limitations: string[];
}

export interface Provenance {
  scanner: {
    name: typeof SCANNER_NAME | "story-scanner";
    version: string;
  };
  collectionMode: "local-read-only";
  /** Sorted, de-duplicated formats of every provider actually scanned. */
  sessionFormats: SessionFormat[];
  deterministicSerialization: "lexicographic-json";
  repositoryCommands: string[];
  sourceFilesConsidered: number;
  sourceFilesParsed: number;
  sourceFilesSkipped: number;
}

export type QualityWarningCode =
  | "CODEX_ROOT_UNAVAILABLE"
  | "CLAUDE_CODE_ROOT_UNAVAILABLE"
  | "GEMINI_ANTIGRAVITY_ROOT_UNAVAILABLE"
  | "CURSOR_ROOT_UNAVAILABLE"
  | "PROVIDER_FORMAT_UNVERIFIED"
  | "PROVIDER_SCOPE_UNKNOWN"
  | "SESSION_FILE_LIMIT_REACHED"
  | "SESSION_FILE_TOO_LARGE"
  | "SESSION_LINE_TOO_LARGE"
  | "SESSION_LINE_INVALID_JSON"
  | "SESSION_MISSING_METADATA"
  | "SESSION_TIMESTAMP_INVALID"
  | "SESSION_MODEL_UNKNOWN"
  | "SESSION_ACTIVE_AT_SCAN_END"
  | "GIT_HISTORY_UNAVAILABLE"
  | "GIT_STATUS_UNAVAILABLE"
  | "GIT_AI_ATTRIBUTION_UNAVAILABLE"
  | "NO_MATCHING_SESSIONS";

export interface QualityWarning {
  code: QualityWarningCode;
  severity: "info" | "warning";
  message: string;
  sessionRef?: string;
}

export interface QualitySummary {
  level: "high" | "medium" | "low";
  warningCount: number;
  warnings: QualityWarning[];
  assumptions: string[];
}

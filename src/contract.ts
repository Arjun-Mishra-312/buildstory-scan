/** Portable TypeScript mirror of schema/project-snapshot.schema.json. */

export const PROJECT_SNAPSHOT_SCHEMA_VERSION = "1.1.0" as const;
export const SCANNER_NAME = "buildstory" as const;
export const SCANNER_VERSION = "0.3.0" as const;
export const CONSENT_STATEMENT_VERSION = "1.0" as const;

export type IsoDateTime = string;
export type Sha256Digest = `sha256:${string}`;

/** Every AI coding-session source this scanner can read. */
export type ProviderId = "codex" | "claude-code";

export type SessionFormat = "codex-jsonl" | "claude-code-jsonl";

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

export interface ProviderSelection {
  provider: ProviderId;
  selected: true;
  repositoryScoped: true;
  rootsConsidered: number;
  filesDiscovered: number;
  sessionsMatched: number;
  sessionsIncluded: number;
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
  startBasis: "explicit" | "default-lookback" | "empty-repository";
  endBasis: "explicit" | "latest-session" | "head-commit" | "unix-epoch";
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
    turnCount: number;
    sessionCount: number;
  }>;
  totalToolCalls: number;
  totalTurns: number;
  tokenUsage: TokenUsage | null;
}

export interface GitAggregateMetrics {
  commits: number;
  mergeCommits: number;
  contributors: number;
  fileTouches: number;
  insertions: number;
  deletions: number;
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

import type { EvidenceReference, NarrativeExcerptRole, ProviderId, QualityWarning, SessionFormat, SessionSummary, TokenUsage } from "../contract.js";
import type { Redactor } from "../redaction.js";

/**
 * tokenUsage is exact for Claude Code (model and usage co-occur per record)
 * and a session-level approximation for Codex (attributed to the dominant
 * model; token_count snapshots aren't tied to a specific model event).
 */
export type ModelCounts = Map<string, { provider: string; turns: number; tokenUsage: TokenUsage | null }>;

export interface ProviderSession {
  summary: SessionSummary;
  toolCounts: Map<string, number>;
  modelCounts: ModelCounts;
  evidence: EvidenceReference[];
  /**
   * Absolute path to this session's own source file, kept only in-process
   * for a same-run excerpt-extraction pass; never serialized into
   * ProjectSnapshot. Present only for adapters whose descriptor declares
   * capabilities.narrativeEvidence.
   */
  sourceFilePath?: string;
}

/** Static, content-free description of one provider adapter's capabilities. */
export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  sessionFormat: SessionFormat;
  capabilities: {
    /** Every registered adapter can at least attempt metadata discovery. */
    metadata: boolean;
    narrativeEvidence: boolean;
  };
  /**
   * Local-format version tags this adapter understands. A detection-only
   * adapter (format researched but not confirmed against a real local
   * install) uses a tag starting with "unverified-" so callers never treat
   * it as a fully confident parse.
   */
  formatVersions: string[];
}

/**
 * One normalized conversation event, common across every provider's local
 * transcript format. Internal-only: never exported from contract.ts, never
 * serialized into ProjectSnapshot. Exists only for the lifetime of one scan's
 * opt-in narrative-evidence pass.
 */
export interface NormalizedConversationEvent {
  provider: ProviderId;
  sessionRef: string;
  ordinal: number;
  occurredAt: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string | null;
  eventKind: "message" | "title" | "tool-call" | "tool-result" | "status";
  modelRef?: string;
  permissionMode?: string;
  /** Present only on tool-call/tool-result events; lets a decision heuristic distinguish e.g. an edit from a read. */
  toolName?: string;
}

/** One provider-recognized narrative moment, before shared redaction/budgeting. */
export interface RawExcerptCandidate {
  sessionRef: string;
  occurredAt: string;
  role: NarrativeExcerptRole;
  text: string;
}

export interface ExcerptExtractionResult {
  excerpts: import("../contract.js").NarrativeExcerpt[];
  candidates: number;
  rejectedByRedaction: number;
  rejectedByBudget: number;
}

export interface ProviderDiscoveryResult {
  provider: ProviderId;
  sessionFormat: SessionFormat;
  rootsConsidered: number;
  filesDiscovered: number;
  filesParsed: number;
  filesSkipped: number;
  sessionsMatched: number;
  sessions: ProviderSession[];
  warnings: QualityWarning[];
}

export interface ProviderDiscoveryContext {
  repositoryRoot: string;
  repositoryFingerprint: string;
  redactor: Redactor;
}

export interface SessionProviderAdapter {
  readonly provider: ProviderId;
  readonly sessionFormat: SessionFormat;
  readonly descriptor: ProviderDescriptor;
  discover(context: ProviderDiscoveryContext): Promise<ProviderDiscoveryResult>;
  /**
   * Opt-in narrative-evidence support, split into a shared-shape read pass
   * and a provider-owned recognition pass. Both are undefined for adapters
   * whose descriptor declares capabilities.narrativeEvidence = false; the
   * caller treats missing methods the same as "this session's provider
   * contributed nothing," not an error.
   */
  readEvents?(session: ProviderSession, context: ProviderDiscoveryContext): Promise<NormalizedConversationEvent[]>;
  /** Maps one session's normalized events to canonical candidate roles, already capped/ordered. */
  extractCandidates?(sessionRef: string, events: NormalizedConversationEvent[]): RawExcerptCandidate[];
}

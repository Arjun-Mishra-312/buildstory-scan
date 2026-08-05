import type { EvidenceReference, NarrativeExcerpt, ProviderId, QualityWarning, SessionFormat, SessionSummary } from "../contract.js";
import type { Redactor } from "../redaction.js";

export interface ProviderSession {
  summary: SessionSummary;
  toolCounts: Map<string, number>;
  modelCounts: Map<string, { provider: string; turns: number }>;
  evidence: EvidenceReference[];
  /**
   * Absolute path to this session's own source file, kept only in-process
   * for a same-run excerpt-extraction pass; never serialized into
   * ProjectSnapshot. Present only for adapters whose sessionFormat
   * declares excerpt support (currently claude-code).
   */
  sourceFilePath?: string;
}

export interface ExcerptExtractionResult {
  excerpts: NarrativeExcerpt[];
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
  discover(context: ProviderDiscoveryContext): Promise<ProviderDiscoveryResult>;
  /**
   * Opt-in narrative-evidence excerpt extraction. Undefined for adapters
   * that don't support it yet (codex); the caller treats a missing method
   * the same as "this session's provider contributed nothing," not an
   * error.
   */
  extractExcerpts?(
    sessions: ProviderSession[],
    redactor: Redactor,
    budget: { maxExcerpts: number; maxCharsPerExcerpt: number; maxTotalChars: number },
  ): Promise<ExcerptExtractionResult>;
}

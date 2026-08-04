import type { EvidenceReference, ProviderId, QualityWarning, SessionFormat, SessionSummary } from "../contract.js";
import type { Redactor } from "../redaction.js";

export interface ProviderSession {
  summary: SessionSummary;
  toolCounts: Map<string, number>;
  modelCounts: Map<string, { provider: string; turns: number }>;
  evidence: EvidenceReference[];
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
}

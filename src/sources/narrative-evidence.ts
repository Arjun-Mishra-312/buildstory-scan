import { compareStrings, shortHash } from "../canonical-json.js";
import type { NarrativeExcerpt, ProviderId } from "../contract.js";
import type { Redactor } from "../redaction.js";
import type { RawExcerptCandidate } from "./types.js";

/**
 * Deterministic-heuristic-v1 narrative-evidence policy. Every numeric limit
 * here is a named safety default, not a magic number; NarrativeEvidenceBundle
 * carries `policy.excerptSelection` so a future policy revision is
 * traceable in every emitted snapshot.
 */
export const NARRATIVE_EVIDENCE_POLICY_VERSION = "deterministic-heuristic-v1" as const;
export const DEEP_NARRATIVE_EVIDENCE_POLICY_VERSION = "deep-evidence-v2" as const;
export const DEFAULT_MAX_EXCERPTS = 40;
export const DEFAULT_MAX_CHARS_PER_EXCERPT = 600;
export const DEFAULT_MAX_TOTAL_EXCERPT_CHARS = 20_000;
export const MAX_EXCERPTS_PER_SESSION = 6;
export const MAX_ASSISTANT_DECISIONS_PER_SESSION = 3;
// Standard cloud/BYOK models have substantially more reliable context than
// the minimum local baseline. This remains a one-pass Standard report; the
// larger allowance improves session coverage without pretending to be Deep.
export const CLOUD_STANDARD_MAX_EXCERPTS = 80;
export const CLOUD_STANDARD_MAX_CHARS_PER_EXCERPT = 800;
export const CLOUD_STANDARD_MAX_TOTAL_EXCERPT_CHARS = 60_000;
export const CLOUD_STANDARD_MAX_EXCERPTS_PER_SESSION = 8;
export const CLOUD_STANDARD_MAX_ASSISTANT_DECISIONS_PER_SESSION = 4;
// Deep uses the larger context as bounded capacity, while the CLI dynamically
// lowers the byte allowance to keep the complete upload below its grant.
export const DEEP_MAX_EXCERPTS = 240;
export const DEEP_MAX_CHARS_PER_EXCERPT = 1_500;
export const DEEP_MAX_TOTAL_EXCERPT_BYTES = 700 * 1024;
export const DEEP_MAX_EXCERPTS_PER_SESSION = 12;
export const DEEP_MAX_ASSISTANT_DECISIONS_PER_SESSION = 6;
export const ASSISTANT_DECISION_MAX_RAW_CHARS = 600;

export interface ExcerptBudget {
  maxExcerpts: number;
  maxCharsPerExcerpt: number;
  maxTotalChars: number;
  maxTotalBytes?: number;
  maxExcerptsPerSession?: number;
  maxAssistantDecisionsPerSession?: number;
}

export interface SessionCandidateParts {
  sessionTitle?: { text: string; occurredAt: string } | null;
  firstUser?: { text: string; occurredAt: string } | null;
  lastUser?: { text: string; occurredAt: string } | null;
  /** Already time-ordered: plan-transitions, assistant-decisions, etc. */
  turningPoints: RawExcerptCandidate[];
}

/**
 * Provider-agnostic assembly of one session's raw candidates into the
 * canonical role order (title, intent, turning points, outcome), deduplicated
 * and capped. Every adapter's extractCandidates() should funnel its
 * provider-specific recognition through this so ordering/dedup/capping stays
 * identical across providers.
 */
export function orderSessionCandidates(sessionRef: string, parts: SessionCandidateParts): RawExcerptCandidate[] {
  const ordered: RawExcerptCandidate[] = [];
  const { sessionTitle, firstUser, lastUser, turningPoints } = parts;
  if (sessionTitle) ordered.push({ sessionRef, role: "session-title", ...sessionTitle });
  if (firstUser) ordered.push({ sessionRef, role: "user-intent", ...firstUser });
  ordered.push(...turningPoints);
  // Skip "outcome" if the same text is already captured under another role
  // (e.g. the last user turn is also the message that triggered a
  // plan-transition candidate) - the same excerpt shouldn't consume the
  // budget twice just because it earned two labels.
  if (lastUser && lastUser !== firstUser && !ordered.some((entry) => entry.text === lastUser.text)) {
    ordered.push({ sessionRef, role: "outcome", ...lastUser });
  }
  return ordered;
}

export interface SessionCandidateGroup {
  provider: ProviderId;
  sessionRef: string;
  candidates: RawExcerptCandidate[];
}

export interface NarrativeSelectionResult {
  excerpts: NarrativeExcerpt[];
  candidates: number;
  rejectedByRedaction: number;
  rejectedByBudget: number;
  perProvider: Map<ProviderId, { candidates: number; excerpts: number }>;
}

/**
 * The one place redaction, global budgeting, deduplication-by-selection-
 * order, and cross-provider/cross-session fairness happen. Adapters never
 * see the budget or call the redactor directly for excerpts; this function
 * is the sole caller of Redactor.cleanExcerpt for narrative text.
 *
 * Fairness: sessions are visited round-robin (one candidate per pass) in a
 * filesystem-enumeration-independent order (sorted by provider, then
 * sessionRef), so no single provider or session can exhaust the shared
 * budget before every other session gets at least one opportunity. Every
 * candidate is still counted (accepted, redaction-dropped, or budget-
 * dropped) so the bundle's `discarded` counters stay exact.
 */
export function selectNarrativeEvidence(
  sessionGroups: SessionCandidateGroup[],
  redactor: Redactor,
  budget: ExcerptBudget,
): NarrativeSelectionResult {
  const sorted = [...sessionGroups].sort(
    (left, right) => compareStrings(left.provider, right.provider) || compareStrings(left.sessionRef, right.sessionRef),
  );

  const excerpts: NarrativeExcerpt[] = [];
  let candidateCount = 0;
  let rejectedByRedaction = 0;
  let rejectedByBudget = 0;
  let totalChars = 0;
  let totalBytes = 0;
  const selectedBySession = new Map<string, number>();
  const decisionsBySession = new Map<string, number>();
  const perProvider = new Map<ProviderId, { candidates: number; excerpts: number }>();

  const cursors = sorted.map(() => 0);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let index = 0; index < sorted.length; index += 1) {
      const group = sorted[index];
      if (!group) continue;
      const cursor = cursors[index] ?? 0;
      if (cursor >= group.candidates.length) continue;
      progressed = true;
      const candidate = group.candidates[cursor];
      cursors[index] = cursor + 1;
      if (!candidate) continue;

      candidateCount += 1;
      const providerStats = perProvider.get(group.provider) ?? { candidates: 0, excerpts: 0 };
      providerStats.candidates += 1;
      perProvider.set(group.provider, providerStats);

      if (excerpts.length >= budget.maxExcerpts) {
        rejectedByBudget += 1;
        continue;
      }
      const selectedForSession = selectedBySession.get(candidate.sessionRef) ?? 0;
      if (selectedForSession >= (budget.maxExcerptsPerSession ?? MAX_EXCERPTS_PER_SESSION)) {
        rejectedByBudget += 1;
        continue;
      }
      if (candidate.role === "assistant-decision" && (decisionsBySession.get(candidate.sessionRef) ?? 0) >= (budget.maxAssistantDecisionsPerSession ?? MAX_ASSISTANT_DECISIONS_PER_SESSION)) {
        rejectedByBudget += 1;
        continue;
      }
      const cleaned = redactor.cleanExcerpt(candidate.text, budget.maxCharsPerExcerpt);
      if (cleaned === null) {
        rejectedByRedaction += 1;
        continue;
      }
      if (totalChars + cleaned.length > budget.maxTotalChars) {
        rejectedByBudget += 1;
        continue;
      }
      const cleanedBytes = Buffer.byteLength(cleaned, "utf8");
      if (budget.maxTotalBytes !== undefined && totalBytes + cleanedBytes > budget.maxTotalBytes) {
        rejectedByBudget += 1;
        continue;
      }
      totalChars += cleaned.length;
      totalBytes += cleanedBytes;
      excerpts.push({
        excerptId: `exc_${shortHash(`${candidate.sessionRef}\0${candidate.role}\0${candidate.occurredAt}\0${excerpts.length}`, 20)}`,
        sessionRef: candidate.sessionRef,
        occurredAt: candidate.occurredAt,
        role: candidate.role,
        text: cleaned,
      });
      providerStats.excerpts += 1;
      selectedBySession.set(candidate.sessionRef, selectedForSession + 1);
      if (candidate.role === "assistant-decision") decisionsBySession.set(candidate.sessionRef, (decisionsBySession.get(candidate.sessionRef) ?? 0) + 1);
    }
  }

  return { excerpts, candidates: candidateCount, rejectedByRedaction, rejectedByBudget, perProvider };
}

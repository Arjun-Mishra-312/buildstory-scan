import { canonicalJson, compareStrings, shortHash } from "../canonical-json.js";
import {
  EVENT_SPINE_VERSION,
  type BuildEvent,
  type BuildEventKind,
  type BuildEventPhase,
  type EvidenceReference,
  type EventSpine,
  type Milestone,
  type SessionSummary,
} from "../contract.js";

const LABELS: Record<BuildEventKind, string> = {
  "session-start": "Session opened",
  planning: "Plan-first work",
  "model-shift": "Model context changed",
  exploration: "Exploration tools observed",
  mutation: "Build tools observed",
  verification: "Verification tools observed",
  delegation: "Subagent work delegated",
  "session-outcome": "Session closed",
  "repository-milestone": "Repository milestone",
};

const VERIFY_TOOL = /(?:test|lint|typecheck|check|verify|build|pytest|vitest|jest|playwright|cypress)/i;
const MUTATE_TOOL = /(?:edit|write|patch|apply|replace|create|delete|move|rename|format)/i;

function phaseFor(kind: BuildEventKind): BuildEventPhase {
  if (kind === "session-start" || kind === "exploration") return "discover";
  if (kind === "planning" || kind === "model-shift" || kind === "mutation") return "decide";
  return "deliver";
}

function interpolate(start: string, end: string, position: number): string {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return start;
  return new Date(startMs + Math.round((endMs - startMs) * position)).toISOString();
}

function createEvent(input: Omit<BuildEvent, "eventId" | "label" | "phase" | "privacy">): BuildEvent {
  const stable = canonicalJson(input);
  return {
    eventId: `evt_${shortHash(stable, 20)}`,
    ...input,
    label: LABELS[input.kind],
    phase: phaseFor(input.kind),
    privacy: "metadata-only",
  };
}

function toolKinds(session: SessionSummary): Array<{ kind: "exploration" | "mutation" | "verification"; count: number }> {
  if (session.toolCalls === 0) return [];
  const verification = session.toolRefs.filter((tool) => VERIFY_TOOL.test(tool)).length;
  const mutation = session.toolRefs.filter((tool) => MUTATE_TOOL.test(tool) && !VERIFY_TOOL.test(tool)).length;
  const exploration = Math.max(0, session.toolRefs.length - verification - mutation);
  const weighted = [
    { kind: "exploration" as const, count: exploration },
    { kind: "mutation" as const, count: mutation },
    { kind: "verification" as const, count: verification },
  ].filter((item) => item.count > 0);
  if (weighted.length === 0) return [{ kind: "exploration", count: session.toolRefs.length }];
  return weighted;
}

/** Builds a stable chronology without reading or retaining conversation content. */
export function buildEventSpine(input: {
  generatedAt: string;
  sessions: SessionSummary[];
  milestones: Milestone[];
  evidence: EvidenceReference[];
}): EventSpine {
  const evidenceBySession = new Map<string, string[]>();
  for (const item of input.evidence) {
    if (!item.sessionRef) continue;
    const refs = evidenceBySession.get(item.sessionRef) ?? [];
    refs.push(item.evidenceId);
    evidenceBySession.set(item.sessionRef, refs);
  }

  const events: BuildEvent[] = [];
  for (const session of input.sessions) {
    const sourceRefs = (evidenceBySession.get(session.sessionRef) ?? []).sort(compareStrings);
    const base = { sessionRef: session.sessionRef, provider: session.provider, sourceRefs };
    events.push(createEvent({ ...base, occurredAt: session.startedAt, kind: "session-start", magnitude: session.turns, measurement: "turns", temporalPrecision: "exact" }));
    if ((session.planModeTurns ?? 0) > 0) {
      events.push(createEvent({ ...base, occurredAt: interpolate(session.startedAt, session.endedAt, 0.2), kind: "planning", magnitude: session.planModeTurns!, measurement: "turns", temporalPrecision: "estimated" }));
    }
    if (session.modelRefs.length > 1) {
      events.push(createEvent({ ...base, occurredAt: interpolate(session.startedAt, session.endedAt, 0.35), kind: "model-shift", magnitude: session.modelRefs.length, measurement: "models", temporalPrecision: "estimated" }));
    }
    toolKinds(session).forEach((item, index, items) => {
      const position = 0.45 + (index / Math.max(1, items.length - 1)) * 0.3;
      events.push(createEvent({ ...base, occurredAt: interpolate(session.startedAt, session.endedAt, position), kind: item.kind, magnitude: item.count, measurement: "distinct-tools", temporalPrecision: "estimated" }));
    });
    if ((session.subagentInvocations ?? 0) > 0) {
      events.push(createEvent({ ...base, occurredAt: interpolate(session.startedAt, session.endedAt, 0.8), kind: "delegation", magnitude: session.subagentInvocations!, measurement: "invocations", temporalPrecision: "estimated" }));
    }
    events.push(createEvent({ ...base, occurredAt: session.endedAt, kind: "session-outcome", magnitude: session.status === "completed" ? 1 : 0, measurement: "status", temporalPrecision: "exact" }));
  }

  for (const milestone of input.milestones) {
    if (milestone.kind !== "repository-activity") continue;
    events.push(createEvent({
      occurredAt: milestone.occurredAt,
      kind: "repository-milestone",
      provider: "git",
      magnitude: 1,
      measurement: "milestone",
      temporalPrecision: "exact",
      sourceRefs: [...milestone.evidenceRefs].sort(compareStrings),
    }));
  }

  events.sort((left, right) =>
    compareStrings(left.occurredAt, right.occurredAt) ||
    compareStrings(left.eventId, right.eventId));

  return {
    version: EVENT_SPINE_VERSION,
    generatedAt: input.generatedAt,
    events,
    coverage: { sessions: input.sessions.length, milestones: input.milestones.length, events: events.length },
  };
}

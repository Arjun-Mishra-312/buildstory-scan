import type {
  GeneratedNarrativeSections,
  ProjectSnapshot,
  ReportStoryPackV2,
  StoryPackPhase,
  StoryPackSource,
} from "../contract.js";
import type { BuilderProfile } from "../insights/profile.js";
import type { Redactor } from "../redaction.js";

const LIMITS = {
  headline: 120,
  summary: 480,
  arcHeadline: 100,
  arcSummary: 260,
  title: 120,
  body: 400,
  shortBody: 300,
};

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function refs(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && allowed.has(item)))].slice(0, 4);
}

function sourceCatalog(snapshot: ProjectSnapshot): StoryPackSource[] {
  const evidenceBySession = new Map<string, string[]>();
  for (const evidence of snapshot.evidence) {
    if (!evidence.sessionRef) continue;
    const current = evidenceBySession.get(evidence.sessionRef) ?? [];
    current.push(evidence.evidenceId);
    evidenceBySession.set(evidence.sessionRef, current);
  }
  const sessionSources = snapshot.sessions
    .slice()
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.sessionRef.localeCompare(right.sessionRef))
    .map((session, index): StoryPackSource => ({
      ref: `S${String(index + 1).padStart(2, "0")}`,
      provider: session.provider,
      sessionRef: session.sessionRef,
      occurredAt: session.endedAt,
      evidenceRefs: [...new Set(evidenceBySession.get(session.sessionRef) ?? [])].sort(),
      metrics: { turns: session.turns, assistantMessages: session.assistantMessages, toolCalls: session.toolCalls },
    }));
  if (snapshot.git.commits > 0) {
    const gitEvidence = snapshot.evidence.filter((evidence) => evidence.source === "git").map((evidence) => evidence.evidenceId).sort();
    sessionSources.push({
      ref: "GIT",
      provider: "git",
      occurredAt: snapshot.timeWindow.end,
      evidenceRefs: gitEvidence,
      metrics: { turns: 0, assistantMessages: 0, toolCalls: 0 },
    });
  }
  return sessionSources;
}

export function createDefaultStoryPack(snapshot: ProjectSnapshot, profile: BuilderProfile, excerpts: Array<{ sessionRef: string; text?: string }>): ReportStoryPackV2 {
  void excerpts;
  const sources = sourceCatalog(snapshot);
  const sourceRefs = sources.length ? [sources[0]!.ref] : [];
  const phases: Array<{ phase: StoryPackPhase; headline: string; summary: string }> = [
    { phase: "discover", headline: "Mapped the build surface", summary: `${snapshot.sessions.length} repository-scoped sessions established the observed build context.` },
    { phase: "decide", headline: "Turned signals into a path", summary: profile.archetype.rationale.join(" ").slice(0, LIMITS.arcSummary) || "Observed activity was compared as an aggregate signal." },
    { phase: "deliver", headline: "Kept the loop moving", summary: `${snapshot.git.commits} commits and ${snapshot.usage.totalToolCalls} tool calls mark the recorded delivery cadence.` },
  ];
  return {
    version: "2.0.0",
    sources,
    hero: { headline: profile.archetype.name, summary: `A content-free report of ${snapshot.sessions.length} sessions and ${snapshot.git.commits} commits in the selected window.` },
    buildArc: phases.map((item) => ({ ...item, sourceRefs })),
    moments: phases.map((item, index) => ({
      phase: item.phase,
      kind: item.phase === "discover" ? "discovery" : item.phase === "decide" ? "decision" : "delivery",
      title: item.headline,
      whatHappened: item.summary,
      whyItMattered: "This is a metric-derived fallback because no validated model-written moment was available.",
      sourceRefs: sources[index]?.ref ? [sources[index]!.ref] : sourceRefs,
    })),
    turningPoint: { quote: "The observed work shifted from exploration toward delivery.", sourceRefs },
    decisions: [
      { title: "Use the observed execution path", rationale: profile.archetype.rationale.join(" ").slice(0, LIMITS.shortBody), outcome: "The report preserves the deterministic evidence trail.", sourceRefs },
      { title: "Keep claims tied to sources", rationale: "Only catalogued sessions and repository aggregates can support a story component.", outcome: "Unsupported references are replaced with metric-derived copy.", sourceRefs },
    ],
    learnings: [
      { title: "Keep evidence close to the claim", detail: "Every story component should resolve to a known session or repository aggregate.", sourceRefs },
      { title: "Treat proxies as signals", detail: "Scores and archetypes describe observed patterns; they are not claims about intent.", sourceRefs },
    ],
    standoutTraits: [
      { title: profile.archetype.name, detail: profile.archetype.rationale.join(" ").slice(0, LIMITS.shortBody), sourceRefs },
      { title: "Evidence-led execution", detail: "The strongest available trait is derived from the recorded activity and its source coverage.", sourceRefs },
    ],
    growthEdge: { title: "Prepare the next decision earlier", observation: "Planning and steering scores are proxies derived from observable session signals.", nextStep: "Review the evidence before treating the profile as a personal conclusion.", sourceRefs },
  };
}

export function sectionsFromStoryPack(pack: ReportStoryPackV2): GeneratedNarrativeSections {
  return {
    headline: pack.hero.headline,
    narrative: pack.hero.summary,
    turningPoint: pack.turningPoint.quote,
    learnings: pack.learnings.map((item) => `${item.title}: ${item.detail}`),
    decisionPatterns: pack.decisions.map((item) => `${item.title}: ${item.rationale} ${item.outcome}`),
    standoutTraits: pack.standoutTraits.map((item) => `${item.title}: ${item.detail}`),
    growthEdge: `${pack.growthEdge.observation} ${pack.growthEdge.nextStep}`,
  };
}

export function sanitizeStoryPack(
  input: unknown,
  fallback: ReportStoryPackV2,
  redactor: Redactor,
): { storyPack: ReportStoryPackV2; fallbacksUsed: string[] } {
  const candidate = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const allowed = new Set(fallback.sources.map((source) => source.ref));
  const fallbacks: string[] = [];
  const clean = (path: string, value: unknown, fallbackValue: string, max: number): string => {
    const valueText = text(value, max);
    const cleaned = valueText ? redactor.cleanExcerpt(valueText, max) : "";
    if (!cleaned) { fallbacks.push(path); return fallbackValue; }
    return cleaned;
  };
  const sourceList = (path: string, value: unknown, fallbackRefs: string[]): string[] => {
    const selected = refs(value, allowed);
    if (!selected.length) { fallbacks.push(path); return fallbackRefs; }
    return selected;
  };
  const hero = candidate.hero && typeof candidate.hero === "object" ? candidate.hero as Record<string, unknown> : {};
  const arcInput = Array.isArray(candidate.buildArc) ? candidate.buildArc : [];
  const arc = (['discover', 'decide', 'deliver'] as const).map((phase) => {
    const item = arcInput.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).phase === phase) as Record<string, unknown> | undefined;
    const fallbackItem = fallback.buildArc.find((value) => value.phase === phase)!;
    return {
      phase,
      headline: clean(`buildArc.${phase}.headline`, item?.headline, fallbackItem.headline, LIMITS.arcHeadline),
      summary: clean(`buildArc.${phase}.summary`, item?.summary, fallbackItem.summary, LIMITS.arcSummary),
      sourceRefs: sourceList(`buildArc.${phase}.sourceRefs`, item?.sourceRefs, fallbackItem.sourceRefs),
    };
  });
  const momentItems = Array.isArray(candidate.moments) ? candidate.moments : [];
  const moments = momentItems.slice(0, 5).flatMap((value, index) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const fallbackItem = fallback.moments[index % fallback.moments.length]!;
    const phase = item.phase === "discover" || item.phase === "decide" || item.phase === "deliver" ? item.phase : fallbackItem.phase;
    const kind = item.kind === "discovery" || item.kind === "decision" || item.kind === "breakthrough" || item.kind === "delivery" ? item.kind : fallbackItem.kind;
    const sourceRefs = sourceList(`moments.${index}.sourceRefs`, item.sourceRefs, fallbackItem.sourceRefs);
    return [{
      phase, kind,
      title: clean(`moments.${index}.title`, item.title, fallbackItem.title, LIMITS.title),
      whatHappened: clean(`moments.${index}.whatHappened`, item.whatHappened, fallbackItem.whatHappened, LIMITS.body),
      whyItMattered: clean(`moments.${index}.whyItMattered`, item.whyItMattered, fallbackItem.whyItMattered, LIMITS.body),
      sourceRefs,
    }];
  });
  if (moments.length < 3) { fallbacks.push("moments"); moments.push(...fallback.moments.slice(moments.length, 3)); }
  const parseList = (path: string, value: unknown, fallbackItems: Array<{ title: string; detail: string; sourceRefs: string[] }>, maxItems: number) => {
    const items = Array.isArray(value) ? value.slice(0, maxItems).flatMap((raw, index) => {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const fallbackItem = fallbackItems[index % fallbackItems.length]!;
      return [{
        title: clean(`${path}.${index}.title`, item.title, fallbackItem.title, LIMITS.title),
        detail: clean(`${path}.${index}.detail`, item.detail, fallbackItem.detail, LIMITS.shortBody),
        sourceRefs: sourceList(`${path}.${index}.sourceRefs`, item.sourceRefs, fallbackItem.sourceRefs),
      }];
    }) : [];
    if (items.length < 2) { fallbacks.push(path); return fallbackItems.slice(0, 2); }
    return items;
  };
  const decisionsInput = Array.isArray(candidate.decisions) ? candidate.decisions : [];
  const decisions = decisionsInput.slice(0, 4).flatMap((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const fallbackItem = fallback.decisions[index % fallback.decisions.length]!;
    return [{
      title: clean(`decisions.${index}.title`, item.title, fallbackItem.title, LIMITS.title),
      rationale: clean(`decisions.${index}.rationale`, item.rationale, fallbackItem.rationale, LIMITS.shortBody),
      outcome: clean(`decisions.${index}.outcome`, item.outcome, fallbackItem.outcome, LIMITS.shortBody),
      sourceRefs: sourceList(`decisions.${index}.sourceRefs`, item.sourceRefs, fallbackItem.sourceRefs),
    }];
  });
  if (decisions.length < 2) { fallbacks.push("decisions"); decisions.push(...fallback.decisions.slice(decisions.length, 2)); }
  const turning = candidate.turningPoint && typeof candidate.turningPoint === "object" ? candidate.turningPoint as Record<string, unknown> : {};
  const growth = candidate.growthEdge && typeof candidate.growthEdge === "object" ? candidate.growthEdge as Record<string, unknown> : {};
  const fallbackGrowth = fallback.growthEdge;
  const storyPack: ReportStoryPackV2 = {
    version: "2.0.0",
    sources: fallback.sources,
    hero: {
      headline: clean("hero.headline", hero.headline, fallback.hero.headline, LIMITS.headline),
      summary: clean("hero.summary", hero.summary, fallback.hero.summary, LIMITS.summary),
    },
    buildArc: arc,
    moments,
    turningPoint: { quote: clean("turningPoint.quote", turning.quote, fallback.turningPoint.quote, LIMITS.shortBody), sourceRefs: sourceList("turningPoint.sourceRefs", turning.sourceRefs, fallback.turningPoint.sourceRefs) },
    decisions,
    learnings: parseList("learnings", candidate.learnings, fallback.learnings, 4),
    standoutTraits: parseList("standoutTraits", candidate.standoutTraits, fallback.standoutTraits, 4),
    growthEdge: {
      title: clean("growthEdge.title", growth.title, fallbackGrowth.title, LIMITS.title),
      observation: clean("growthEdge.observation", growth.observation, fallbackGrowth.observation, LIMITS.body),
      nextStep: clean("growthEdge.nextStep", growth.nextStep, fallbackGrowth.nextStep, LIMITS.shortBody),
      sourceRefs: sourceList("growthEdge.sourceRefs", growth.sourceRefs, fallbackGrowth.sourceRefs),
    },
  };
  return { storyPack, fallbacksUsed: [...new Set(fallbacks)].sort() };
}

export function buildStoryPackSources(snapshot: ProjectSnapshot, excerpts: Array<{ sessionRef: string }>): StoryPackSource[] {
  void excerpts;
  return sourceCatalog(snapshot);
}

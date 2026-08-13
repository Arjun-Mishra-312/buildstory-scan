import type {
  GeneratedNarrativeSections,
  ProjectSnapshot,
  ReportStoryPack,
  ReportStoryPackV2,
  ReportStoryPackV3,
  StoryPackFinding,
  StoryPackPhase,
  StoryPackSignalFinding,
  StoryPackSource,
} from "../contract.js";
import type { BuilderProfile } from "../insights/profile.js";
import { computeSignals } from "../insights/signals.js";
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

const SOURCE_REFS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 4,
  items: { type: "string", minLength: 1, maxLength: 40 },
} as const;

export const STORY_PACK_STORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hero", "buildArc", "moments", "turningPoint"],
  properties: {
    hero: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "summary"],
      properties: {
        headline: { type: "string", minLength: 1, maxLength: LIMITS.headline },
        summary: { type: "string", minLength: 1, maxLength: LIMITS.summary },
      },
    },
    buildArc: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "headline", "summary", "sourceRefs"],
        properties: {
          phase: { enum: ["discover", "decide", "deliver"] },
          headline: { type: "string", minLength: 1, maxLength: LIMITS.arcHeadline },
          summary: { type: "string", minLength: 1, maxLength: LIMITS.arcSummary },
          sourceRefs: SOURCE_REFS_SCHEMA,
        },
      },
    },
    moments: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "kind", "title", "whatHappened", "whyItMattered", "sourceRefs"],
        properties: {
          phase: { enum: ["discover", "decide", "deliver"] },
          kind: { enum: ["discovery", "decision", "breakthrough", "delivery"] },
          title: { type: "string", minLength: 1, maxLength: LIMITS.title },
          whatHappened: { type: "string", minLength: 1, maxLength: LIMITS.body },
          whyItMattered: { type: "string", minLength: 1, maxLength: LIMITS.body },
          sourceRefs: SOURCE_REFS_SCHEMA,
        },
      },
    },
    turningPoint: {
      type: "object",
      additionalProperties: false,
      required: ["quote", "sourceRefs"],
      properties: {
        quote: { type: "string", minLength: 1, maxLength: LIMITS.shortBody },
        sourceRefs: SOURCE_REFS_SCHEMA,
      },
    },
  },
} as const;

export const STORY_PACK_INSIGHTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions", "learnings", "standoutTraits", "growthEdge"],
  properties: {
    decisions: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "rationale", "outcome", "sourceRefs"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: LIMITS.title },
          rationale: { type: "string", minLength: 1, maxLength: LIMITS.shortBody },
          outcome: { type: "string", minLength: 1, maxLength: LIMITS.shortBody },
          sourceRefs: SOURCE_REFS_SCHEMA,
        },
      },
    },
    learnings: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "sourceRefs"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: LIMITS.title },
          detail: { type: "string", minLength: 1, maxLength: LIMITS.shortBody },
          sourceRefs: SOURCE_REFS_SCHEMA,
        },
      },
    },
    standoutTraits: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "sourceRefs"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: LIMITS.title },
          detail: { type: "string", minLength: 1, maxLength: LIMITS.shortBody },
          sourceRefs: SOURCE_REFS_SCHEMA,
        },
      },
    },
    // nextStep is deliberately absent - see the matching comment in the web
    // package's lib/narrative/story-pack.ts.
    growthEdge: {
      type: "object",
      additionalProperties: false,
      required: ["title", "observation", "sourceRefs"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: LIMITS.title },
        observation: { type: "string", minLength: 1, maxLength: LIMITS.body },
        sourceRefs: SOURCE_REFS_SCHEMA,
      },
    },
  },
} as const;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function refs(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && allowed.has(item)))].slice(0, 4);
}

export type StoryPackComponent = "story" | "insights";

export type StoryPackValidation = { ok: boolean; errors: string[] };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringIssue(value: unknown, path: string, min: number, max: number): string | null {
  if (typeof value !== "string") return `${path} must be a string.`;
  const length = value.trim().length;
  if (length < min) return `${path} must contain at least ${min} character${min === 1 ? "" : "s"}.`;
  if (length > max) return `${path} must contain at most ${max} characters.`;
  return null;
}

function listIssues(value: unknown, path: string, min: number, max: number): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array.`];
  return [
    ...(value.length < min ? [`${path} must contain at least ${min} items.`] : []),
    ...(value.length > max ? [`${path} must contain at most ${max} items.`] : []),
  ];
}

function refIssues(value: unknown, path: string, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array.`];
  const errors: string[] = [];
  if (allowed.size > 0 && value.length < 1) errors.push(`${path} must contain at least one source reference.`);
  if (value.length > 4) errors.push(`${path} must contain at most four source references.`);
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) errors.push(`${path}[${index}] must be a non-empty string.`);
    else if (!allowed.has(item)) errors.push(`${path}[${index}] references unknown source ${item}.`);
    else if (seen.has(item)) errors.push(`${path}[${index}] duplicates source ${item}.`);
    else seen.add(item);
  });
  return errors;
}

export function validateStoryPackComponent(value: unknown, component: StoryPackComponent, allowedRefs: Set<string>, options: { allowMissingStandoutTraits?: boolean } = {}): StoryPackValidation {
  const candidate = objectValue(value);
  if (!candidate) return { ok: false, errors: ["response must be a JSON object."] };
  // Older local models may still answer with the flat V1 keys. The caller
  // normalizes that compatibility shape into V2 and records any replacements.
  if (component === "story" && !candidate.hero && ("headline" in candidate || "narrative" in candidate || typeof candidate.turningPoint === "string")) return { ok: true, errors: [] };
  if (component === "insights" && !candidate.decisions && ("decisionPatterns" in candidate || "standoutTraits" in candidate || typeof candidate.growthEdge === "string")) return { ok: true, errors: [] };
  const errors: string[] = [];
  if (component === "story") {
    const hero = objectValue(candidate.hero);
    if (!hero) errors.push("hero must be an object.");
    else {
      const headline = stringIssue(hero.headline, "hero.headline", 1, LIMITS.headline); if (headline) errors.push(headline);
      const summary = stringIssue(hero.summary, "hero.summary", 1, LIMITS.summary); if (summary) errors.push(summary);
    }
    errors.push(...listIssues(candidate.buildArc, "buildArc", 3, 3));
    if (Array.isArray(candidate.buildArc)) {
      const phases = candidate.buildArc.map((entry) => objectValue(entry)?.phase);
      if (new Set(phases).size !== 3 || !(["discover", "decide", "deliver"] as const).every((phase) => phases.includes(phase))) errors.push("buildArc must contain exactly one discover, decide, and deliver phase.");
      candidate.buildArc.forEach((entry, index) => {
        const item = objectValue(entry); const path = `buildArc[${index}]`;
        if (!item) { errors.push(`${path} must be an object.`); return; }
        if (!["discover", "decide", "deliver"].includes(String(item.phase))) errors.push(`${path}.phase is unsupported.`);
        const headline = stringIssue(item.headline, `${path}.headline`, 1, LIMITS.arcHeadline); if (headline) errors.push(headline);
        const summary = stringIssue(item.summary, `${path}.summary`, 1, LIMITS.arcSummary); if (summary) errors.push(summary);
        errors.push(...refIssues(item.sourceRefs, `${path}.sourceRefs`, allowedRefs));
      });
    }
    errors.push(...listIssues(candidate.moments, "moments", 3, 5));
    if (Array.isArray(candidate.moments)) candidate.moments.forEach((entry, index) => {
      const item = objectValue(entry); const path = `moments[${index}]`;
      if (!item) { errors.push(`${path} must be an object.`); return; }
      if (!["discover", "decide", "deliver"].includes(String(item.phase))) errors.push(`${path}.phase is unsupported.`);
      if (!["discovery", "decision", "breakthrough", "delivery"].includes(String(item.kind))) errors.push(`${path}.kind is unsupported.`);
      for (const [key, max] of [["title", LIMITS.title], ["whatHappened", LIMITS.body], ["whyItMattered", LIMITS.body]] as const) { const issue = stringIssue(item[key], `${path}.${key}`, 1, max); if (issue) errors.push(issue); }
      errors.push(...refIssues(item.sourceRefs, `${path}.sourceRefs`, allowedRefs));
    });
    const turning = objectValue(candidate.turningPoint);
    if (!turning) errors.push("turningPoint must be an object.");
    else { const quote = stringIssue(turning.quote, "turningPoint.quote", 1, LIMITS.shortBody); if (quote) errors.push(quote); errors.push(...refIssues(turning.sourceRefs, "turningPoint.sourceRefs", allowedRefs)); }
  } else {
    errors.push(...listIssues(candidate.decisions, "decisions", 2, 4));
    if (Array.isArray(candidate.decisions)) candidate.decisions.forEach((entry, index) => {
      const item = objectValue(entry); const path = `decisions[${index}]`;
      if (!item) { errors.push(`${path} must be an object.`); return; }
      for (const [key, max] of [["title", LIMITS.title], ["rationale", LIMITS.shortBody], ["outcome", LIMITS.shortBody]] as const) { const issue = stringIssue(item[key], `${path}.${key}`, 1, max); if (issue) errors.push(issue); }
      errors.push(...refIssues(item.sourceRefs, `${path}.sourceRefs`, allowedRefs));
    });
    for (const name of ["learnings", "standoutTraits"] as const) {
      if (name === "standoutTraits" && options.allowMissingStandoutTraits && candidate[name] === undefined) continue;
      errors.push(...listIssues(candidate[name], name, 2, 4));
      if (Array.isArray(candidate[name])) candidate[name].forEach((entry, index) => {
        const item = objectValue(entry); const path = `${name}[${index}]`;
        if (!item) { errors.push(`${path} must be an object.`); return; }
        const title = stringIssue(item.title, `${path}.title`, 1, LIMITS.title); if (title) errors.push(title);
        const detail = stringIssue(item.detail, `${path}.detail`, 1, LIMITS.shortBody); if (detail) errors.push(detail);
        errors.push(...refIssues(item.sourceRefs, `${path}.sourceRefs`, allowedRefs));
      });
    }
    const growth = objectValue(candidate.growthEdge);
    if (!growth) errors.push("growthEdge must be an object.");
    else { for (const [key, max] of [["title", LIMITS.title], ["observation", LIMITS.body]] as const) { const issue = stringIssue(growth[key], `growthEdge.${key}`, 1, max); if (issue) errors.push(issue); } errors.push(...refIssues(growth.sourceRefs, "growthEdge.sourceRefs", allowedRefs)); }
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 20) };
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
  const signals = computeSignals({ sessions: snapshot.sessions, usage: snapshot.usage, git: snapshot.git, timeWindow: snapshot.timeWindow, narrativeEvidence: snapshot.narrativeEvidence, sources });
  const phases: Array<{ phase: StoryPackPhase; headline: string; summary: string }> = [
    { phase: "discover", headline: "Mapped the build surface", summary: `${snapshot.sessions.length} repository-scoped sessions established the observed build context.` },
    { phase: "decide", headline: "Turned signals into a path", summary: profile.archetype.rationale.join(" ").slice(0, LIMITS.arcSummary) || "Observed activity was compared as an aggregate signal." },
    { phase: "deliver", headline: "Kept the loop moving", summary: `${snapshot.git.commits} commits and ${snapshot.usage.totalToolCalls} tool calls mark the recorded delivery cadence.` },
  ];
  return {
    version: "2.0.0",
    sources,
    signals,
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
    growthEdge: { title: "Prepare the next decision earlier", observation: "Planning and steering scores are proxies derived from observable session signals.", sourceRefs },
  };
}

export function sectionsFromStoryPack(pack: ReportStoryPack): GeneratedNarrativeSections {
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
): { storyPack: ReportStoryPack; fallbacksUsed: string[] } {
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
  const moments = momentItems.slice(0, candidate.version === "3.0.0" ? 12 : 5).flatMap((value, index) => {
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
    signals: fallback.signals,
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
      sourceRefs: sourceList("growthEdge.sourceRefs", growth.sourceRefs, fallbackGrowth.sourceRefs),
    },
  };
  const deep = candidate.version === "3.0.0" && candidate.deepAnalysis && typeof candidate.deepAnalysis === "object" && !Array.isArray(candidate.deepAnalysis)
    ? candidate.deepAnalysis as Record<string, unknown>
    : null;
  if (!deep) return { storyPack, fallbacksUsed: [...new Set(fallbacks)].sort() };

  const finding = (path: string, value: unknown, fallbackTitle = "Evidence-bound observation", fallbackSummary = "The reviewed evidence supports only a cautious conclusion."): StoryPackFinding => {
    const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      title: clean(`${path}.title`, item.title, fallbackTitle, LIMITS.title),
      summary: clean(`${path}.summary`, item.summary, fallbackSummary, 600),
      sourceRefs: sourceList(`${path}.sourceRefs`, item.sourceRefs, fallback.sources[0]?.ref ? [fallback.sources[0].ref] : []),
      confidence: item.confidence === "high" || item.confidence === "medium" ? item.confidence : "low",
    };
  };
  const findings = (path: string, value: unknown, max: number): StoryPackFinding[] => Array.isArray(value)
    ? value.slice(0, max).map((item, index) => finding(`${path}.${index}`, item))
    : [];
  const allowedSignalIds = new Set(fallback.signals.map((signal) => signal.id));
  const fallbackSignalId = fallback.signals[0]?.id;
  const byTheNumbers: StoryPackSignalFinding[] = Array.isArray(deep.byTheNumbers)
    ? deep.byTheNumbers.slice(0, 8).flatMap((value, index) => {
        const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const path = `deepAnalysis.byTheNumbers.${index}`;
        const signalId = typeof item.signalId === "string" && allowedSignalIds.has(item.signalId) ? item.signalId : fallbackSignalId;
        if (signalId !== item.signalId) fallbacks.push(`${path}.signalId`);
        // No computed signal at all (an evidence-thin snapshot) means there
        // is nothing for this finding to attach to - drop it rather than
        // fabricate an id.
        if (!signalId) return [];
        return [{ ...finding(path, value), signalId }];
      })
    : [];
  const coverageValue = deep.coverage && typeof deep.coverage === "object" && !Array.isArray(deep.coverage) ? deep.coverage as Record<string, unknown> : {};
  const boundedCount = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) ? Math.max(0, Math.min(max, value)) : 0;
  const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "1970-01-01T00:00:00.000Z";
  const deepPack: ReportStoryPackV3 = {
    ...storyPack,
    version: "3.0.0",
    analysisTier: "deep",
    deepAnalysis: {
      openingLine: finding("deepAnalysis.openingLine", deep.openingLine),
      signatureMoves: findings("deepAnalysis.signatureMoves", deep.signatureMoves, 6),
      byTheNumbers,
      whereItGotHard: findings("deepAnalysis.whereItGotHard", deep.whereItGotHard, 6),
      chapterChanges: findings("deepAnalysis.chapterChanges", deep.chapterChanges, 5),
      coverage: {
        sessionsSeen: boundedCount(coverageValue.sessionsSeen, 100_000),
        excerptsUsed: boundedCount(coverageValue.excerptsUsed, 400),
        evidenceBytes: boundedCount(coverageValue.evidenceBytes, 700 * 1024),
        windowStart: iso(coverageValue.windowStart),
        windowEnd: iso(coverageValue.windowEnd),
      },
    },
  };
  return { storyPack: deepPack, fallbacksUsed: [...new Set(fallbacks)].sort() };
}

export function buildStoryPackSources(snapshot: ProjectSnapshot, excerpts: Array<{ sessionRef: string }>): StoryPackSource[] {
  void excerpts;
  return sourceCatalog(snapshot);
}

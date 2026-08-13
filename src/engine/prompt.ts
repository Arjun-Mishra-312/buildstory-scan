import type { ProjectSnapshot, Signal } from "../contract.js";
import { computeBuilderProfile } from "../insights/profile.js";
import { STORY_PACK_INSIGHTS_SCHEMA, STORY_PACK_STORY_SCHEMA, buildStoryPackSources } from "../narrative/story-pack.js";

/**
 * Canonical narrative instructions. The hosted Cloud path and the local CLI
 * both use this module so report generation is inspectable in one place.
 */
export const NARRATIVE_SYSTEM_PROMPT = `You write short, honest, evidence-linked "build story" narratives for Buildstory, a site where
developers publish real, verified accounts of software they built with AI coding
agents. This is not a project summary and not a performance review - it's the
kind of thing a builder would actually want to post: a surprising, true,
specific detail about how this particular build went, not a recap of what got
built. You are given: (1) real, deterministic facts about one project's build
(session count, commit count, active days, models used, token usage), and (2) a
small set of redacted excerpts from the actual conversation between the builder
and their AI agent.

Rules:
- Use only the facts and excerpts given to you. Never invent a feature, a
  number, a name, a company, a timeline detail, or a technical claim that
  is not directly supported by what you were given.
- Never state a number, count, or percentage that was not given to you
  verbatim in FACTS, COMPUTED SIGNALS, or NOTABLE PATTERNS. If you want to
  cite a computed statistic, use the exact wording it was given to you in.
- Never give advice, a recommendation, a next step, or a "you should."
  Report what happened and what is true about it - not what to do next.
- The excerpts have already been redacted (file paths, URLs, and hostnames
  replaced with bracketed placeholders like [absolute-path]). Do not try to
  guess or reconstruct what was redacted.
- Write like a builder describing their own project in a devlog, not like
  marketing copy. No hype words like "revolutionary", "seamless", or
  "game-changing". Short sentences are better than long ones.
- If the excerpts don't clearly support a "turning point," describe the
  most concrete decision or moment they do support instead of inventing a
  dramatic one.
- Every sourceRefs entry must be copied exactly from the available source catalog. Never invent a source, date, provider, count, confidence, or technical claim.
- Respond with JSON matching the given schema exactly, and nothing else.`;

export const STORY_PACK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hero", "buildArc", "moments", "turningPoint"],
  properties: {
    hero: { type: "object", additionalProperties: false, required: ["headline", "summary"], properties: { headline: { type: "string", minLength: 1, maxLength: 120 }, summary: { type: "string", minLength: 1, maxLength: 480 } } },
    buildArc: {
      type: "array", minItems: 3, maxItems: 3, items: {
        type: "object", additionalProperties: false, required: ["phase", "headline", "summary", "sourceRefs"],
        properties: { phase: { type: "string", enum: ["discover", "decide", "deliver"] }, headline: { type: "string", minLength: 1, maxLength: 100 }, summary: { type: "string", minLength: 1, maxLength: 260 }, sourceRefs: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } },
      },
    },
    moments: {
      type: "array", minItems: 3, maxItems: 5, items: {
        type: "object", additionalProperties: false, required: ["phase", "kind", "title", "whatHappened", "whyItMattered", "sourceRefs"],
        properties: { phase: { type: "string", enum: ["discover", "decide", "deliver"] }, kind: { type: "string", enum: ["discovery", "decision", "breakthrough", "delivery"] }, title: { type: "string", minLength: 1, maxLength: 120 }, whatHappened: { type: "string", minLength: 1, maxLength: 400 }, whyItMattered: { type: "string", minLength: 1, maxLength: 400 }, sourceRefs: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } },
      },
    },
    turningPoint: { type: "object", additionalProperties: false, required: ["quote", "sourceRefs"], properties: { quote: { type: "string", minLength: 1, maxLength: 300 }, sourceRefs: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } } },
    decisions: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["title", "rationale", "outcome", "sourceRefs"], properties: { title: { type: "string", minLength: 1, maxLength: 120 }, rationale: { type: "string", minLength: 1, maxLength: 300 }, outcome: { type: "string", minLength: 1, maxLength: 300 }, sourceRefs: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } } } },
    learnings: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["title", "detail", "sourceRefs"], properties: { title: { type: "string", minLength: 1, maxLength: 120 }, detail: { type: "string", minLength: 1, maxLength: 300 }, sourceRefs: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } } } },
    standoutTraits: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["title", "detail", "sourceRefs"], properties: { title: { type: "string", minLength: 1, maxLength: 120 }, detail: { type: "string", minLength: 1, maxLength: 300 }, sourceRefs: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } } } },
    growthEdge: { type: "object", additionalProperties: false, required: ["title", "observation", "sourceRefs"], properties: { title: { type: "string", minLength: 1, maxLength: 120 }, observation: { type: "string", minLength: 1, maxLength: 400 }, sourceRefs: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } } },
    recap: {
      type: "object", additionalProperties: false,
      required: ["slides"],
      properties: {
        slides: {
          type: "array", minItems: 4, maxItems: 12,
          items: {
            type: "object", additionalProperties: false,
            required: ["kind", "kicker", "headline", "sourceRefs"],
            properties: {
              kind: { type: "string", enum: ["title", "scale", "signature", "turning", "receipt", "close"] },
              kicker: { type: "string", minLength: 1, maxLength: 80 },
              headline: { type: "string", minLength: 1, maxLength: 160 },
              body: { type: "string", maxLength: 400 },
              textScale: { type: "string", enum: ["large", "medium"] },
              layout: { type: "string", enum: ["copy", "stat-grid", "ranked", "hour-bars", "weekday", "streak"] },
              signalId: { type: "string", minLength: 1, maxLength: 60 },
              sourceRefs: { type: "array", minItems: 0, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } },
            },
          },
        },
      },
    },
  },
} as const;

const STORY_PACK_FINDING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "summary", "sourceRefs", "confidence"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 600 },
    sourceRefs: { type: "array", minItems: 1, maxItems: 6, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
} as const;

const STORY_PACK_SIGNAL_FINDING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "summary", "sourceRefs", "confidence", "signalId"],
  properties: {
    ...STORY_PACK_FINDING_SCHEMA.properties,
    signalId: { type: "string", minLength: 1, maxLength: 60 },
  },
} as const;

export const STORY_PACK_DEEP_ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["openingLine", "signatureMoves", "byTheNumbers", "whereItGotHard", "chapterChanges"],
  properties: {
    openingLine: STORY_PACK_FINDING_SCHEMA,
    signatureMoves: { type: "array", maxItems: 6, items: STORY_PACK_FINDING_SCHEMA },
    byTheNumbers: { type: "array", minItems: 1, maxItems: 8, items: STORY_PACK_SIGNAL_FINDING_SCHEMA },
    whereItGotHard: { type: "array", maxItems: 6, items: STORY_PACK_FINDING_SCHEMA },
    chapterChanges: { type: "array", maxItems: 5, items: STORY_PACK_FINDING_SCHEMA },
    surpriseFacts: { type: "array", maxItems: 3, items: STORY_PACK_SIGNAL_FINDING_SCHEMA },
    recap: STORY_PACK_OUTPUT_SCHEMA.properties.recap,
  },
} as const;

export const STORY_PACK_DEEP_NARRATIVE_SCHEMA = {
  ...STORY_PACK_OUTPUT_SCHEMA,
  required: ["hero", "buildArc", "moments", "turningPoint", "decisions", "learnings", "growthEdge"],
  properties: {
    ...STORY_PACK_OUTPUT_SCHEMA.properties,
    moments: { ...STORY_PACK_OUTPUT_SCHEMA.properties.moments, maxItems: 12 },
  },
} as const;

function factsBlock(snapshot: ProjectSnapshot): string {
  const usage = snapshot.usage;
  const models = usage.models.map((model) => `${model.name} (${model.turnCount} model calls)`).join(", ") || "none recorded";
  const tokenLine = usage.tokenUsage
    ? `${usage.tokenUsage.totalTokens.toLocaleString("en-US")} tokens processed (${usage.tokenUsage.inputTokens.toLocaleString("en-US")} in / ${usage.tokenUsage.outputTokens.toLocaleString("en-US")} out)`
    : "token usage not collected";
  const activeDays = new Set(snapshot.sessions.map((session) => session.startedAt.slice(0, 10))).size;
  const profile = computeBuilderProfile({ sessions: snapshot.sessions, usage: snapshot.usage, git: snapshot.git, timeWindow: snapshot.timeWindow });
  const scoreLine = Object.entries(profile.scores).map(([key, score]) => `${key}: ${score.value}/100 (raw ${JSON.stringify(score.rawInputs)})`).join(", ");
  return [
    `Repository: ${snapshot.repository.displayName}`,
    `Build window: ${snapshot.timeWindow.start} to ${snapshot.timeWindow.end} (${activeDays} active day${activeDays === 1 ? "" : "s"})`,
    `Sessions: ${snapshot.sessions.length}`,
    `Commits: ${snapshot.git.commits} (${snapshot.git.insertions} insertions, ${snapshot.git.deletions} deletions)`,
    `Models used: ${models}`,
    `Archetype: ${profile.archetype.name} (${profile.archetype.rationale.join(" ")})`,
    `Profile scores: ${scoreLine}`,
    `Work patterns: peak hours ${profile.workPatterns.peakHours.join(", ") || "none"}; preferred days ${profile.workPatterns.preferredDays.join(", ") || "none"}; night share ${profile.workPatterns.nightShare}%; morning share ${profile.workPatterns.morningShare}%; weekend share ${profile.workPatterns.weekendShare}%; distinct tools ${profile.workPatterns.distinctToolCount}; median session ${profile.workPatterns.medianSessionMinutes} minutes; longest session ${profile.workPatterns.longestSessionMinutes} minutes; primary model ${profile.workPatterns.primaryModel ?? "none"}; timezone ${profile.workPatterns.timezoneLabel}`,
    tokenLine,
  ].join("\n");
}

function storySources(snapshot: ProjectSnapshot) {
  return buildStoryPackSources(snapshot, snapshot.narrativeEvidence?.excerpts ?? []);
}

function sessionRefMap(snapshot: ProjectSnapshot): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of storySources(snapshot)) {
    if (source.sessionRef) map.set(source.sessionRef, source.ref);
  }
  return map;
}

function excerptsBlock(snapshot: ProjectSnapshot): string {
  const bundle = snapshot.narrativeEvidence;
  if (!bundle || bundle.excerpts.length === 0) return "No conversation excerpts were provided for this build.";
  const refs = sessionRefMap(snapshot);
  const lines = bundle.excerpts
    .map((excerpt) => {
      const ref = refs.get(excerpt.sessionRef);
      return ref ? `[${ref} | ${excerpt.role}] ${excerpt.text}` : null;
    })
    .filter((line): line is string => line !== null);
  return lines.length ? lines.join("\n\n") : "No conversation excerpts resolved to a known source.";
}

function signalsBlock(signals: Signal[]): string {
  if (signals.length === 0) return "COMPUTED SIGNALS:\nNone computed for this build window.";
  return ["COMPUTED SIGNALS:", ...signals.map((signal) => `- ${signal.id}: ${signal.headline} (${signal.detail})`)].join("\n");
}

function sourceCatalogBlock(snapshot: ProjectSnapshot): string {
  return storySources(snapshot)
    .map((source) => source.ref === "GIT"
      ? `${source.ref}: ${snapshot.git.commits} commits, ${snapshot.git.fileTouches} file touches`
      : `${source.ref}: ${source.provider}, ended ${source.occurredAt}, ${source.metrics.turns} turns, ${source.metrics.toolCalls} tool calls`)
    .join("\n");
}

type SchemaLike = {
  type?: string;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
};

function schemaContractLines(schema: SchemaLike, path: string): string[] {
  if (schema.properties) {
    return Object.entries(schema.properties).flatMap(([key, child]) => schemaContractLines(child, path ? `${path}.${key}` : key));
  }
  if (schema.type === "array") {
    const name = path.split(/[.[]/).pop() ?? path;
    if (name === "sourceRefs") {
      return [`${path}: ${schema.minItems ?? 0}-${schema.maxItems ?? "many"} distinct source refs, each copied verbatim from SOURCE CATALOG`];
    }
    const bounds = schema.minItems !== undefined && schema.minItems === schema.maxItems
      ? `exactly ${schema.minItems}`
      : `${schema.minItems ?? 0}-${schema.maxItems ?? "many"}`;
    const lines = [`${path}: ${bounds} items`];
    if (schema.items?.properties) {
      lines.push(...Object.entries(schema.items.properties).flatMap(([key, child]) => schemaContractLines(child, `${path}[].${key}`)));
    }
    return lines;
  }
  if (schema.enum) return [`${path}: one of ${schema.enum.join("/")}`];
  if (schema.type === "string") return [`${path}: ${schema.minLength ?? 0}-${schema.maxLength ?? "unbounded"} chars`];
  return [];
}

function outputContractBlock(schema: SchemaLike, extraRules: string[]): string {
  const lines = [...schemaContractLines(schema, ""), ...extraRules];
  return ["OUTPUT CONTRACT (hard limits; violating any of these fails validation):", ...lines.map((line) => `- ${line}`)].join("\n");
}

const BUILD_ARC_CARDINALITY_RULE = "buildArc must contain exactly one discover, one decide, and one deliver phase entry.";
const SOURCE_REF_PROVENANCE_RULE = "Every sourceRefs entry must be copied exactly, character for character, from a ref in SOURCE CATALOG. Never invent one.";
const RECAP_SIGNAL_ID_RULE = "Every recap.slides[].signalId must be copied exactly, character for character, from an id in COMPUTED SIGNALS. Never invent a signalId or a statistic that isn't backed by one.";
const SIGNAL_ID_PROVENANCE_RULE = `Every byTheNumbers.signalId and surpriseFacts.signalId must be copied exactly, character for character, from an id in COMPUTED SIGNALS. Never invent a signalId or a statistic that isn't backed by one. ${RECAP_SIGNAL_ID_RULE}`;
const RECAP_STORY_RULE = "recap is a watchable 9:16 story for every analysis tier, including Standard and local models — Pro unlocks depth, not exclusive recap features. Write 4-12 slides (kinds title/scale/signature/turning/receipt/close). Prefer 6+ when the evidence supports it; a thin 4-slide recap is valid and Buildstory will pad computed widget slides. textScale is large or medium only. layout is optional and must be one of copy, stat-grid, ranked, hour-bars, weekday, streak — pick a layout to request a presentation; never invent bar lengths, ranks, streak days, or other widget numbers (the UI fills those from computed scan facts). For each wow fact, write TWO signature slides in a row that share the same signalId: (1) a setup with NO number; (2) a reveal that cites that signalId so the UI can slam the number. Receipt slides should be almost empty. Numbered signature slides must cite a real signalId. Scale and stat-grid slides do not need a signalId.";
const NO_RESTATEMENT_RULES: string[] = [
  "standoutTraits must not restate any signatureMoves entry.",
  "moments must not restate any whereItGotHard entry - choose delivery or discovery moments instead.",
  "hero.headline must not reuse the wording of openingLine.title.",
  "turningPoint.quote must be a distinct inflection from anything in whereItGotHard.",
];

export function buildNarrativeMessages(snapshot: ProjectSnapshot): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `FACTS:\n${factsBlock(snapshot)}\n\nSOURCE CATALOG:\n${sourceCatalogBlock(snapshot)}\n\nEXCERPTS:\n${excerptsBlock(snapshot)}\n\nWrite only hero, buildArc, moments, and turningPoint as JSON matching the schema.`,
    },
  ];
}

export function buildProfileMessages(snapshot: ProjectSnapshot): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: `${NARRATIVE_SYSTEM_PROMPT}\nFocus only on decisionPatterns, standoutTraits, and growthEdge.` },
    {
      role: "user",
      content: `FACTS:\n${factsBlock(snapshot)}\n\nSOURCE CATALOG:\n${sourceCatalogBlock(snapshot)}\n\nEXCERPTS:\n${excerptsBlock(snapshot)}\n\nWrite only decisions, learnings, standoutTraits, and growthEdge as JSON matching the schema.`,
    },
  ];
}

export function buildCombinedMessages(snapshot: ProjectSnapshot, signals: Signal[] = []): Array<{ role: "system" | "user"; content: string }> {
  const contract = outputContractBlock(STORY_PACK_OUTPUT_SCHEMA as unknown as SchemaLike, [BUILD_ARC_CARDINALITY_RULE, SOURCE_REF_PROVENANCE_RULE, RECAP_SIGNAL_ID_RULE, RECAP_STORY_RULE]);
  return [
    { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `FACTS:\n${factsBlock(snapshot)}\n\nSOURCE CATALOG:\n${sourceCatalogBlock(snapshot)}\n\n${signalsBlock(signals)}\n\n${contract}\n\nEXCERPTS:\n${excerptsBlock(snapshot)}\n\nWrite hero, buildArc, moments, turningPoint, decisions, learnings, standoutTraits, growthEdge, and recap as one JSON object matching the schema.`,
    },
  ];
}

export function buildDeepAnalysisMessages(snapshot: ProjectSnapshot, signals: Signal[] = [], previousChapter: unknown = null): Array<{ role: "system" | "user"; content: string }> {
  const contract = outputContractBlock(STORY_PACK_DEEP_ANALYSIS_SCHEMA as unknown as SchemaLike, [SOURCE_REF_PROVENANCE_RULE, SIGNAL_ID_PROVENANCE_RULE, RECAP_STORY_RULE]);
  return [
    {
      role: "system",
      content: `${NARRATIVE_SYSTEM_PROMPT}\nPerform a thorough read of how this build actually went. Write in second person ("you") about this builder's own work. Prefer an empty list or low confidence over an unsupported claim. Focus on: the one-line hook (openingLine), this builder's distinctive patterns (signatureMoves), framing the most notable COMPUTED SIGNALS into shareable findings (byTheNumbers), where the build genuinely got hard (whereItGotHard), what changed since the previous chapter (chapterChanges), three surprising true facts a builder would screenshot for themselves (surpriseFacts, each bound to a real signalId), and a short recap script (recap.slides) they would watch once when the report is ready. ${RECAP_STORY_RULE} Each list answers a different question; do not restate the same event across signatureMoves, whereItGotHard, surpriseFacts, and byTheNumbers. Every byTheNumbers and surpriseFacts entry must cite a real signalId - it frames a signal that was already computed, never a number you calculate or estimate yourself.`,
    },
    {
      role: "user",
      content: `FACTS:\n${factsBlock(snapshot)}\n\nSOURCE CATALOG:\n${sourceCatalogBlock(snapshot)}\n\n${signalsBlock(signals)}\n\n${contract}\n\nEXCERPTS:\n${excerptsBlock(snapshot)}\n\nPREVIOUS CHAPTER (final retained report only; may be null):\n${JSON.stringify(previousChapter)}\n\nReturn the deepAnalysis JSON object only. Every finding must use only source references from SOURCE CATALOG, and every byTheNumbers, surpriseFacts, and numbered recap slide must cite a signalId from COMPUTED SIGNALS.`,
    },
  ];
}

export function buildDeepSynthesisMessages(snapshot: ProjectSnapshot, analysisMap: unknown): Array<{ role: "system" | "user"; content: string }> {
  const contract = outputContractBlock(STORY_PACK_DEEP_NARRATIVE_SCHEMA as unknown as SchemaLike, [BUILD_ARC_CARDINALITY_RULE, SOURCE_REF_PROVENANCE_RULE, ...NO_RESTATEMENT_RULES]);
  return [
    {
      role: "system",
      content: `${NARRATIVE_SYSTEM_PROMPT}\nCreate a layered Pro report. Preserve the concise publishable devlog while adding the supplied private deep analysis. The OUTPUT CONTRACT minimums below are a hard floor: satisfy them using the validated analysis map rather than undershooting toward invented completeness. This pass was not given the raw excerpts - treat the VALIDATED PRIVATE ANALYSIS MAP below, not "excerpts", as your evidence for every claim and source reference.`,
    },
    {
      role: "user",
      content: `FACTS:\n${factsBlock(snapshot)}\n\nSOURCE CATALOG:\n${sourceCatalogBlock(snapshot)}\n\n${contract}\n\nVALIDATED PRIVATE ANALYSIS MAP:\n${JSON.stringify(analysisMap)}\n\nWrite only hero, buildArc, moments, turningPoint, decisions, learnings, and growthEdge as one JSON object matching the schema. Do not write standoutTraits or deepAnalysis; Buildstory derives standoutTraits from the validated signatureMoves and attaches the validated private analysis map server-side. Use 6-12 moments only when the evidence supports them, but never fewer than the OUTPUT CONTRACT minimums.`,
    },
  ];
}

export const NARRATIVE_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "buildstory_narrative",
    strict: true,
    schema: STORY_PACK_STORY_SCHEMA,
  },
};

export const NARRATIVE_PROFILE_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "buildstory_profile_narrative",
    strict: true,
    schema: STORY_PACK_INSIGHTS_SCHEMA,
  },
};

export const NARRATIVE_COMBINED_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "buildstory_complete_narrative",
    strict: true,
    schema: {
      ...STORY_PACK_OUTPUT_SCHEMA,
      required: ["hero", "buildArc", "moments", "turningPoint", "decisions", "learnings", "standoutTraits", "growthEdge"],
    },
  },
};

export const NARRATIVE_DEEP_ANALYSIS_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: { name: "buildstory_deep_analysis", strict: true, schema: STORY_PACK_DEEP_ANALYSIS_SCHEMA },
};

export const NARRATIVE_DEEP_SYNTHESIS_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: { name: "buildstory_deep_narrative", strict: true, schema: STORY_PACK_DEEP_NARRATIVE_SCHEMA },
};

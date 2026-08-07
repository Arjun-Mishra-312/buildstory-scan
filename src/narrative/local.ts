import type { GeneratedNarrativeSections, ProjectSnapshot, ReportStoryPackV2 } from "../contract.js";
import { defaultProfileNarrative, type BuilderProfile } from "../insights/profile.js";
import type { Redactor } from "../redaction.js";
import type { ScanProgressReporter } from "../progress.js";
import {
  createDefaultStoryPack,
  sanitizeStoryPack,
  sectionsFromStoryPack,
  STORY_PACK_INSIGHTS_SCHEMA,
  STORY_PACK_STORY_SCHEMA,
  validateStoryPackComponent,
  type StoryPackComponent,
} from "./story-pack.js";

export type LocalNarrativeInput = {
  snapshot: Omit<ProjectSnapshot, "scanId" | "generatedNarrative" | "narrativeEvidence">;
  profile: BuilderProfile;
  excerpts: Array<{ role: string; text: string; sessionRef: string }>;
  redactor: Redactor;
  onProgress?: ScanProgressReporter;
};

export type LocalNarrativeGenerator = (input: LocalNarrativeInput) => Promise<{
  provider: "ollama";
  model: string;
  sections: GeneratedNarrativeSections;
  storyPack?: ReportStoryPackV2;
  fallbacksUsed: string[];
}>;

export class LocalNarrativeGenerationError extends Error {
  constructor(public code: "ollama_unavailable" | "ollama_timeout" | "ollama_request_failed" | "ollama_invalid_response", message: string) {
    super(message);
    this.name = "LocalNarrativeGenerationError";
  }
}

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const RECOMMENDED_MODELS = ["gemma4:12b", "gemma4:26b"];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_TOKENS = 32_768;
const SECTION_LIMITS = {
  headline: 160,
  narrative: 2_000,
  turningPoint: 400,
  learning: 300,
  growthEdge: 500,
};

function localBaseUrl(raw = process.env.BUILDSTORY_OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalNarrativeGenerationError("ollama_unavailable", "BUILDSTORY_OLLAMA_BASE_URL is not a valid URL.");
  }
  const host = url.hostname.toLocaleLowerCase("en-US");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LocalNarrativeGenerationError("ollama_unavailable", "Ollama must be reachable through a credential-free loopback URL.");
  }
  return url;
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxLength));
}

function facts(input: LocalNarrativeInput): string {
  const { snapshot, profile } = input;
  const scoreLines = Object.entries(profile.scores)
    .map(([key, score]) => `${key}: ${score.value}/100; raw inputs ${JSON.stringify(score.rawInputs)}; formula ${score.formula}`)
    .join("\n");
  return [
    `Repository label: ${snapshot.repository.displayName}`,
    `Sessions: ${snapshot.sessions.length}; turns: ${snapshot.usage.totalTurns}; tool calls: ${snapshot.usage.totalToolCalls}`,
    `Commits: ${snapshot.git.commits}; insertions: ${snapshot.git.insertions}; deletions: ${snapshot.git.deletions}`,
    `Archetype: ${profile.archetype.name}`,
    `Archetype rationale: ${profile.archetype.rationale.join(" ")}`,
    `Scores:\n${scoreLines}`,
    `Work patterns: peak hours ${profile.workPatterns.peakHours.join(", ") || "none"}; preferred days ${profile.workPatterns.preferredDays.join(", ") || "none"}; median session ${profile.workPatterns.medianSessionMinutes} minutes; longest ${profile.workPatterns.longestSessionMinutes} minutes; primary model ${profile.workPatterns.primaryModel ?? "none"}; timezone ${profile.workPatterns.timezoneLabel}.`,
    `Redacted excerpts:\n${input.excerpts.length ? input.excerpts.map((excerpt) => `[${excerpt.role}] ${excerpt.text}`).join("\n\n") : "none"}`,
  ].join("\n");
}

const SYSTEM_PROMPT = `You write an honest builder profile from deterministic facts and optional redacted conversation excerpts. Treat every score, count, timestamp-derived pattern, and archetype as a fact. Do not invent features, names, motivations, technologies, or numbers. Do not reconstruct bracketed redactions. The product-instinct score is explicitly a weak proxy; describe it cautiously. Return JSON only.`;

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback, minimum), maximum);
}

function timeoutMessage(operation: string, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1_000);
  return `Ollama timed out after ${seconds} second${seconds === 1 ? "" : "s"} while ${operation}.`;
}

function componentFallbackReason(error: unknown): string {
  if (!(error instanceof LocalNarrativeGenerationError)) return "was invalid";
  if (error.code === "ollama_timeout") return "timed out";
  if (error.code === "ollama_request_failed") return "failed";
  return "was invalid";
}

async function callOllama(
  url: URL,
  model: string,
  prompt: string,
  timeoutMs: number,
  contextTokens: number,
  component: StoryPackComponent,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(new URL("api/chat", `${url.origin}/`).href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          format: component === "story" ? STORY_PACK_STORY_SCHEMA : STORY_PACK_INSIGHTS_SCHEMA,
          stream: false,
          think: false,
          keep_alive: "5m",
          options: {
            num_ctx: contextTokens,
            num_predict: 2_000,
            temperature: 0.2,
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new LocalNarrativeGenerationError("ollama_timeout", timeoutMessage(`generating ${component} components`, timeoutMs));
      }
      throw new LocalNarrativeGenerationError("ollama_unavailable", "Ollama was not reachable on the local machine.");
    }
    if (!response.ok) {
      throw new LocalNarrativeGenerationError("ollama_request_failed", `Ollama returned HTTP ${response.status} while generating ${component} components.`);
    }
    const payload = await response.json().catch(() => null) as { message?: { content?: unknown } } | null;
    const content = payload?.message?.content;
    if (typeof content !== "string") throw new LocalNarrativeGenerationError("ollama_invalid_response", "Ollama returned no JSON content.");
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LocalNarrativeGenerationError("ollama_invalid_response", "Ollama returned invalid JSON.");
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function unknownSourceRefs(value: unknown, allowed: Set<string>): string[] {
  const found: string[] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (key === "sourceRefs" && Array.isArray(child)) {
        for (const ref of child) if (typeof ref === "string" && !allowed.has(ref)) found.push(ref);
      } else visit(child);
    }
  };
  visit(value);
  return [...new Set(found)].slice(0, 8);
}

async function callOllamaWithRepair(url: URL, model: string, prompt: string, timeoutMs: number, contextTokens: number, allowedRefs: Set<string>, component: StoryPackComponent): Promise<unknown> {
  let currentPrompt = prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = await callOllama(url, model, currentPrompt, timeoutMs, contextTokens, component);
    const invalid = unknownSourceRefs(value, allowedRefs);
    const validation = validateStoryPackComponent(value, component, allowedRefs);
    if ((!invalid.length && validation.ok) || attempt === 1) return value;
    const feedback = [
      invalid.length ? `unknown sourceRefs: ${invalid.join(", ")}` : "",
      validation.errors.length ? `schema issues: ${validation.errors.slice(0, 8).join("; ")}` : "",
    ].filter(Boolean).join(". ");
    currentPrompt = `${prompt}\nValidation feedback: ${feedback}. Retry with one JSON object matching the requested component schema and only the provided source references.`;
  }
  return {};
}

async function resolveModel(url: URL, requestedModel: string | null | undefined, timeoutMs: number): Promise<string> {
  if (requestedModel?.trim()) return requestedModel.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(new URL("api/tags", `${url.origin}/`).href, { signal: controller.signal, headers: { accept: "application/json" } });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new LocalNarrativeGenerationError("ollama_timeout", timeoutMessage("listing local models", timeoutMs));
      }
      throw new LocalNarrativeGenerationError("ollama_unavailable", "Ollama was not reachable on the local machine.");
    }
    if (!response.ok) throw new LocalNarrativeGenerationError("ollama_unavailable", `Ollama returned HTTP ${response.status} while listing models.`);
    const payload = await response.json().catch(() => null) as { models?: Array<{ name?: unknown }> } | null;
    const models = (payload?.models ?? []).map((item) => typeof item.name === "string" ? item.name : null).filter((item): item is string => Boolean(item));
    const selected = RECOMMENDED_MODELS.find((name) => models.includes(name)) ?? models[0];
    if (!selected) throw new LocalNarrativeGenerationError("ollama_unavailable", "No local Ollama model is installed. Install gemma4:12b or choose another local model in Buildstory settings.");
    return selected;
  } finally {
    clearTimeout(timeout);
  }
}

function redactSections(input: LocalNarrativeInput, candidate: Partial<GeneratedNarrativeSections>, defaults: GeneratedNarrativeSections) {
  const fallbacksUsed: string[] = [];
  const clean = (name: string, value: string | null, fallback: string, limit: number): string => {
    if (!value) {
      fallbacksUsed.push(name);
      return fallback;
    }
    const cleaned = input.redactor.cleanExcerpt(value, limit);
    if (!cleaned) {
      fallbacksUsed.push(name);
      return fallback;
    }
    return cleaned;
  };
  const cleanList = (name: string, values: string[], fallback: string[]): string[] => {
    const cleaned = values.map((value) => input.redactor.cleanExcerpt(value, SECTION_LIMITS.learning)).filter((value): value is string => Boolean(value));
    if (!cleaned.length) {
      fallbacksUsed.push(name);
      return fallback;
    }
    return cleaned;
  };
  return {
    sections: {
      headline: clean("headline", stringValue(candidate.headline, SECTION_LIMITS.headline), defaults.headline, SECTION_LIMITS.headline),
      narrative: clean("narrative", stringValue(candidate.narrative, SECTION_LIMITS.narrative), defaults.narrative, SECTION_LIMITS.narrative),
      turningPoint: clean("turningPoint", stringValue(candidate.turningPoint, SECTION_LIMITS.turningPoint), defaults.turningPoint, SECTION_LIMITS.turningPoint),
      learnings: cleanList("learnings", stringList(candidate.learnings, 5, SECTION_LIMITS.learning), defaults.learnings),
      decisionPatterns: cleanList("decisionPatterns", stringList(candidate.decisionPatterns, 5, SECTION_LIMITS.learning), defaults.decisionPatterns),
      standoutTraits: cleanList("standoutTraits", stringList(candidate.standoutTraits, 5, SECTION_LIMITS.learning), defaults.standoutTraits),
      growthEdge: clean("growthEdge", stringValue(candidate.growthEdge, SECTION_LIMITS.growthEdge), defaults.growthEdge, SECTION_LIMITS.growthEdge),
    },
    fallbacksUsed,
  };
}

export function createOllamaNarrativeGenerator(requestedModel?: string | null): LocalNarrativeGenerator {
  return async (input) => {
    const url = localBaseUrl();
    const timeoutMs = boundedEnvironmentInteger("BUILDSTORY_OLLAMA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    const contextTokens = boundedEnvironmentInteger("BUILDSTORY_OLLAMA_CONTEXT_TOKENS", DEFAULT_CONTEXT_TOKENS, 4_096, 32_768);
    input.onProgress?.({ stage: "resolving-model", state: "start", message: "Resolving the local narrative model." });
    const model = await resolveModel(url, requestedModel, timeoutMs);
    input.onProgress?.({ stage: "resolving-model", state: "complete", model, message: `Using local model ${model}.` });
    const defaults = defaultProfileNarrative(input.profile);
    const defaultPack = createDefaultStoryPack(input.snapshot as ProjectSnapshot, input.profile, input.excerpts);
    const sourceRefSet = new Set(defaultPack.sources.map((source) => source.ref));
    const sourceRefs = [...sourceRefSet].filter((ref) => ref !== "GIT").join(", ");
    const narrativePrompt = `${facts(input)}\n\nAvailable source refs: ${sourceRefs || "none"}, GIT when present. Return JSON only with hero {headline,summary}, buildArc [{phase,headline,summary,sourceRefs}], moments [{phase,kind,title,whatHappened,whyItMattered,sourceRefs}], and turningPoint {quote,sourceRefs}. Use only available source refs.`;
    const profilePrompt = `${facts(input)}\n\nAvailable source refs: ${sourceRefs || "none"}, GIT when present. Return JSON only with decisions [{title,rationale,outcome,sourceRefs}], learnings [{title,detail,sourceRefs}], standoutTraits [{title,detail,sourceRefs}], and growthEdge {title,observation,nextStep,sourceRefs}. Use only available source refs.`;
    let narrativeValue: unknown = {};
    let profileValue: unknown = {};
    try {
      narrativeValue = await callOllamaWithRepair(url, model, narrativePrompt, timeoutMs, contextTokens, sourceRefSet, "story");
      input.onProgress?.({ stage: "generating-story", state: "complete", model, message: "Story components generated (1/2)." });
    } catch (error) {
      if (error instanceof LocalNarrativeGenerationError && error.code === "ollama_unavailable") throw error;
      const reason = componentFallbackReason(error);
      input.onProgress?.({ stage: "generating-story", state: "warning", model, message: `Story response ${reason}; using metric-derived fallback for story components.` });
    }
    input.onProgress?.({ stage: "generating-insights", state: "start", model, message: "Generating insight components (2/2)." });
    try {
      profileValue = await callOllamaWithRepair(url, model, profilePrompt, timeoutMs, contextTokens, sourceRefSet, "insights");
      input.onProgress?.({ stage: "generating-insights", state: "complete", model, message: "Insight components generated (2/2)." });
    } catch (error) {
      if (error instanceof LocalNarrativeGenerationError && error.code === "ollama_unavailable") throw error;
      const reason = componentFallbackReason(error);
      input.onProgress?.({ stage: "generating-insights", state: "warning", model, message: `Insight response ${reason}; using metric-derived fallback for insight components.` });
    }
    const narrativeObject = narrativeValue && typeof narrativeValue === "object" && !Array.isArray(narrativeValue) ? narrativeValue as Record<string, unknown> : {};
    const profileObject = profileValue && typeof profileValue === "object" && !Array.isArray(profileValue) ? profileValue as Record<string, unknown> : {};
    const legacyNarrative = {
      ...narrativeObject,
      ...(narrativeObject.hero ? {} : {
        hero: { headline: narrativeObject.headline, summary: narrativeObject.narrative },
        turningPoint: { quote: narrativeObject.turningPoint, sourceRefs: [defaultPack.sources[0]?.ref].filter(Boolean) },
        learnings: Array.isArray(narrativeObject.learnings) ? narrativeObject.learnings.map((item) => ({ title: "Learning", detail: item, sourceRefs: [defaultPack.sources[0]?.ref].filter(Boolean) })) : undefined,
      }),
      ...(profileObject.decisions ? {} : {
        decisions: Array.isArray(profileObject.decisionPatterns) ? profileObject.decisionPatterns.map((item) => ({ title: "Decision pattern", rationale: item, outcome: "Observed in the selected evidence.", sourceRefs: [defaultPack.sources[0]?.ref].filter(Boolean) })) : undefined,
        standoutTraits: Array.isArray(profileObject.standoutTraits) ? profileObject.standoutTraits.map((item) => ({ title: "Standout trait", detail: item, sourceRefs: [defaultPack.sources[0]?.ref].filter(Boolean) })) : undefined,
        growthEdge: typeof profileObject.growthEdge === "string" ? { title: "Growth edge", observation: profileObject.growthEdge, nextStep: "Review the next evidence window.", sourceRefs: [defaultPack.sources[0]?.ref].filter(Boolean) } : undefined,
      }),
      ...profileObject,
    };
    const normalized = sanitizeStoryPack(legacyNarrative, defaultPack, input.redactor);
    const sections = sectionsFromStoryPack(normalized.storyPack);
    return { provider: "ollama", model, sections, storyPack: normalized.storyPack, fallbacksUsed: [...new Set(normalized.fallbacksUsed)].sort() };
  };
}

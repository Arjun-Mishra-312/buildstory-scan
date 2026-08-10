import type { AnalysisTier, GeneratedNarrativeSections, NarrativeProvider, ProjectSnapshot, ReportStoryPack } from "../contract.js";
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
  /**
   * Free-form: "ollama" for local Ollama generation, or the real provider
   * name (e.g. "openai") for a bring-your-own-key generation. Either way the
   * ProjectSnapshot's generatedNarrative.mode stays the literal "local" -
   * only this field distinguishes who actually wrote the prose.
   */
  provider: string;
  model: string;
  sections: GeneratedNarrativeSections;
  storyPack?: ReportStoryPack;
  fallbacksUsed: string[];
}>;

export class LocalNarrativeGenerationError extends Error {
  constructor(
    public code: "local_provider_unavailable" | "local_provider_timeout" | "local_provider_request_failed" | "local_provider_invalid_response",
    message: string,
  ) {
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

const DEEP_FINDING_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "summary", "sourceRefs", "confidence"],
  properties: {
    title: { type: "string", maxLength: 120 }, summary: { type: "string", maxLength: 600 },
    sourceRefs: { type: "array", minItems: 1, maxItems: 6, uniqueItems: true, items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
} as const;
// An LLM-written finding that frames one specific computed Signal - never a
// number the model invented. See the report-redesign sprint: Deep no longer
// asks for decisionReview/risksAndEvidenceGaps/nextBuildActions (advice is
// off-vision for this product), and byTheNumbers.signalId is the
// anti-hallucination mechanism replacing them.
const DEEP_SIGNAL_FINDING_SCHEMA = {
  ...DEEP_FINDING_SCHEMA,
  required: [...DEEP_FINDING_SCHEMA.required, "signalId"],
  properties: { ...DEEP_FINDING_SCHEMA.properties, signalId: { type: "string", maxLength: 60 } },
} as const;
const DEEP_ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["openingLine", "signatureMoves", "byTheNumbers", "whereItGotHard", "chapterChanges"],
  properties: {
    openingLine: DEEP_FINDING_SCHEMA,
    signatureMoves: { type: "array", maxItems: 6, items: DEEP_FINDING_SCHEMA },
    byTheNumbers: { type: "array", minItems: 1, maxItems: 8, items: DEEP_SIGNAL_FINDING_SCHEMA },
    whereItGotHard: { type: "array", maxItems: 6, items: DEEP_FINDING_SCHEMA },
    chapterChanges: { type: "array", maxItems: 5, items: DEEP_FINDING_SCHEMA },
  },
} as const;
const DEEP_REPORT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: [...STORY_PACK_STORY_SCHEMA.required, ...STORY_PACK_INSIGHTS_SCHEMA.required, "deepAnalysis"],
  properties: { ...STORY_PACK_STORY_SCHEMA.properties, ...STORY_PACK_INSIGHTS_SCHEMA.properties, deepAnalysis: DEEP_ANALYSIS_SCHEMA },
} as const;
type ByokComponent = StoryPackComponent | "deep" | "deep-report";

function localBaseUrl(raw = process.env.BUILDSTORY_OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalNarrativeGenerationError("local_provider_unavailable", "BUILDSTORY_OLLAMA_BASE_URL is not a valid URL.");
  }
  const host = url.hostname.toLocaleLowerCase("en-US");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LocalNarrativeGenerationError("local_provider_unavailable", "Ollama must be reachable through a credential-free loopback URL.");
  }
  return url;
}

/**
 * BYOK config is read from the environment only, never a CLI flag: an
 * `--api-key` flag would land in shell history and process listings, the
 * exact exposure the connect protocol's `--code` handling already documents
 * and works to minimize (see docs/privacy.md). The base URL is deliberately
 * NOT restricted to loopback - a BYOK provider is expected to be a real
 * cloud endpoint the creator configured themselves - but it must still be a
 * credential-free HTTPS URL, matching the same rule the web app applies to
 * BUILDSTORY_LLM_BASE_URL for the subsidized cloud path.
 */
function byokConfig(provider: NarrativeProvider): { baseUrl: string; apiKey: string; model: string | null; provider: "openrouter" | "openai" } {
  const resolvedProvider = provider === "openai" ? "openai" : "openrouter";
  const apiKey = (resolvedProvider === "openrouter" ? process.env.BUILDSTORY_OPENROUTER_API_KEY : process.env.BUILDSTORY_OPENAI_API_KEY)?.trim()
    || process.env.BUILDSTORY_BYOK_API_KEY?.trim();
  if (!apiKey) {
    throw new LocalNarrativeGenerationError(
      "local_provider_unavailable",
      `Bring-your-own-key ${resolvedProvider} mode requires ${resolvedProvider === "openrouter" ? "BUILDSTORY_OPENROUTER_API_KEY" : "BUILDSTORY_OPENAI_API_KEY"}. Legacy BUILDSTORY_BYOK_API_KEY is also supported.`,
    );
  }
  const rawBaseUrl = (resolvedProvider === "openrouter" ? process.env.BUILDSTORY_OPENROUTER_BASE_URL : process.env.BUILDSTORY_OPENAI_BASE_URL)?.trim()
    || process.env.BUILDSTORY_BYOK_BASE_URL?.trim()
    || (resolvedProvider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new LocalNarrativeGenerationError("local_provider_unavailable", "BUILDSTORY_BYOK_BASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LocalNarrativeGenerationError("local_provider_unavailable", "BUILDSTORY_BYOK_BASE_URL must be a credential-free HTTPS URL.");
  }
  const model = (resolvedProvider === "openrouter" ? process.env.BUILDSTORY_OPENROUTER_MODEL : process.env.BUILDSTORY_OPENAI_MODEL)?.trim()
    || process.env.BUILDSTORY_BYOK_MODEL?.trim() || null;
  return { baseUrl: parsed.href.replace(/\/$/, ""), apiKey, model, provider: resolvedProvider };
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

function facts(input: LocalNarrativeInput, includeExcerpts = true): string {
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
    ...(includeExcerpts ? [`Redacted excerpts:\n${input.excerpts.length ? input.excerpts.map((excerpt) => `[${excerpt.role}] ${excerpt.text}`).join("\n\n") : "none"}`] : []),
  ].join("\n");
}

// Mirrors the cloud pipeline's system prompt (lib/narrative/prompt.ts) - not
// a project summary, not a performance review, and never advice. See the
// report-redesign sprint.
const SYSTEM_PROMPT = `You write a short, honest build story from deterministic facts and optional redacted conversation excerpts - not a project summary, not a performance review, but a surprising, true, specific detail about how this particular build went. Treat every score, count, timestamp-derived pattern, and archetype as a fact; never invent a feature, name, motivation, technology, or number that wasn't given to you verbatim. Never give advice, a recommendation, a next step, or a "you should" - report what happened and what is true about it, not what to do next. Do not reconstruct bracketed redactions. The product-instinct score is explicitly a weak proxy; describe it cautiously. Return JSON only.`;

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback, minimum), maximum);
}

function timeoutMessage(providerLabel: string, operation: string, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1_000);
  return `${providerLabel} timed out after ${seconds} second${seconds === 1 ? "" : "s"} while ${operation}.`;
}

function componentFallbackReason(error: unknown): string {
  if (!(error instanceof LocalNarrativeGenerationError)) return "was invalid";
  if (error.code === "local_provider_timeout") return "timed out";
  if (error.code === "local_provider_request_failed") return "failed";
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
        throw new LocalNarrativeGenerationError("local_provider_timeout", timeoutMessage("Ollama", `generating ${component} components`, timeoutMs));
      }
      throw new LocalNarrativeGenerationError("local_provider_unavailable", "Ollama was not reachable on the local machine.");
    }
    if (!response.ok) {
      throw new LocalNarrativeGenerationError("local_provider_request_failed", `Ollama returned HTTP ${response.status} while generating ${component} components.`);
    }
    const payload = await response.json().catch(() => null) as { message?: { content?: unknown } } | null;
    const content = payload?.message?.content;
    if (typeof content !== "string") throw new LocalNarrativeGenerationError("local_provider_invalid_response", "Ollama returned no JSON content.");
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LocalNarrativeGenerationError("local_provider_invalid_response", "Ollama returned invalid JSON.");
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * BYOK's OpenAI-compatible counterpart to callOllama: same shape of request
 * (system + user message, schema-constrained JSON response, one component
 * per call), but POSTs to {baseUrl}/chat/completions with a bearer key and
 * the OpenAI-style `response_format: {type:"json_schema",...}` wrapper
 * instead of Ollama's raw `format` schema field. The prompt, the excerpts it
 * contains, and the redaction/sanitization applied to the response are
 * identical to the Ollama path - only the wire format differs.
 */
async function callByok(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  component: ByokComponent,
  provider: "openrouter" | "openai",
  analysisTier: AnalysisTier,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: component === "story" ? "buildstory_story" : component === "insights" ? "buildstory_insights" : component === "deep" ? "buildstory_deep_analysis" : "buildstory_deep_report",
              strict: true,
              schema: component === "story" ? STORY_PACK_STORY_SCHEMA : component === "insights" ? STORY_PACK_INSIGHTS_SCHEMA : component === "deep" ? DEEP_ANALYSIS_SCHEMA : DEEP_REPORT_SCHEMA,
            },
          },
          ...(provider === "openrouter" ? {
            provider: { zdr: true, data_collection: "deny", require_parameters: true, allow_fallbacks: true },
            ...(analysisTier === "deep" ? { reasoning: { effort: "high", exclude: true } } : {}),
          } : { store: false }),
          max_tokens: analysisTier === "deep" ? 40_000 : 4_000,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new LocalNarrativeGenerationError("local_provider_timeout", timeoutMessage("The configured model provider", `generating ${component} components`, timeoutMs));
      }
      throw new LocalNarrativeGenerationError("local_provider_unavailable", "The configured BUILDSTORY_BYOK_BASE_URL provider was not reachable.");
    }
    if (!response.ok) {
      throw new LocalNarrativeGenerationError("local_provider_request_failed", `The configured model provider returned HTTP ${response.status} while generating ${component} components.`);
    }
    const payload = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured model provider returned no JSON content.");
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured model provider returned invalid JSON.");
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
    if (!invalid.length && validation.ok) return value;
    // On the last attempt, fail closed instead of returning the still-invalid
    // value as if it had passed. The caller (runNarrativeGeneration) already
    // catches this and degrades to the metric-derived fallback for this
    // component - the same path already used for every other provider
    // failure - so this is not a new failure mode, just closing a hole that
    // let an invalid response through unvalidated.
    if (attempt === 1) throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured local model returned invalid narrative output after repair.");
    const feedback = [
      invalid.length ? `unknown sourceRefs: ${invalid.join(", ")}` : "",
      validation.errors.length ? `schema issues: ${validation.errors.slice(0, 8).join("; ")}` : "",
    ].filter(Boolean).join(". ");
    currentPrompt = `${prompt}\nValidation feedback: ${feedback}. Retry with one JSON object matching the requested component schema and only the provided source references.`;
  }
  throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured local model returned invalid narrative output after repair.");
}

async function callByokWithRepair(baseUrl: string, apiKey: string, model: string, prompt: string, timeoutMs: number, allowedRefs: Set<string>, component: StoryPackComponent, provider: "openrouter" | "openai", analysisTier: AnalysisTier): Promise<unknown> {
  let currentPrompt = prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = await callByok(baseUrl, apiKey, model, currentPrompt, timeoutMs, component, provider, analysisTier);
    const invalid = unknownSourceRefs(value, allowedRefs);
    const validation = validateStoryPackComponent(value, component, allowedRefs);
    if (!invalid.length && validation.ok) return value;
    // See callOllamaWithRepair: fail closed rather than returning an
    // unvalidated value, and let the existing per-component fallback in
    // runNarrativeGeneration handle it.
    if (attempt === 1) throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured model provider returned invalid narrative output after repair.");
    const feedback = [
      invalid.length ? `unknown sourceRefs: ${invalid.join(", ")}` : "",
      validation.errors.length ? `schema issues: ${validation.errors.slice(0, 8).join("; ")}` : "",
    ].filter(Boolean).join(". ");
    currentPrompt = `${prompt}\nValidation feedback: ${feedback}. Retry with one JSON object matching the requested component schema and only the provided source references.`;
  }
  throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured model provider returned invalid narrative output after repair.");
}

// The scanner package's validateStoryPackComponent only knows "story" and
// "insights" (see story-pack.ts) - there is no deep-finding-level validator
// here to match the web app's. This checks the DEEP_ANALYSIS_SCHEMA's own
// required keys are present with the right container type (array vs
// object), which is what the previous check (only "does deepAnalysis exist"
// for deep-report, nothing at all for deep) was missing.
function matchesRequiredShape(value: unknown, schema: { required: readonly string[]; properties: Record<string, { type?: string }> }): boolean {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record) return false;
  return schema.required.every((key) => {
    const expectedType = schema.properties[key]?.type;
    const actual = record[key];
    if (expectedType === "array") return Array.isArray(actual);
    if (expectedType === "object") return Boolean(actual) && typeof actual === "object" && !Array.isArray(actual);
    return actual !== undefined && actual !== null;
  });
}

async function callByokDeepWithRepair(baseUrl: string, apiKey: string, model: string, prompt: string, timeoutMs: number, allowedRefs: Set<string>, provider: "openrouter" | "openai", component: "deep" | "deep-report" = "deep"): Promise<unknown> {
  let currentPrompt = prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = await callByok(baseUrl, apiKey, model, currentPrompt, timeoutMs, component, provider, "deep");
    const invalid = unknownSourceRefs(value, allowedRefs);
    const objectValue = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    // Deep-report additionally runs the real field-level validator (title
    // lengths, sourceRefs provenance, cardinality) against its story and
    // insights portions - previously nothing beyond "deepAnalysis exists as
    // an object" was ever checked here.
    const shapeOk = component === "deep"
      ? matchesRequiredShape(value, DEEP_ANALYSIS_SCHEMA)
      : objectValue !== null
        && matchesRequiredShape(objectValue.deepAnalysis, DEEP_ANALYSIS_SCHEMA)
        && validateStoryPackComponent(objectValue, "story", allowedRefs).ok
        && validateStoryPackComponent(objectValue, "insights", allowedRefs).ok;
    if (!invalid.length && shapeOk) return value;
    if (attempt === 1) throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured provider returned invalid deep analysis after repair.");
    currentPrompt = `${prompt}\nValidation feedback: use only these source references: ${[...allowedRefs].join(", ")}. Return one JSON object and no prose.`;
  }
  throw new LocalNarrativeGenerationError("local_provider_invalid_response", "The configured provider returned invalid deep analysis after repair.");
}

async function resolveOllamaModel(url: URL, requestedModel: string | null | undefined, timeoutMs: number): Promise<string> {
  if (requestedModel?.trim()) return requestedModel.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(new URL("api/tags", `${url.origin}/`).href, { signal: controller.signal, headers: { accept: "application/json" } });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new LocalNarrativeGenerationError("local_provider_timeout", timeoutMessage("Ollama", "listing local models", timeoutMs));
      }
      throw new LocalNarrativeGenerationError("local_provider_unavailable", "Ollama was not reachable on the local machine.");
    }
    if (!response.ok) throw new LocalNarrativeGenerationError("local_provider_unavailable", `Ollama returned HTTP ${response.status} while listing models.`);
    const payload = await response.json().catch(() => null) as { models?: Array<{ name?: unknown }> } | null;
    const models = (payload?.models ?? []).map((item) => typeof item.name === "string" ? item.name : null).filter((item): item is string => Boolean(item));
    const selected = RECOMMENDED_MODELS.find((name) => models.includes(name)) ?? models[0];
    if (!selected) throw new LocalNarrativeGenerationError("local_provider_unavailable", "No local Ollama model is installed. Install gemma4:12b or choose another local model in Buildstory settings.");
    return selected;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Redaction happens inside sanitizeStoryPack (called at the end of
 * runNarrativeGeneration below) using input.redactor - this function exists
 * only for the legacy flat-sections shape and is currently unreachable
 * (defaultProfileNarrative + sanitizeStoryPack cover it); kept as-is rather
 * than removed while auditing narrative generation, since it is not on the
 * path this change touches.
 */
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

/**
 * Shared orchestration for both generators: build the two prompts, call the
 * provider-specific `callComponentWithRepair` for "story" then "insights",
 * merge into the legacy flat shape story-pack.ts still accepts, and run the
 * result through sanitizeStoryPack (which applies input.redactor). Only the
 * HTTP call itself differs between Ollama and BYOK - everything else,
 * including the redaction boundary, is identical.
 */
async function runNarrativeGeneration(
  input: LocalNarrativeInput,
  provider: string,
  model: string,
  callComponentWithRepair: (prompt: string, allowedRefs: Set<string>, component: StoryPackComponent) => Promise<unknown>,
): Promise<{ provider: string; model: string; sections: GeneratedNarrativeSections; storyPack?: ReportStoryPack; fallbacksUsed: string[] }> {
  const defaultPack = createDefaultStoryPack(input.snapshot as ProjectSnapshot, input.profile, input.excerpts);
  const sourceRefSet = new Set(defaultPack.sources.map((source) => source.ref));
  const sourceRefs = [...sourceRefSet].filter((ref) => ref !== "GIT").join(", ");
  const narrativePrompt = `${facts(input)}\n\nAvailable source refs: ${sourceRefs || "none"}, GIT when present. Return JSON only with hero {headline,summary}, buildArc [{phase,headline,summary,sourceRefs}], moments [{phase,kind,title,whatHappened,whyItMattered,sourceRefs}], and turningPoint {quote,sourceRefs}. Use only available source refs.`;
  const profilePrompt = `${facts(input)}\n\nAvailable source refs: ${sourceRefs || "none"}, GIT when present. Return JSON only with decisions [{title,rationale,outcome,sourceRefs}], learnings [{title,detail,sourceRefs}], standoutTraits [{title,detail,sourceRefs}], and growthEdge {title,observation,nextStep,sourceRefs}. Use only available source refs.`;
  let narrativeValue: unknown = {};
  let profileValue: unknown = {};
  input.onProgress?.({ stage: "generating-story", state: "start", model, message: "Generating story components (1/2)." });
  try {
    narrativeValue = await callComponentWithRepair(narrativePrompt, sourceRefSet, "story");
    input.onProgress?.({ stage: "generating-story", state: "complete", model, message: "Story components generated (1/2)." });
  } catch (error) {
    if (error instanceof LocalNarrativeGenerationError && error.code === "local_provider_unavailable") throw error;
    const reason = componentFallbackReason(error);
    input.onProgress?.({ stage: "generating-story", state: "warning", model, message: `Story response ${reason}; using metric-derived fallback for story components.` });
  }
  input.onProgress?.({ stage: "generating-insights", state: "start", model, message: "Generating insight components (2/2)." });
  try {
    profileValue = await callComponentWithRepair(profilePrompt, sourceRefSet, "insights");
    input.onProgress?.({ stage: "generating-insights", state: "complete", model, message: "Insight components generated (2/2)." });
  } catch (error) {
    if (error instanceof LocalNarrativeGenerationError && error.code === "local_provider_unavailable") throw error;
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
  return { provider, model, sections, storyPack: normalized.storyPack, fallbacksUsed: [...new Set(normalized.fallbacksUsed)].sort() };
}

export function createOllamaNarrativeGenerator(
  requestedModel?: string | null,
  capability?: { contextTokens: number; label: string; memoryGiB: number; logicalCpus: number },
): LocalNarrativeGenerator {
  return async (input) => {
    const url = localBaseUrl();
    const timeoutMs = boundedEnvironmentInteger("BUILDSTORY_OLLAMA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    const contextTokens = boundedEnvironmentInteger("BUILDSTORY_OLLAMA_CONTEXT_TOKENS", capability?.contextTokens ?? DEFAULT_CONTEXT_TOKENS, 4_096, 32_768);
    input.onProgress?.({ stage: "resolving-model", state: "start", message: "Resolving the local narrative model." });
    const model = await resolveOllamaModel(url, requestedModel, timeoutMs);
    const capabilityNote = capability
      ? ` ${capability.label} profile (${capability.memoryGiB} GiB RAM, ${capability.logicalCpus} logical CPUs, ${contextTokens.toLocaleString("en-US")} context tokens).`
      : "";
    input.onProgress?.({ stage: "resolving-model", state: "complete", model, message: `Using local model ${model}.${capabilityNote}` });
    return runNarrativeGeneration(input, "ollama", model, (prompt, allowedRefs, component) =>
      callOllamaWithRepair(url, model, prompt, timeoutMs, contextTokens, allowedRefs, component));
  };
}

/**
 * Bring-your-own-key: the model call goes to a cloud provider the creator
 * configured with their own key (BUILDSTORY_BYOK_API_KEY/BASE_URL/MODEL),
 * never through Buildstory. It reuses the exact same redacted excerpt
 * selection as local Ollama mode (selectNarrativeEvidence in scanner.ts) and
 * the same sanitizeStoryPack redaction pass on the response - only the HTTP
 * destination differs. The resulting generatedNarrative still reports
 * mode:"local" in the uploaded snapshot.
 *
 * `provider` is the fixed literal "byok", never the configured host: the
 * final snapshot-wide fail-closed check (detectPrivateLocations in
 * scanner.ts) scans every string field for URL/host/path patterns and would
 * reject the whole snapshot if `provider` carried the real hostname - this
 * was caught by that exact check in testing. The host is safe to log in a
 * progress event (ephemeral, local-only, never part of the snapshot) but not
 * safe to persist in an uploaded field.
 */
export function createByokNarrativeGenerator(requestedModel?: string | null, provider: NarrativeProvider = "openrouter", analysisTier: AnalysisTier = "standard"): LocalNarrativeGenerator {
  return async (input) => {
    const config = byokConfig(provider);
    const model = requestedModel?.trim() || config.model || (config.provider === "openrouter" ? "deepseek/deepseek-v4-flash" : "gpt-5.6-luna");
    const timeoutMs = boundedEnvironmentInteger("BUILDSTORY_BYOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    const hostForProgressOnly = (() => {
      try {
        return new URL(config.baseUrl).hostname;
      } catch {
        return "the configured provider";
      }
    })();
    input.onProgress?.({ stage: "resolving-model", state: "complete", model, message: `Using configured model ${model} via ${hostForProgressOnly}.` });
    if (analysisTier === "deep") {
      const defaultPack = createDefaultStoryPack(input.snapshot as ProjectSnapshot, input.profile, input.excerpts);
      const allowedRefs = new Set(defaultPack.sources.map((source) => source.ref));
      // Every number in this list was computed in code, never by the model
      // (see insights/signals.ts) - byTheNumbers below may only frame one of
      // these by its exact id, never invent a statistic of its own.
      const signalsText = defaultPack.signals.length
        ? `\n\nCOMPUTED SIGNALS:\n${defaultPack.signals.map((signal) => `- ${signal.id}: ${signal.headline} (${signal.detail})`).join("\n")}`
        : "\n\nCOMPUTED SIGNALS:\nNone computed for this build window.";
      const analysisPrompt = `${facts(input)}${signalsText}\n\nProduce the private analysis map with openingLine (the one-line hook), signatureMoves (this builder's distinctive patterns, grounded in the facts above), byTheNumbers (frame the most notable COMPUTED SIGNALS into shareable findings - every entry's signalId must be copied exactly from the list above), whereItGotHard (friction and recovery, as narrative, not an audit finding), and chapterChanges. Never give advice, a recommendation, or a next step. Every claim must cite only: ${[...allowedRefs].join(", ")}. Leave lists empty when evidence is insufficient.`;
      const analysis = await callByokDeepWithRepair(config.baseUrl, config.apiKey, model, analysisPrompt, timeoutMs, allowedRefs, config.provider, "deep");
      const synthesisPrompt = `${facts(input, false)}\n\nSOURCE REFS: ${[...allowedRefs].join(", ")}\n\nPRIVATE ANALYSIS MAP:\n${JSON.stringify(analysis)}\n\nCreate one layered StoryPackV3 JSON object. Use 6-12 moments only when supported. Do not invent claims or source references.`;
      const synthesized = await callByokDeepWithRepair(config.baseUrl, config.apiKey, model, synthesisPrompt, timeoutMs, allowedRefs, config.provider, "deep-report");
      const candidate = synthesized && typeof synthesized === "object" && !Array.isArray(synthesized) ? synthesized as Record<string, unknown> : {};
      const deep = candidate.deepAnalysis && typeof candidate.deepAnalysis === "object" && !Array.isArray(candidate.deepAnalysis) ? candidate.deepAnalysis as Record<string, unknown> : analysis as Record<string, unknown>;
      const withCoverage = {
        ...candidate,
        version: "3.0.0",
        analysisTier: "deep",
        deepAnalysis: {
          ...deep,
          coverage: {
            sessionsSeen: input.snapshot.sessions.length,
            excerptsUsed: input.excerpts.length,
            evidenceBytes: Buffer.byteLength(input.excerpts.map((excerpt) => excerpt.text).join(""), "utf8"),
            windowStart: input.snapshot.timeWindow.start,
            windowEnd: input.snapshot.timeWindow.end,
          },
        },
      };
      const normalized = sanitizeStoryPack(withCoverage, defaultPack, input.redactor);
      return { provider: config.provider, model, storyPack: normalized.storyPack, sections: sectionsFromStoryPack(normalized.storyPack), fallbacksUsed: normalized.fallbacksUsed };
    }
    const generated = await runNarrativeGeneration(input, config.provider, model, (prompt, allowedRefs, component) =>
      callByokWithRepair(config.baseUrl, config.apiKey, model, prompt, timeoutMs, allowedRefs, component, config.provider, analysisTier));
    return generated;
  };
}

/**
 * Static, versioned API-equivalent pricing for the AI coding-session models
 * this scanner observes. The scanner never fetches prices during a scan, so
 * the rate table and its effective dates are part of the snapshot provenance.
 */

import type { TokenUsage } from "./contract.js";

export const SESSION_PRICING_TABLE_VERSION = "2026-08-08.1-api-equivalent" as const;

const DEFAULT_PRICING_TIMESTAMP = "2026-08-06T00:00:00.000Z";
const OPENAI_LONG_CONTEXT_INPUT_TOKENS = 272_000;

interface ModelPricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** GPT-5.6 long-context multipliers, if published for this model family. */
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
}

interface PricingEntry {
  prefix: string;
  pricing: ModelPricing;
  effectiveFrom?: string;
  effectiveUntil?: string;
}

const pricing = (
  input: number,
  output: number,
  cacheRead: number,
  options: Pick<ModelPricing, "cacheWrite5m" | "cacheWrite1h" | "longContextInputMultiplier" | "longContextOutputMultiplier"> = {},
): ModelPricing => ({ input, output, cacheRead, ...options });

/** Longest matching prefix wins; dated provider snapshots therefore remain supported. */
const PRICING_TABLE: PricingEntry[] = [
  // Anthropic. Sonnet 5 introductory pricing is effective through 2026-08-31.
  {
    prefix: "claude-sonnet-5",
    pricing: pricing(2, 10, 0.2, { cacheWrite5m: 2.5, cacheWrite1h: 4 }),
    effectiveUntil: "2026-09-01T00:00:00.000Z",
  },
  {
    prefix: "claude-sonnet-5",
    pricing: pricing(3, 15, 0.3, { cacheWrite5m: 3.75, cacheWrite1h: 6 }),
    effectiveFrom: "2026-09-01T00:00:00.000Z",
  },
  { prefix: "claude-opus-5", pricing: pricing(5, 25, 0.5, { cacheWrite5m: 6.25, cacheWrite1h: 10 }) },
  { prefix: "claude-fable-5", pricing: pricing(10, 50, 1, { cacheWrite5m: 12.5, cacheWrite1h: 20 }) },
  { prefix: "claude-mythos-5", pricing: pricing(10, 50, 1, { cacheWrite5m: 12.5, cacheWrite1h: 20 }) },
  { prefix: "claude-haiku", pricing: pricing(0.8, 4, 0.08, { cacheWrite5m: 1, cacheWrite1h: 1.6 }) },
  { prefix: "claude-3-5-haiku", pricing: pricing(0.8, 4, 0.08, { cacheWrite5m: 1, cacheWrite1h: 1.6 }) },
  { prefix: "claude-sonnet", pricing: pricing(3, 15, 0.3, { cacheWrite5m: 3.75, cacheWrite1h: 6 }) },
  { prefix: "claude-3-5-sonnet", pricing: pricing(3, 15, 0.3, { cacheWrite5m: 3.75, cacheWrite1h: 6 }) },
  { prefix: "claude-3-7-sonnet", pricing: pricing(3, 15, 0.3, { cacheWrite5m: 3.75, cacheWrite1h: 6 }) },
  { prefix: "claude-opus", pricing: pricing(15, 75, 1.5, { cacheWrite5m: 18.75, cacheWrite1h: 30 }) },

  // OpenAI public API rates. GPT-5.6 aliases are intentionally more specific
  // than the legacy gpt-5 fallback below.
  {
    prefix: "gpt-5.6-sol",
    pricing: pricing(5, 30, 0.5, {
      cacheWrite5m: 6.25,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    }),
  },
  {
    prefix: "gpt-5.6-terra",
    pricing: pricing(2.5, 15, 0.25, {
      cacheWrite5m: 3.125,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    }),
  },
  {
    prefix: "gpt-5.6-luna",
    pricing: pricing(1, 6, 0.1, {
      cacheWrite5m: 1.25,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    }),
  },
  // The unsuffixed alias routes to Sol; the longer suffixed prefixes above win.
  {
    prefix: "gpt-5.6",
    pricing: pricing(5, 30, 0.5, {
      cacheWrite5m: 6.25,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    }),
  },
  { prefix: "gpt-5-codex", pricing: pricing(1.25, 10, 0.125) },
  { prefix: "gpt-5-mini", pricing: pricing(0.25, 2, 0.025) },
  { prefix: "gpt-5-nano", pricing: pricing(0.05, 0.4, 0.005) },
  { prefix: "gpt-5", pricing: pricing(1.25, 10, 0.125) },
  { prefix: "gpt-4.1-mini", pricing: pricing(0.4, 1.6, 0.1) },
  { prefix: "gpt-4.1", pricing: pricing(2, 8, 0.5) },
  { prefix: "o4-mini", pricing: pricing(1.1, 4.4, 0.275) },
  { prefix: "o3", pricing: pricing(2, 8, 0.5) },
];

/**
 * A dated/versioned snapshot suffix in the shape every provider in this
 * table actually uses: zero or more numeric version segments
 * ("4-5-", "4-1-"), then a date as either "YYYYMMDD" or "YYYY-MM-DD".
 * Deliberately narrower than "digits and hyphens" alone - a short numeric
 * string like "50" must NOT count as a snapshot suffix, or a model like
 * "claude-sonnet-50" would silently resolve to the unrelated "claude-sonnet"
 * entry via bare substring overlap. Anything that isn't shaped like a real
 * dated snapshot (a free-form variant name such as "-pro" or "-mini", or an
 * unrelated model that merely shares a prefix, like "gpt-5.7" vs "gpt-5")
 * stays unpriced rather than guessed.
 */
const DATED_SUFFIX_PATTERN = /^(?:\d+-)*(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

function matchesEntry(normalizedModel: string, entry: PricingEntry): boolean {
  if (normalizedModel === entry.prefix) return true;
  const hyphenatedPrefix = `${entry.prefix}-`;
  if (!normalizedModel.startsWith(hyphenatedPrefix)) return false;
  return DATED_SUFFIX_PATTERN.test(normalizedModel.slice(hyphenatedPrefix.length));
}

function isEffective(entry: PricingEntry, timestamp: string): boolean {
  return (!entry.effectiveFrom || timestamp >= entry.effectiveFrom)
    && (!entry.effectiveUntil || timestamp < entry.effectiveUntil);
}

function findPricing(model: string, timestamp = DEFAULT_PRICING_TIMESTAMP): ModelPricing | null {
  const normalized = model.trim().toLocaleLowerCase("en-US");
  const candidates = PRICING_TABLE.filter((entry) => matchesEntry(normalized, entry) && isEffective(entry, timestamp));
  candidates.sort((left, right) => right.prefix.length - left.prefix.length || (right.effectiveFrom ?? "").localeCompare(left.effectiveFrom ?? ""));
  return candidates[0]?.pricing ?? null;
}

export function isPricedModel(model: string, timestamp = DEFAULT_PRICING_TIMESTAMP): boolean {
  return findPricing(model, timestamp) !== null;
}

function nanoUsdPerToken(usdPerMillion: number): number {
  // $1/M token = 1,000 nano-USD/token.
  return usdPerMillion * 1_000;
}

/**
 * Returns the unrounded cost in nano-USD. Callers aggregate this value across
 * responses and round only once when producing the public micro-USD field.
 */
export function estimateUsageCostNanoUsd(
  model: string,
  usage: TokenUsage,
  timestamp = DEFAULT_PRICING_TIMESTAMP,
): number | null {
  const modelPricing = findPricing(model, timestamp);
  if (!modelPricing) return null;

  const openAiLongContext = model.trim().toLocaleLowerCase("en-US").startsWith("gpt-5.6")
    && modelPricing.longContextInputMultiplier !== undefined;
  const promptInputTokens = usage.inputTokens + usage.cachedInputTokens + (usage.cacheCreationInputTokens ?? 0);
  const inputMultiplier = openAiLongContext && promptInputTokens > OPENAI_LONG_CONTEXT_INPUT_TOKENS
    ? modelPricing.longContextInputMultiplier!
    : 1;
  const outputMultiplier = openAiLongContext && promptInputTokens > OPENAI_LONG_CONTEXT_INPUT_TOKENS
    ? modelPricing.longContextOutputMultiplier ?? 1
    : 1;

  let nanoUsd = usage.inputTokens * nanoUsdPerToken(modelPricing.input) * inputMultiplier;
  nanoUsd += usage.cachedInputTokens * nanoUsdPerToken(modelPricing.cacheRead) * inputMultiplier;
  nanoUsd += (usage.cacheReadInputTokens ?? 0) * nanoUsdPerToken(modelPricing.cacheRead);
  nanoUsd += usage.outputTokens * nanoUsdPerToken(modelPricing.output) * outputMultiplier;

  const hasCacheSplit = usage.cacheCreation1hInputTokens !== undefined || usage.cacheCreation5mInputTokens !== undefined;
  if (hasCacheSplit) {
    nanoUsd += (usage.cacheCreation1hInputTokens ?? 0)
      * nanoUsdPerToken(modelPricing.cacheWrite1h ?? modelPricing.cacheWrite5m ?? modelPricing.input) * inputMultiplier;
    nanoUsd += (usage.cacheCreation5mInputTokens ?? 0)
      * nanoUsdPerToken(modelPricing.cacheWrite5m ?? modelPricing.input) * inputMultiplier;
  } else if (usage.cacheCreationInputTokens) {
    nanoUsd += usage.cacheCreationInputTokens
      * nanoUsdPerToken(modelPricing.cacheWrite5m ?? modelPricing.input) * inputMultiplier;
  }

  return nanoUsd;
}

/** Returns whole micro-USD, rounding up only after the aggregate calculation. */
export function estimateSessionCostMicroUsd(
  model: string,
  usage: TokenUsage,
  timestamp = DEFAULT_PRICING_TIMESTAMP,
): number | null {
  const nanoUsd = estimateUsageCostNanoUsd(model, usage, timestamp);
  return nanoUsd === null ? null : Math.ceil(nanoUsd / 1_000);
}

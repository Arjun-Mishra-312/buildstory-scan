import type { Signal, TokenUsage } from "../contract.js";

export const CACHE_HIT_FORMULA = "round(100 * (cachedInputTokens + cacheReadInputTokens) / (inputTokens + cachedInputTokens + cacheReadInputTokens + cacheCreationInputTokens))";

/** Adapters normalize inputTokens to uncached input; cache buckets are disjoint. */
export function computeCacheHitSignal(usage: TokenUsage | null | undefined): Signal | null {
  if (!usage) return null;
  const buckets = [usage.inputTokens, usage.cachedInputTokens, usage.cacheReadInputTokens ?? 0, usage.cacheCreationInputTokens ?? 0];
  if (buckets.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const cached = usage.cachedInputTokens + (usage.cacheReadInputTokens ?? 0);
  const totalInput = buckets.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(totalInput) || totalInput === 0) return null;
  const share = Math.round(100 * cached / totalInput);
  if (share < 20) return null;
  return {
    id: "cache-hit-ratio", family: "spend",
    headline: `${share}% of your input tokens were served from cache`,
    detail: `${cached.toLocaleString("en-US")} of ${totalInput.toLocaleString("en-US")} input tokens, including cache reads and writes.`,
    value: share, unit: "%", notability: Math.min(100, Math.round(share * 1.1)),
    formula: CACHE_HIT_FORMULA, sourceRefs: [],
  };
}

/**
 * Static, versioned pricing for the AI coding-session models this scanner
 * observes (Claude Code, Codex) — not a live-fetched table, so a scan never
 * needs network access to price a session. Deliberately separate from the
 * web app's narrative/pricing.ts, which prices Buildstory's own
 * story-generation model calls, not a creator's coding-session spend.
 *
 * Matched by longest matching lowercase prefix, since providers append a
 * dated snapshot suffix (e.g. "claude-sonnet-4-5-20250929") that a table of
 * exact strings would go stale against almost immediately. An unmatched
 * model returns null from every lookup here — tokens are still shown, a
 * dollar figure is never guessed for a model this table doesn't recognize.
 *
 * Versioned so a historical report never silently re-prices when this table
 * is next updated; update PRICING_TABLE_VERSION whenever a rate changes.
 */

import type { TokenUsage } from "./contract.js";

export const SESSION_PRICING_TABLE_VERSION = "2026-08-05.1" as const;

interface ModelPricing {
  /** USD per million tokens, expressed as micro-USD per token (1 USD = 1,000,000 micro-USD). */
  input: number;
  output: number;
  /** Cache-write rate for providers that bill cache writes separately from input (Anthropic). */
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** Cache-read / cached-input rate, billed well below the base input rate. */
  cacheRead: number;
}

interface PricingEntry {
  /** Lowercase prefix matched against the model id. Longest match wins. */
  prefix: string;
  pricing: ModelPricing;
}

/**
 * Anthropic (Claude Code) and OpenAI (Codex) published per-token rates,
 * grouped by model family. Cursor and Gemini Antigravity are not priced:
 * their adapters never report tokenUsage, so there is nothing to price.
 */
const PRICING_TABLE: PricingEntry[] = [
  // Anthropic — Claude Code. Cache writes billed separately from base input;
  // cache reads billed well below it.
  { prefix: "claude-haiku", pricing: { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 } },
  { prefix: "claude-3-5-haiku", pricing: { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 } },
  { prefix: "claude-sonnet", pricing: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: "claude-3-5-sonnet", pricing: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: "claude-3-7-sonnet", pricing: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: "claude-opus", pricing: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 } },

  // OpenAI — Codex. No separate cache-write charge; cached input is billed
  // at a flat discount off the base input rate via cachedInputTokens.
  { prefix: "gpt-5-codex", pricing: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { prefix: "gpt-5-mini", pricing: { input: 0.25, output: 2, cacheRead: 0.025 } },
  { prefix: "gpt-5-nano", pricing: { input: 0.05, output: 0.4, cacheRead: 0.005 } },
  { prefix: "gpt-5", pricing: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { prefix: "gpt-4.1-mini", pricing: { input: 0.4, output: 1.6, cacheRead: 0.1 } },
  { prefix: "gpt-4.1", pricing: { input: 2, output: 8, cacheRead: 0.5 } },
  { prefix: "o4-mini", pricing: { input: 1.1, output: 4.4, cacheRead: 0.275 } },
  { prefix: "o3", pricing: { input: 2, output: 8, cacheRead: 0.5 } },
];

function findPricing(model: string): ModelPricing | null {
  const normalized = model.trim().toLocaleLowerCase("en-US");
  let best: PricingEntry | null = null;
  for (const entry of PRICING_TABLE) {
    if (!normalized.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best?.pricing ?? null;
}

export function isPricedModel(model: string): boolean {
  return findPricing(model) !== null;
}

/**
 * Returns whole micro-USD (rounded up so a fractional cost never reads as
 * free), or null when `model` isn't in the table — never a fabricated price.
 */
export function estimateSessionCostMicroUsd(model: string, usage: TokenUsage): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;

  let microUsd = usage.inputTokens * pricing.input + usage.outputTokens * pricing.output;
  microUsd += usage.reasoningOutputTokens * pricing.output;
  // OpenAI-style cached input: a discounted subset billed via cachedInputTokens.
  microUsd += usage.cachedInputTokens * pricing.cacheRead;
  // Anthropic-style cache read, always a separate bucket from cachedInputTokens.
  microUsd += (usage.cacheReadInputTokens ?? 0) * pricing.cacheRead;

  const cacheWrite1h = usage.cacheCreation1hInputTokens;
  const cacheWrite5m = usage.cacheCreation5mInputTokens;
  if (cacheWrite1h !== undefined || cacheWrite5m !== undefined) {
    microUsd += (cacheWrite1h ?? 0) * (pricing.cacheWrite1h ?? pricing.cacheWrite5m ?? pricing.input);
    microUsd += (cacheWrite5m ?? 0) * (pricing.cacheWrite5m ?? pricing.input);
  } else if (usage.cacheCreationInputTokens) {
    // No 1h/5m split reported; price the total at the base (5m) cache-write
    // rate as the conservative default — most cache writes are short-lived.
    microUsd += usage.cacheCreationInputTokens * (pricing.cacheWrite5m ?? pricing.input);
  }

  return Math.ceil(microUsd);
}

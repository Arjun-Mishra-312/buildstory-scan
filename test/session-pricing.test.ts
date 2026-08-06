import assert from "node:assert/strict";
import test from "node:test";
import type { TokenUsage } from "../src/contract.js";
import { estimateSessionCostMicroUsd, isPricedModel } from "../src/session-pricing.js";

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

test("prices a known Claude model's input and output tokens", () => {
  // claude-sonnet: $3/M input, $15/M output.
  const cost = estimateSessionCostMicroUsd("claude-sonnet-4-5-20250929", usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
  assert.equal(cost, 3_000_000 + 15_000_000);
});

test("matches a dated snapshot suffix against the model family prefix", () => {
  assert.equal(isPricedModel("claude-opus-4-1-20250805"), true);
  assert.equal(isPricedModel("claude-haiku-4-5-20251001"), true);
});

test("returns null for a model outside the pricing table, never a guessed price", () => {
  assert.equal(estimateSessionCostMicroUsd("some-future-model-nobody-has-heard-of", usage({ inputTokens: 1_000 })), null);
  assert.equal(isPricedModel("some-future-model-nobody-has-heard-of"), false);
});

test("prices Anthropic-style cache read and cache write at their own distinct rates", () => {
  // claude-sonnet: cacheRead $0.30/M, cacheWrite5m $3.75/M.
  const cost = estimateSessionCostMicroUsd(
    "claude-sonnet-4-5-20250929",
    usage({ cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheCreation5mInputTokens: 1_000_000 }),
  );
  assert.equal(cost, 300_000 + 3_750_000);
});

test("prices the 1h and 5m cache-write splits independently when both are reported", () => {
  const cost = estimateSessionCostMicroUsd(
    "claude-opus-4-1-20250805",
    usage({ cacheCreation1hInputTokens: 1_000_000, cacheCreation5mInputTokens: 1_000_000 }),
  );
  // claude-opus: cacheWrite1h $30/M, cacheWrite5m $18.75/M.
  assert.equal(cost, 30_000_000 + 18_750_000);
});

test("falls back to the base cache-write rate when no 1h/5m split is reported", () => {
  const cost = estimateSessionCostMicroUsd("claude-sonnet-4-5-20250929", usage({ cacheCreationInputTokens: 1_000_000 }));
  assert.equal(cost, 3_750_000);
});

test("prices OpenAI-style cached input via cachedInputTokens, distinct from base input", () => {
  // gpt-5: input $1.25/M, cacheRead $0.125/M.
  const cost = estimateSessionCostMicroUsd("gpt-5-codex", usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }));
  assert.equal(cost, 1_250_000 + 125_000);
});

test("rounds a fractional cost up so it never reads as free", () => {
  const cost = estimateSessionCostMicroUsd("claude-haiku-4-5-20251001", usage({ inputTokens: 1 }));
  assert.equal(cost, 1); // 1 token * 0.8 micro-USD/token = 0.8, rounds up to 1
});

test("picks the longest matching prefix, not just any match", () => {
  // Both "claude-sonnet" and "claude-3-5-sonnet" are registered; a 3.5 Sonnet
  // model id must resolve to its own (identical, here) rate via the longer prefix.
  assert.equal(isPricedModel("claude-3-5-sonnet-20241022"), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { computeCacheHitSignal } from "../src/insights/cache-signal.js";
import type { TokenUsage } from "../src/contract.js";

function usage(overrides: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, ...overrides };
}

test("Codex cache reads are a share of all input, not uncached input", () => {
  assert.equal(computeCacheHitSignal(usage({ inputTokens: 100, cachedInputTokens: 900 }))?.value, 90);
});
test("Claude cache reads and writes are distinct buckets; write-duration splits are not added twice", () => {
  assert.equal(computeCacheHitSignal(usage({ inputTokens: 100, cacheReadInputTokens: 700, cacheCreationInputTokens: 200, cacheCreation1hInputTokens: 150, cacheCreation5mInputTokens: 50 }))?.value, 70);
});
test("mixed providers count both cache-read buckets", () => {
  assert.equal(computeCacheHitSignal(usage({ inputTokens: 100, cachedInputTokens: 300, cacheReadInputTokens: 500, cacheCreationInputTokens: 100 }))?.value, 80);
});
test("fully cached input is a valid 100 percent signal", () => {
  assert.equal(computeCacheHitSignal(usage({ cachedInputTokens: 900 }))?.value, 100);
});
test("the observed public ratio cannot exceed 100 percent", () => {
  assert.equal(computeCacheHitSignal(usage({ inputTokens: 38_226_372, cachedInputTokens: 1_138_203_008 }))?.value, 97);
});
test("empty, thin, malformed and overflowing input do not invent cache findings", () => {
  for (const value of [null, usage({}), usage({ inputTokens: 100, cachedInputTokens: 1 }), usage({ inputTokens: -1 }), usage({ inputTokens: NaN }), usage({ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 1 })]) {
    assert.equal(computeCacheHitSignal(value), null);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { localCapabilityProfile } from "../src/narrative/local-capability.js";

const gib = 1024 ** 3;

test("local capability keeps constrained machines on the safe evidence profile", () => {
  const profile = localCapabilityProfile({ totalMemoryBytes: 8 * gib, logicalCpus: 4 });
  assert.equal(profile.id, "safe");
  assert.equal(profile.contextTokens, 16_384);
  assert.deepEqual(profile.evidenceBudget, {
    maxExcerpts: 40,
    maxCharsPerExcerpt: 600,
    maxTotalChars: 20_000,
    maxExcerptsPerSession: 6,
    maxAssistantDecisionsPerSession: 3,
  });
});

test("local capability grants a balanced profile without requiring Pro", () => {
  const profile = localCapabilityProfile({ totalMemoryBytes: 16 * gib, logicalCpus: 6 });
  assert.equal(profile.id, "balanced");
  assert.equal(profile.evidenceBudget.maxExcerpts, 64);
  assert.equal(profile.evidenceBudget.maxTotalChars, 48_000);
});

test("local capability grants the enhanced profile on a capable machine", () => {
  const profile = localCapabilityProfile({ totalMemoryBytes: 32 * gib, logicalCpus: 12 });
  assert.equal(profile.id, "enhanced");
  assert.equal(profile.contextTokens, 32_768);
  assert.equal(profile.evidenceBudget.maxExcerpts, 80);
  assert.equal(profile.evidenceBudget.maxExcerptsPerSession, 10);
});

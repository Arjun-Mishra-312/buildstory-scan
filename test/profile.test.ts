import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { computeBuilderProfile } from "../src/insights/profile.js";

test("profile scoring matches the shared fixture", async () => {
  const fixturePath = fileURLToPath(new URL("../../test/fixtures/profile-scoring.json", import.meta.url));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    inputs: Parameters<typeof computeBuilderProfile>[0];
    expected: {
      scores: Record<string, number>;
      archetype: string;
      workPatterns: Record<string, unknown>;
    };
  };
  const profile = computeBuilderProfile(fixture.inputs);
  assert.deepEqual(
    Object.fromEntries(Object.entries(profile.scores).map(([dimension, score]) => [dimension, score.value])),
    fixture.expected.scores,
  );
  assert.equal(profile.archetype.name, fixture.expected.archetype);
  assert.deepEqual(profile.workPatterns, fixture.expected.workPatterns);
  assert.match(profile.scores.productInstinct.caveat ?? "", /Weak proxy/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildCombinedMessages, NARRATIVE_SYSTEM_PROMPT } from "../src/engine/prompt.js";
import { computeBuilderProfile } from "../src/engine/index.js";

test("engine prompt builders are available without Node scanner I/O", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /Never give advice/);
  const snapshot = {
    schemaVersion: "1.7.0",
    scanId: "scan_test",
    generatedAt: "2026-08-13T00:00:00.000Z",
    sourceSelection: { providers: [], consent: { mode: "local-scan", statementVersion: "1.0", approvedActions: [] } },
    repository: { displayName: "fixture", fingerprint: "sha256:00", branch: "main", head: "abc", isBare: false, isDetached: false, remote: null },
    timeWindow: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z" },
    sessions: [],
    usage: { totalTurns: 0, totalToolCalls: 0, models: [], tools: [], tokenUsage: null, cost: { totalMicroUsd: null, pricedTokens: 0, unpricedTokens: 0, pricingTableVersion: "0" } },
    git: { commits: 0, insertions: 0, deletions: 0, fileTouches: 0, branches: 0, contributors: 0 },
    milestones: [],
    evidence: [],
    redaction: { categories: [], counts: {} },
    provenance: { scanner: { name: "buildstory", version: "1.2.0" }, consent: { mode: "local-scan", statementVersion: "1.0", approvedActions: [] } },
    quality: { warningCount: 0, warnings: [] },
  };
  const messages = buildCombinedMessages(snapshot as never, []);
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[1]?.content ?? "", /FACTS:/);
  const profile = computeBuilderProfile({
    sessions: [],
    usage: snapshot.usage as never,
    git: snapshot.git as never,
  });
  assert.ok(profile.archetype.name);
});

test("engine module source does not import git, filesystem session adapters, or Ink", async () => {
  const enginePath = fileURLToPath(new URL("../../src/engine/index.ts", import.meta.url));
  const promptPath = fileURLToPath(new URL("../../src/engine/prompt.ts", import.meta.url));
  const [engine, prompt] = await Promise.all([readFile(enginePath, "utf8"), readFile(promptPath, "utf8")]);
  for (const source of [engine, prompt]) {
    assert.doesNotMatch(source, /from "\.\.\/scanner\.js"/);
    assert.doesNotMatch(source, /from "\.\.\/repository\.js"/);
    assert.doesNotMatch(source, /from "ink"/);
    assert.doesNotMatch(source, /node:fs/);
    assert.doesNotMatch(source, /node:child_process/);
  }
});

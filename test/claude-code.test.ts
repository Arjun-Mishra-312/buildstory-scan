import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { buildProjectSnapshot } from "../src/scanner.js";
import { validateProjectSnapshot } from "../src/validation.js";
import { createLocalFixture } from "./helpers.js";

test("builds a deterministic, repository-scoped ProjectSnapshot from Claude Code transcripts", async () => {
  const fixture = await createLocalFixture();
  try {
    const options = {
      repositoryPath: fixture.repository,
      consent: "local-scan" as const,
      providers: ["claude-code"] as ["claude-code"],
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    };
    const first = await buildProjectSnapshot(options);
    const second = await buildProjectSnapshot(options);
    validateProjectSnapshot(first);
    assert.equal(canonicalJson(first), canonicalJson(second));

    // Exactly one session matched: the unrelated-cwd file must be excluded by scope.
    assert.equal(first.sessions.length, 1);
    const session = first.sessions[0];
    assert.ok(session);
    assert.equal(session.provider, "claude-code");
    assert.equal(session.sourceKind, "custom");

    // Turn counting excludes the tool-result continuation record: 2 genuine
    // user turns (one issued in plan mode), not 3.
    assert.equal(session.turns, 2);
    assert.equal(session.planModeTurns, 1);

    // Both assistant records carry a text block.
    assert.equal(session.assistantMessages, 2);

    // Exactly one tool_use block across the main file.
    assert.equal(session.toolCalls, 1);
    assert.deepEqual(session.toolRefs, ["Agent:Explore", "Read"]);
    assert.deepEqual(session.modelRefs, ["claude-fixture"]);

    // The trailing assistant stop_reason is "end_turn", not "tool_use".
    assert.equal(session.status, "completed");

    // One sibling subagent transcript was discovered and folded in.
    assert.equal(session.subagentInvocations, 1);

    // Token usage is SUMMED across both assistant messages plus the
    // subagent's own usage, not taken from only the latest message.
    const usage = session.tokenUsage;
    assert.ok(usage);
    assert.equal(usage.inputTokens, 175); // 100 + 50 (main) + 25 (subagent)
    assert.equal(usage.outputTokens, 35); // 20 + 10 (main) + 5 (subagent)
    assert.equal(usage.cacheCreationInputTokens, 10);
    assert.equal(usage.cacheCreation1hInputTokens, 6);
    assert.equal(usage.cacheCreation5mInputTokens, 4);
    assert.equal(usage.cacheReadInputTokens, 13); // 5 + 8
    assert.equal(usage.cachedInputTokens, 0); // no OpenAI-style cached-subset concept for this provider
    assert.equal(usage.totalTokens, 233);

    assert.equal(first.provenance.sessionFormats.includes("claude-code-jsonl"), true);
    assert.deepEqual(first.sourceSelection.providers[0]?.provider, "claude-code");
    assert.equal(first.sourceSelection.providers[0]?.sessionsMatched, 1);

    // Provider-specific assumptions are present; codex-specific ones are not.
    assert.equal(
      first.quality.assumptions.some((value) => value.startsWith("Claude Code")),
      true,
    );
    assert.equal(
      first.quality.assumptions.some((value) => value.startsWith("Codex")),
      false,
    );

    const serialized = canonicalJson(first);
    assert.equal(serialized.includes(fixture.repository), false);
    assert.equal(serialized.includes("synthetic transcript body"), false);
    assert.equal(serialized.includes("synthetic tool payload"), false);
    assert.equal(serialized.includes("different-repository"), false);
    assert.equal(serialized.includes("fixture-cc-unrelated"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("scanning both providers together produces sorted, attributable sessions", async () => {
  const fixture = await createLocalFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["claude-code", "codex"],
      codexHome: fixture.codexHome,
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    });
    assert.equal(snapshot.sessions.length, 2);
    assert.deepEqual(
      snapshot.sourceSelection.providers.map((selection) => selection.provider),
      ["claude-code", "codex"],
    );
    assert.deepEqual(snapshot.provenance.sessionFormats, ["claude-code-jsonl", "codex-jsonl"]);
    const sessionRefs = snapshot.sessions.map((session) => session.sessionRef);
    assert.equal(new Set(sessionRefs).size, sessionRefs.length);
  } finally {
    await fixture.cleanup();
  }
});

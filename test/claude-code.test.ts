import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { buildProjectSnapshot } from "../src/scanner.js";
import { createOllamaNarrativeGenerator } from "../src/narrative/local.js";
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

test("narrativeEvidence is absent by default and opt-in produces real, redacted excerpts", async () => {
  const fixture = await createLocalFixture();
  try {
    const withoutEvidence = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["claude-code"],
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    });
    assert.equal(withoutEvidence.narrativeEvidence, undefined);
    assert.equal(canonicalJson(withoutEvidence).includes("narrativeEvidence"), false);

    const withEvidence = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["claude-code"],
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
      narrativeEvidence: {},
    });
    validateProjectSnapshot(withEvidence);
    const bundle = withEvidence.narrativeEvidence;
    assert.ok(bundle);
    assert.equal(bundle.bundleVersion, "1.0.0");
    assert.equal(bundle.consent.mode, "explicit-cli-review");

    // The fixture's first user turn (plan mode) and its second/last turn
    // (mode changed to default, which is also the session's last message -
    // deduplicated to one excerpt, not counted under both plan-transition
    // and outcome).
    const roles = bundle.excerpts.map((excerpt) => excerpt.role).sort();
    assert.deepEqual(roles, ["plan-transition", "user-intent"]);
    assert.ok(bundle.excerpts.every((excerpt) => excerpt.sessionRef === withEvidence.sessions[0]?.sessionRef));
    assert.ok(bundle.excerpts.some((excerpt) => excerpt.text === "synthetic user turn one"));
    assert.ok(bundle.excerpts.some((excerpt) => excerpt.text === "synthetic user turn two"));

    // Every excerpt text is real, redacted conversation content - this is
    // the one field allowed to carry it - but never the discarded tool
    // payload/transcript placeholders from the fixture's other records.
    const serialized = canonicalJson(withEvidence);
    assert.equal(serialized.includes("synthetic transcript body"), false);
    assert.equal(serialized.includes("synthetic tool payload"), false);
    assert.equal(serialized.includes(fixture.repository), false);
  } finally {
    await fixture.cleanup();
  }
});

test("local narrative generation stays content-free at the upload boundary and re-redacts generated prose", async () => {
  const fixture = await createLocalFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["claude-code"],
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
      utcOffsetMinutes: -420,
      narrative: { mode: "local", model: "fixture-local" },
      narrativeGenerator: async ({ excerpts }) => {
        assert.ok(excerpts.length > 0);
        return {
          provider: "ollama" as const,
          model: "fixture-local",
          sections: {
            headline: "Local build story",
            narrative: "Generated on the local model.",
            turningPoint: "The private file /Users/arjun/private/repo and https://secret.example.invalid were never safe to upload.",
            learnings: ["Keep the model local."],
            decisionPatterns: ["Prefer bounded, reviewable changes."],
            standoutTraits: ["Checks the boundary."],
            growthEdge: "Validate the weak product-instinct proxy with more direct evidence.",
          },
          fallbacksUsed: [],
        };
      },
    });
    validateProjectSnapshot(snapshot);
    assert.equal(snapshot.narrativeEvidence, undefined);
    assert.equal(snapshot.generatedNarrative?.mode, "local");
    assert.equal(snapshot.generatedNarrative?.model, "fixture-local");
    assert.match(snapshot.generatedNarrative?.sections.turningPoint ?? "", /\[(absolute-path|remote-url|raw-host)\]/);
    assert.doesNotMatch(canonicalJson(snapshot), /Users\/arjun\/private\/repo|secret\.example\.invalid/);
    assert.equal(snapshot.timeWindow.utcOffsetMinutes, -420);
  } finally {
    await fixture.cleanup();
  }
});

test("the Ollama generator uses only loopback HTTP and splits narrative/profile calls", async () => {
  const fixture = await createLocalFixture();
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.BUILDSTORY_OLLAMA_BASE_URL;
  const requests: Array<{ url: string; body: string }> = [];
  let completionCalls = 0;
  process.env.BUILDSTORY_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, body });
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "gemma4:12b" }] }), { status: 200 });
    }
    completionCalls += 1;
    const response = completionCalls === 1
      ? {
          headline: "Local story",
          narrative: "A local narrative.",
          turningPoint: "The model mentioned app/api/route.ts and https://secret.example.invalid.",
          learnings: ["Keep excerpts local."],
        }
      : {
          decisionPatterns: ["Review before shipping."],
          standoutTraits: ["Keeps the feedback loop tight."],
          growthEdge: "Validate the weak product-instinct proxy with more evidence.",
        };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["claude-code"],
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
      narrative: { mode: "local" },
      narrativeGenerator: createOllamaNarrativeGenerator(),
    });
    assert.equal(snapshot.narrativeEvidence, undefined);
    assert.equal(snapshot.generatedNarrative?.model, "gemma4:12b");
    assert.equal(completionCalls, 2);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.url.startsWith("http://127.0.0.1:11434/")));
    assert.equal(requests.some((request) => request.body.includes("/Users/")), false);
    assert.doesNotMatch(snapshot.generatedNarrative?.sections.turningPoint ?? "", /app\/api\/route\.ts|secret\.example\.invalid/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.BUILDSTORY_OLLAMA_BASE_URL;
    else process.env.BUILDSTORY_OLLAMA_BASE_URL = originalBaseUrl;
    await fixture.cleanup();
  }
});

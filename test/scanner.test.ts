import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TokenUsage } from "../src/contract.js";
import { canonicalJson } from "../src/canonical-json.js";
import { writeSnapshotFile } from "../src/output.js";
import { aggregateUsage, buildProjectSnapshot, inspectSelectedRepository } from "../src/scanner.js";
import type { ProviderSession } from "../src/sources/types.js";
import { validateProjectSnapshot } from "../src/validation.js";
import { parseGitAiStats } from "../src/repository.js";
import { createLocalFixture } from "./helpers.js";

test("Git AI opt-in import keeps only content-free attribution aggregates", () => {
  const parsed = parseGitAiStats(JSON.stringify({ human_additions: 28, ai_additions: 76, ai_accepted: 47, tool_model_breakdown: { "claude_code/claude-sonnet": { ai_additions: 76, ai_accepted: 47 } }, transcript_url: "https://private.invalid", prompt: "secret" }));
  assert.deepEqual(parsed, { source: "git-ai", optIn: true, humanAdditions: 28, aiAdditions: 76, aiAccepted: 47, toolModels: [{ tool: "claude_code", model: "claude-sonnet", aiAdditions: 76, aiAccepted: 47 }] });
  assert.doesNotMatch(JSON.stringify(parsed), /private|prompt|transcript|https/);
});

test("builds a deterministic, repository-scoped ProjectSnapshot", async () => {
  const fixture = await createLocalFixture();
  try {
    const options = {
      repositoryPath: fixture.repository,
      consent: "local-scan" as const,
      providers: ["codex"] as ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    };
    const first = await buildProjectSnapshot(options);
    const second = await buildProjectSnapshot(options);
    validateProjectSnapshot(first);

    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.match(first.scanId, /^scan_[a-f0-9]{24}$/);
    assert.equal(first.sessions.length, 1);
    assert.equal(first.sessions[0]?.turns, 1);
    assert.equal(first.sessions[0]?.toolCalls, 1);
    assert.equal(first.eventSpine?.version, "1.0.0");
    assert.equal(first.eventSpine?.coverage.sessions, 1);
    assert.equal(first.eventSpine?.coverage.events, first.eventSpine?.events.length);
    assert.ok(first.eventSpine?.events.every((event) => event.privacy === "metadata-only"));
    assert.ok(first.eventSpine?.events.every((event, index, events) => index === 0 || events[index - 1]!.occurredAt <= event.occurredAt));
    assert.deepEqual(first.sessions[0]?.toolRefs, ["shell"]);
    assert.deepEqual(first.sessions[0]?.modelRefs, ["gpt-fixture"]);
    assert.equal(first.sourceSelection.providers[0]?.filesDiscovered, 2);
    assert.equal(first.sourceSelection.providers[0]?.sessionsMatched, 1);
    assert.equal(first.git.commits, 1);
    assert.equal(first.git.contributors, 1);
    assert.equal(first.redaction.transcriptBodiesDiscarded, 2);
    assert.equal(first.redaction.toolPayloadsDiscarded, 1);
    assert.deepEqual(first.repository.remote, {
      repositoryPathHash: first.repository.remote?.repositoryPathHash,
    });

    const serialized = canonicalJson(first);
    assert.equal(serialized.includes(fixture.repository), false);
    assert.equal(serialized.includes("fixture.txt"), false);
    assert.equal(serialized.includes("synthetic transcript body"), false);
    assert.equal(serialized.includes("synthetic tool payload"), false);
    assert.equal(serialized.includes("different-repository"), false);
    assert.equal(serialized.includes("private.example.invalid"), false);
    assert.equal(serialized.includes("secret-repository"), false);
    assert.equal(serialized.includes('"host"'), false);
  } finally {
    await fixture.cleanup();
  }
});

test("inspect reads repository identity without session sources", async () => {
  const fixture = await createLocalFixture();
  try {
    const report = await inspectSelectedRepository(fixture.repository);
    assert.equal(report.collectionMode, "local-read-only");
    assert.equal(report.sessionSourcesRead, false);
    assert.equal(report.networkAccessed, false);
    assert.equal(report.repository.rootPathIncluded, false);
    assert.equal(canonicalJson(report).includes(fixture.repository), false);
  } finally {
    await fixture.cleanup();
  }
});

test("writes validated snapshots only outside the selected repository", async () => {
  const fixture = await createLocalFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    });
    const outputPath = path.join(fixture.outputDirectory, "snapshot.json");
    await writeSnapshotFile(snapshot, { outputPath, repositoryRoot: fixture.repository });
    assert.equal(await readFile(outputPath, "utf8"), canonicalJson(snapshot));
    await assert.rejects(
      writeSnapshotFile(snapshot, { outputPath, repositoryRoot: fixture.repository }),
      /already exists/,
    );
    await writeSnapshotFile(snapshot, { outputPath, repositoryRoot: fixture.repository, overwrite: true });
    assert.equal(await readFile(outputPath, "utf8"), canonicalJson(snapshot));

    await assert.rejects(
      writeSnapshotFile(snapshot, {
        outputPath: path.join(fixture.repository, "snapshot.json"),
        repositoryRoot: fixture.repository,
      }),
      /outside the selected repository/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("with no --since, defaults to full observed history rather than a rolling lookback", async () => {
  const fixture = await createLocalFixture();
  try {
    // The shared fixture's session lands on 2026-08-03. Plant a second,
    // genuinely old Codex session (well outside any 30-day lookback from
    // that date) to prove it is no longer silently dropped by default.
    const oldSessionDirectory = path.join(fixture.codexHome, "sessions", "2026", "06", "01");
    await mkdir(oldSessionDirectory, { recursive: true });
    const oldRecords = [
      {
        timestamp: "2026-06-01T09:00:00Z",
        type: "session_meta",
        payload: { id: "fixture-old-session", timestamp: "2026-06-01T09:00:00Z", cwd: fixture.repository, model_provider: "openai" },
      },
      {
        timestamp: "2026-06-01T09:00:01Z",
        type: "turn_context",
        payload: { cwd: fixture.repository, model: "gpt-fixture" },
      },
      {
        timestamp: "2026-06-01T09:00:02Z",
        type: "event_msg",
        payload: { type: "user_message", message: "[synthetic transcript body omitted by scanner]" },
      },
      {
        timestamp: "2026-06-01T09:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 40,
              cached_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 0,
              total_tokens: 50,
            },
          },
        },
      },
      { timestamp: "2026-06-01T09:00:04Z", type: "event_msg", payload: { type: "task_complete" } },
    ];
    await writeFile(
      path.join(oldSessionDirectory, "old.jsonl"),
      `${oldRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      // No --since/--until: exercises the default window.
    });
    validateProjectSnapshot(snapshot);

    assert.equal(snapshot.timeWindow.startBasis, "full-history");
    assert.equal(snapshot.timeWindow.start, "2026-06-01T09:00:00.000Z");
    const sessionRefs = snapshot.sessions.map((session) => session.sessionRef);
    assert.equal(snapshot.sessions.length, 2, `expected both the old and new sessions to be included, got: ${sessionRefs.join(", ")}`);
  } finally {
    await fixture.cleanup();
  }
});

test("usage.coverage reports a session excluded by an explicit --since as outside-window, never silently", async () => {
  const fixture = await createLocalFixture();
  try {
    const oldSessionDirectory = path.join(fixture.codexHome, "sessions", "2026", "06", "01");
    await mkdir(oldSessionDirectory, { recursive: true });
    const oldRecords = [
      {
        timestamp: "2026-06-01T09:00:00Z",
        type: "session_meta",
        payload: { id: "fixture-old-session-2", timestamp: "2026-06-01T09:00:00Z", cwd: fixture.repository, model_provider: "openai" },
      },
      {
        timestamp: "2026-06-01T09:00:01Z",
        type: "turn_context",
        payload: { cwd: fixture.repository, model: "gpt-fixture" },
      },
      {
        timestamp: "2026-06-01T09:00:02Z",
        type: "event_msg",
        payload: { type: "user_message", message: "[synthetic transcript body omitted by scanner]" },
      },
      { timestamp: "2026-06-01T09:00:03Z", type: "event_msg", payload: { type: "task_complete" } },
    ];
    await writeFile(
      path.join(oldSessionDirectory, "old.jsonl"),
      `${oldRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    // --since starts after the old session but at/before the shared
    // fixture's 2026-08-03 session, so exactly one of the two discovered
    // sessions is excluded by the window.
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    });
    validateProjectSnapshot(snapshot);

    assert.equal(snapshot.sessions.length, 1, "the old session must not appear in the included sessions");
    assert.ok(snapshot.usage.coverage, "coverage must be present on a current-scanner snapshot");
    assert.equal(snapshot.usage.coverage!.sessionsDiscovered, 2);
    assert.equal(snapshot.usage.coverage!.sessionsIncluded, 1);
    assert.equal(snapshot.usage.coverage!.sessionsSkipped, 1);
    assert.deepEqual(snapshot.usage.coverage!.skipped, [{ reason: "outside-window", count: 1 }]);
  } finally {
    await fixture.cleanup();
  }
});

test("aggregateUsage splits a partially-priced model's tokens into priced/unpriced, not all-or-nothing", () => {
  // A model can price successfully on some responses and fail on others
  // within the same session (e.g. a dated pricing entry's effective window
  // ends mid-session) - the adapters attribute each response's tokens to
  // pricedTokenUsage or unpricedTokenUsage individually. This constructs
  // that split directly, bypassing the pricing table, to pin down what
  // aggregateUsage does with a ModelCounts entry that already has one.
  const pricedTokenUsage: TokenUsage = {
    inputTokens: 1_000,
    cachedInputTokens: 0,
    outputTokens: 500,
    reasoningOutputTokens: 0,
    totalTokens: 1_500,
  };
  const unpricedTokenUsage: TokenUsage = {
    inputTokens: 200,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    totalTokens: 300,
  };
  const combinedTokenUsage: TokenUsage = {
    inputTokens: pricedTokenUsage.inputTokens + unpricedTokenUsage.inputTokens,
    cachedInputTokens: 0,
    outputTokens: pricedTokenUsage.outputTokens + unpricedTokenUsage.outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: pricedTokenUsage.totalTokens + unpricedTokenUsage.totalTokens,
  };

  const session: ProviderSession = {
    summary: {
      sessionRef: "ses_test_partial_pricing",
      provider: "codex",
      sourceKind: "active",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T01:00:00.000Z",
      status: "completed",
      workingDirectoryRelation: "repository-root",
      summary: "synthetic partial-pricing test session",
      turns: 2,
      assistantMessages: 2,
      toolCalls: 0,
      modelRefs: ["test-partial-model"],
      toolRefs: [],
      tokenUsage: combinedTokenUsage,
    },
    toolCounts: new Map(),
    modelCounts: new Map([
      [
        "test-partial-model",
        {
          provider: "openai",
          turns: 2,
          tokenUsage: combinedTokenUsage,
          pricedTokenUsage,
          unpricedTokenUsage,
          costNanoUsd: 5_000_000, // $0.005, covering only the priced 1,500 tokens
        },
      ],
    ]),
    evidence: [],
  };

  const { usage, partiallyPricedModels } = aggregateUsage([session]);

  assert.equal(usage.cost.pricedTokens, 1_500, "priced tokens must reflect only the successfully-priced records");
  assert.equal(usage.cost.unpricedTokens, 300, "unpriced tokens must not be silently absorbed into priced tokens");
  assert.equal(usage.cost.totalMicroUsd, 5_000, "the total must be the exact sum of the priced records' nano-cost, unrounded by the unpriced remainder");
  assert.equal(usage.models[0]?.costMicroUsd, 5_000);
  assert.equal(usage.models[0]?.tokenUsage?.totalTokens, 1_800, "the model's displayed token usage stays the full combined total");
  assert.equal(partiallyPricedModels, 1, "a model with both priced and unpriced tokens must be flagged as partially priced");
});

test("aggregateUsage does not flag a fully-priced or fully-unpriced model as partial", () => {
  const fullyPriced: TokenUsage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 150 };
  const fullyUnpriced: TokenUsage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 };

  const makeSession = (sessionRef: string, model: string, tokenUsage: TokenUsage, pricedTokenUsage: TokenUsage | null, unpricedTokenUsage: TokenUsage | null, costNanoUsd: number | null): ProviderSession => ({
    summary: {
      sessionRef,
      provider: "codex",
      sourceKind: "active",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T01:00:00.000Z",
      status: "completed",
      workingDirectoryRelation: "repository-root",
      summary: "synthetic test session",
      turns: 1,
      assistantMessages: 1,
      toolCalls: 0,
      modelRefs: [model],
      toolRefs: [],
      tokenUsage,
    },
    toolCounts: new Map(),
    modelCounts: new Map([[model, { provider: "openai", turns: 1, tokenUsage, pricedTokenUsage, unpricedTokenUsage, costNanoUsd }]]),
    evidence: [],
  });

  const { usage, partiallyPricedModels } = aggregateUsage([
    makeSession("ses_fully_priced", "test-priced-model", fullyPriced, fullyPriced, null, 1_000_000),
    makeSession("ses_fully_unpriced", "test-unpriced-model", fullyUnpriced, null, fullyUnpriced, null),
  ]);

  assert.equal(partiallyPricedModels, 0);
  assert.equal(usage.cost.pricedTokens, 150);
  assert.equal(usage.cost.unpricedTokens, 15);
});

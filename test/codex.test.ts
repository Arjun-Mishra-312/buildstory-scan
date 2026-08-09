import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalJson } from "../src/canonical-json.js";
import { buildProjectSnapshot } from "../src/scanner.js";
import { validateProjectSnapshot } from "../src/validation.js";
import { estimateSessionCostMicroUsd } from "../src/session-pricing.js";

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync("git", ["-C", repository, ...args], { windowsHide: true, env: { ...process.env, ...env } });
}

interface CodexNarrativeFixture {
  root: string;
  repository: string;
  codexHome: string;
  cleanup(): Promise<void>;
}

/**
 * A Codex-specific fixture with real (non-placeholder) conversation text, so
 * narrative-evidence assertions aren't ambiguous with the shared metrics
 * fixture's "[synthetic transcript body omitted by scanner]" placeholders.
 */
async function createCodexNarrativeFixture(): Promise<CodexNarrativeFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-codex-test-"));
  const repository = path.join(root, "selected-repository");
  const codexHome = path.join(root, "codex-home");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "04");
  await Promise.all([mkdir(repository, { recursive: true }), mkdir(sessionDirectory, { recursive: true })]);

  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.name", "Fixture Builder"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repository, "fixture.txt"), "synthetic fixture\n", "utf8");
  await git(repository, ["add", "fixture.txt"]);
  await git(repository, ["commit", "--quiet", "-m", "fixture commit"], {
    GIT_AUTHOR_DATE: "2026-08-04T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-04T09:00:00Z",
  });

  const records: Array<Record<string, unknown> | string> = [
    {
      timestamp: "2026-08-04T10:00:00Z",
      type: "session_meta",
      payload: { id: "codex-narrative-session", timestamp: "2026-08-04T10:00:00Z", cwd: repository, model_provider: "openai" },
    },
    {
      timestamp: "2026-08-04T10:00:01Z",
      type: "turn_context",
      payload: { cwd: repository, model: "gpt-fixture" },
    },
    {
      timestamp: "2026-08-04T10:00:02Z",
      type: "event_msg",
      payload: { type: "user_message", message: "codex narrative first user turn" },
    },
    {
      timestamp: "2026-08-04T10:00:03Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "codex narrative pre-edit assistant statement" },
    },
    {
      timestamp: "2026-08-04T10:00:04Z",
      type: "response_item",
      payload: { type: "function_call", name: "apply_patch", arguments: "{}" },
    },
    {
      timestamp: "2026-08-04T10:00:05Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "ok" },
    },
    {
      timestamp: "2026-08-04T10:00:06Z",
      type: "event_msg",
      payload: { type: "user_message", message: "codex narrative last user turn" },
    },
    { timestamp: "2026-08-04T10:00:07Z", type: "event_msg", payload: { type: "task_complete" } },
    // A malformed line and an oversized line, mixed in to exercise the same
    // streaming safety limits readEvents relies on (consumeJsonLines).
    "not-json-at-all",
  ];

  const lines = records.map((record) => (typeof record === "string" ? record : JSON.stringify(record)));
  await writeFile(path.join(sessionDirectory, "narrative.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const unrelatedRecords = [
    {
      timestamp: "2026-08-04T11:00:00Z",
      type: "session_meta",
      payload: { id: "codex-narrative-unrelated", cwd: path.join(root, "different-repository"), model_provider: "openai" },
    },
    {
      timestamp: "2026-08-04T11:00:01Z",
      type: "event_msg",
      payload: { type: "user_message", message: "this must never appear in any snapshot" },
    },
  ];
  await writeFile(
    path.join(sessionDirectory, "unrelated.jsonl"),
    `${unrelatedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  return { root, repository, codexHome, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

test("Codex sessions produce non-zero, redacted narrative-evidence excerpts", async () => {
  const fixture = await createCodexNarrativeFixture();
  try {
    const withoutEvidence = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
    });
    assert.equal(withoutEvidence.narrativeEvidence, undefined);

    const withEvidence = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
      narrativeEvidence: {},
    });
    validateProjectSnapshot(withEvidence);
    const bundle = withEvidence.narrativeEvidence;
    assert.ok(bundle);
    // This is the exact regression the whole plan exists to fix: a
    // Codex-only scan used to contribute zero narrative candidates.
    assert.ok(bundle.excerpts.length > 0);

    const roles = bundle.excerpts.map((excerpt) => excerpt.role).sort();
    assert.deepEqual(roles, ["assistant-decision", "outcome", "user-intent"]);
    assert.ok(bundle.excerpts.some((excerpt) => excerpt.text === "codex narrative first user turn"));
    assert.ok(bundle.excerpts.some((excerpt) => excerpt.text === "codex narrative last user turn"));
    assert.ok(bundle.excerpts.some((excerpt) => excerpt.text === "codex narrative pre-edit assistant statement"));
    assert.ok(bundle.excerpts.every((excerpt) => excerpt.sessionRef === withEvidence.sessions[0]?.sessionRef));

    const serialized = canonicalJson(withEvidence);
    assert.equal(serialized.includes(fixture.repository), false);
    assert.equal(serialized.includes("different-repository"), false);
    assert.equal(serialized.includes("this must never appear"), false);

    // Deterministic: rebuilding the same scan produces byte-identical output.
    const rebuilt = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
      narrativeEvidence: {},
    });
    assert.equal(canonicalJson(withEvidence), canonicalJson(rebuilt));
  } finally {
    await fixture.cleanup();
  }
});

test("Codex narrative evidence respects a small maxExcerpts budget deterministically", async () => {
  const fixture = await createCodexNarrativeFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
      narrativeEvidence: { maxExcerpts: 1 },
    });
    const bundle = snapshot.narrativeEvidence;
    assert.ok(bundle);
    assert.equal(bundle.excerpts.length, 1);
    assert.ok(bundle.discarded.rejectedByBudget > 0);
  } finally {
    await fixture.cleanup();
  }
});

test("deep narrative selector quotas remain internal and the emitted evidence policy validates", async () => {
  const fixture = await createCodexNarrativeFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
      narrativeEvidence: {
        maxExcerpts: 240,
        maxCharsPerExcerpt: 1_500,
        maxTotalChars: 700 * 1024,
        maxTotalBytes: 700 * 1024,
        maxExcerptsPerSession: 12,
        maxAssistantDecisionsPerSession: 6,
        policyVersion: "deep-evidence-v2",
      },
    });

    assert.deepEqual(Object.keys(snapshot.narrativeEvidence?.policy ?? {}).sort(), [
      "excerptSelection",
      "maxCharsPerExcerpt",
      "maxExcerpts",
      "maxTotalBytes",
      "maxTotalChars",
    ]);
    assert.equal(snapshot.narrativeEvidence?.policy.excerptSelection, "deep-evidence-v2");
    assert.doesNotThrow(() => validateProjectSnapshot(snapshot));
  } finally {
    await fixture.cleanup();
  }
});

test("a Codex session keeps per-response model usage across switches and resets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-codex-model-ledger-"));
  try {
    const repository = path.join(root, "repo");
    const codexHome = path.join(root, "codex-home");
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "04");
    await Promise.all([mkdir(repository, { recursive: true }), mkdir(sessionDirectory, { recursive: true })]);
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.name", "Fixture Builder"]);
    await git(repository, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(repository, "fixture.txt"), "synthetic fixture\n", "utf8");
    await git(repository, ["add", "fixture.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "fixture commit"], {
      GIT_AUTHOR_DATE: "2026-08-04T09:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-04T09:00:00Z",
    });

    const records = [
      {
        timestamp: "2026-08-04T10:00:00Z",
        type: "session_meta",
          payload: { id: "model-ledger-session", timestamp: "2026-08-04T10:00:00Z", cwd: repository, model_provider: "openai" },
      },
      { timestamp: "2026-08-04T10:00:01Z", type: "turn_context", payload: { cwd: repository, model: "gpt-5-mini" } },
      {
        timestamp: "2026-08-04T10:00:02Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 10,
              reasoning_output_tokens: 4,
              total_tokens: 110,
            },
          },
        },
      },
      {
        timestamp: "2026-08-04T10:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 10,
              reasoning_output_tokens: 4,
              total_tokens: 110,
            },
          },
        },
      },
      { timestamp: "2026-08-04T10:00:04Z", type: "turn_context", payload: { cwd: repository, model: "gpt-5.6-sol" } },
      {
        timestamp: "2026-08-04T10:00:05Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 240,
              cached_input_tokens: 40,
              output_tokens: 30,
              reasoning_output_tokens: 12,
              total_tokens: 270,
            },
          },
        },
      },
      {
        timestamp: "2026-08-04T10:00:06Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            // When present, last_token_usage is the accepted response ledger
            // entry even when cumulative totals are repeated.
            last_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 10,
              output_tokens: 5,
              reasoning_output_tokens: 2,
              total_tokens: 55,
            },
            total_token_usage: {
              input_tokens: 290,
              cached_input_tokens: 50,
              output_tokens: 35,
              reasoning_output_tokens: 14,
              total_tokens: 325,
            },
          },
        },
      },
      {
        timestamp: "2026-08-04T10:00:07Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            // A decrease starts a new cumulative segment rather than creating
            // negative deltas.
            total_token_usage: {
              input_tokens: 8,
              cached_input_tokens: 2,
              output_tokens: 3,
              reasoning_output_tokens: 1,
              total_tokens: 11,
            },
          },
        },
      },
      { timestamp: "2026-08-04T10:00:05Z", type: "event_msg", payload: { type: "task_complete" } },
    ];
    await writeFile(
      path.join(sessionDirectory, "dominant-model.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const snapshot = await buildProjectSnapshot({
      repositoryPath: repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
    });
    validateProjectSnapshot(snapshot);

    const byName = new Map(snapshot.usage.models.map((model) => [model.name, model]));
    const dominant = byName.get("gpt-5.6-sol");
    const minor = byName.get("gpt-5-mini");
    assert.ok(dominant);
    assert.ok(minor);
    assert.equal(dominant.turnCount, 3);
    assert.equal(minor.turnCount, 1);

    // The first cumulative segment contributes 110 tokens to the mini model;
    // the next segment contributes 160, then a direct last-token usage record
    // contributes 55, and the reset segment contributes 11 to Sol.
    assert.equal(minor.tokenUsage?.totalTokens, 110);
    assert.equal(dominant.tokenUsage?.totalTokens, 226);
    assert.equal(dominant.costMicroUsd, estimateSessionCostMicroUsd("gpt-5.6-sol", dominant.tokenUsage!));
    assert.equal(snapshot.usage.tokenUsage?.totalTokens, 336);
    assert.ok(snapshot.quality.assumptions.some((value) => value.includes("per accepted token-count response")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a single omitted field in a cumulative token_count does not re-add the whole running total", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-codex-partial-reset-"));
  try {
    const repository = path.join(root, "repo");
    const codexHome = path.join(root, "codex-home");
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "04");
    await Promise.all([mkdir(repository, { recursive: true }), mkdir(sessionDirectory, { recursive: true })]);
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.name", "Fixture Builder"]);
    await git(repository, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(repository, "fixture.txt"), "synthetic fixture\n", "utf8");
    await git(repository, ["add", "fixture.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "fixture commit"], {
      GIT_AUTHOR_DATE: "2026-08-04T09:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-04T09:00:00Z",
    });

    const records = [
      {
        timestamp: "2026-08-04T10:00:00Z",
        type: "session_meta",
        payload: { id: "partial-reset-session", timestamp: "2026-08-04T10:00:00Z", cwd: repository, model_provider: "openai" },
      },
      { timestamp: "2026-08-04T10:00:01Z", type: "turn_context", payload: { cwd: repository, model: "gpt-5-mini" } },
      {
        timestamp: "2026-08-04T10:00:02Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 170 },
          },
        },
      },
      {
        // Every field keeps climbing except reasoning_output_tokens, which
        // this record omits entirely (parses as 0). A naive "any field
        // decreased" reset would misread the whole cumulative snapshot as
        // restarted and re-add all 210 tokens on top of the 170 already
        // counted, instead of the true 40-token delta.
        timestamp: "2026-08-04T10:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 150, cached_input_tokens: 0, output_tokens: 60, total_tokens: 210 },
          },
        },
      },
      { timestamp: "2026-08-04T10:00:04Z", type: "event_msg", payload: { type: "task_complete" } },
    ];
    await writeFile(
      path.join(sessionDirectory, "partial-reset.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const snapshot = await buildProjectSnapshot({
      repositoryPath: repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
    });
    validateProjectSnapshot(snapshot);

    const model = snapshot.usage.models.find((entry) => entry.name === "gpt-5-mini");
    assert.ok(model);
    assert.equal(model.tokenUsage?.totalTokens, 210, "must be the true cumulative total (170 then a 40-token delta), not 380 from a false reset re-adding the second record whole");
    assert.equal(model.tokenUsage?.inputTokens, 150);
    assert.equal(model.tokenUsage?.outputTokens, 60);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex Voice session contributes only the segment after cwd changes into the repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-codex-cwd-transition-"));
  try {
    const repository = path.join(root, "repo");
    const voiceDirectory = path.join(root, "realtime-voice-chat");
    const codexHome = path.join(root, "codex-home");
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "04");
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(voiceDirectory, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.name", "Fixture Builder"]);
    await git(repository, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(repository, "fixture.txt"), "cwd transition fixture\n", "utf8");
    await git(repository, ["add", "fixture.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "fixture commit"], {
      GIT_AUTHOR_DATE: "2026-08-04T08:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-04T08:00:00Z",
    });

    const records = [
      {
        timestamp: "2026-08-04T09:00:00Z",
        type: "session_meta",
        payload: { id: "voice-to-project", timestamp: "2026-08-04T09:00:00Z", cwd: voiceDirectory, model_provider: "openai" },
      },
      { timestamp: "2026-08-04T09:00:01Z", type: "turn_context", payload: { cwd: voiceDirectory, model: "gpt-5.6-terra" } },
      { timestamp: "2026-08-04T09:00:02Z", type: "event_msg", payload: { type: "user_message", message: "voice-only user text" } },
      { timestamp: "2026-08-04T09:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "voice-only assistant text" } },
      {
        timestamp: "2026-08-04T09:00:04Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110 } },
        },
      },
      { timestamp: "2026-08-04T10:00:00Z", type: "turn_context", payload: { cwd: repository, model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-04T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "project user text" } },
      { timestamp: "2026-08-04T10:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "project assistant decision" } },
      { timestamp: "2026-08-04T10:00:03Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } },
      {
        timestamp: "2026-08-04T10:00:04Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 50, output_tokens: 30, total_tokens: 280 } },
        },
      },
      { timestamp: "2026-08-04T10:00:05Z", type: "event_msg", payload: { type: "task_complete" } },
      { timestamp: "2026-08-04T11:00:00Z", type: "turn_context", payload: { cwd: voiceDirectory, model: "gpt-5.6-terra" } },
      { timestamp: "2026-08-04T11:00:01Z", type: "event_msg", payload: { type: "user_message", message: "voice-only trailing text" } },
      {
        timestamp: "2026-08-04T11:00:02Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 400, cached_input_tokens: 80, output_tokens: 50, total_tokens: 450 } },
        },
      },
    ];
    await writeFile(
      path.join(sessionDirectory, "voice-to-project.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const snapshot = await buildProjectSnapshot({
      repositoryPath: repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome,
      since: "2026-08-04T00:00:00Z",
      until: "2026-08-05T00:00:00Z",
      narrativeEvidence: {},
    });
    validateProjectSnapshot(snapshot);

    assert.equal(snapshot.sessions.length, 1);
    const session = snapshot.sessions[0]!;
    assert.equal(session.startedAt, "2026-08-04T10:00:00.000Z");
    assert.equal(session.endedAt, "2026-08-04T10:00:05.000Z");
    assert.equal(session.turns, 1);
    assert.equal(session.assistantMessages, 1);
    assert.equal(session.toolCalls, 1);
    assert.deepEqual(session.modelRefs, ["gpt-5.6-sol"]);
    assert.equal(session.tokenUsage?.totalTokens, 170);
    assert.equal(snapshot.usage.models.some((model) => model.name === "gpt-5.6-terra"), false);
    const excerpts = snapshot.narrativeEvidence?.excerpts ?? [];
    assert.ok(excerpts.some((excerpt) => excerpt.text === "project user text"));
    assert.equal(excerpts.some((excerpt) => excerpt.text.includes("voice-only")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

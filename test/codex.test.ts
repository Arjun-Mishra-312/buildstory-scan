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

test("a Codex session that switches models attributes its cumulative token snapshot to the dominant model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-codex-dominant-model-"));
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
        payload: { id: "dominant-model-session", timestamp: "2026-08-04T10:00:00Z", cwd: repository, model_provider: "openai" },
      },
      // gpt-5-mini gets one turn; gpt-5 gets two - gpt-5 is dominant.
      { timestamp: "2026-08-04T10:00:01Z", type: "turn_context", payload: { cwd: repository, model: "gpt-5-mini" } },
      { timestamp: "2026-08-04T10:00:02Z", type: "turn_context", payload: { cwd: repository, model: "gpt-5" } },
      { timestamp: "2026-08-04T10:00:03Z", type: "turn_context", payload: { cwd: repository, model: "gpt-5" } },
      {
        timestamp: "2026-08-04T10:00:04Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_000_000,
              cached_input_tokens: 0,
              output_tokens: 1_000_000,
              reasoning_output_tokens: 0,
              total_tokens: 2_000_000,
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
    const dominant = byName.get("gpt-5");
    const minor = byName.get("gpt-5-mini");
    assert.ok(dominant);
    assert.ok(minor);
    assert.equal(dominant.turnCount, 2);
    assert.equal(minor.turnCount, 1);

    // The whole cumulative snapshot lands on the dominant model...
    assert.equal(dominant.tokenUsage?.totalTokens, 2_000_000);
    assert.equal(dominant.costMicroUsd, estimateSessionCostMicroUsd("gpt-5", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000, reasoningOutputTokens: 0, totalTokens: 2_000_000 }));
    // ...and the minor model correctly reports no tokens, not a fabricated split.
    assert.equal(minor.tokenUsage, null);
    assert.equal(minor.costMicroUsd, null);

    assert.ok(
      snapshot.quality.assumptions.some((value) => value.includes("attributes its tokens and estimated cost to whichever model had the most turns")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

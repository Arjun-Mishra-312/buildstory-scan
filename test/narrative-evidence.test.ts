import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildProjectSnapshot } from "../src/scanner.js";

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync("git", ["-C", repository, ...args], { windowsHide: true, env: { ...process.env, ...env } });
}

/** Mirrors claude-code.ts's encodedDirectoryPrefix exactly. */
function encodedClaudeCodeProjectDirectory(repositoryRoot: string): string {
  return path.resolve(repositoryRoot).replaceAll(/[^A-Za-z0-9]/g, "-").toLocaleLowerCase("en-US");
}

interface MixedProviderFixture {
  root: string;
  repository: string;
  codexHome: string;
  claudeCodeHome: string;
  cleanup(): Promise<void>;
}

/** A repository with a Codex session and a Claude Code session, each with 3+ narrative candidates. */
async function createMixedProviderFixture(): Promise<MixedProviderFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-mixed-test-"));
  const repository = path.join(root, "selected-repository");
  const codexHome = path.join(root, "codex-home");
  const claudeCodeHome = path.join(root, "claude-code-home");
  const codexSessionDir = path.join(codexHome, "sessions", "2026", "08", "05");
  const claudeProjectDir = path.join(claudeCodeHome, "projects", encodedClaudeCodeProjectDirectory(repository));
  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(codexSessionDir, { recursive: true }),
    mkdir(claudeProjectDir, { recursive: true }),
  ]);

  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.name", "Fixture Builder"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repository, "fixture.txt"), "synthetic fixture\n", "utf8");
  await git(repository, ["add", "fixture.txt"]);
  await git(repository, ["commit", "--quiet", "-m", "fixture commit"], {
    GIT_AUTHOR_DATE: "2026-08-05T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-05T09:00:00Z",
  });

  const codexRecords = [
    { timestamp: "2026-08-05T10:00:00Z", type: "session_meta", payload: { id: "mixed-codex-session", timestamp: "2026-08-05T10:00:00Z", cwd: repository, model_provider: "openai" } },
    { timestamp: "2026-08-05T10:00:01Z", type: "turn_context", payload: { cwd: repository, model: "gpt-fixture" } },
    { timestamp: "2026-08-05T10:00:02Z", type: "event_msg", payload: { type: "user_message", message: "codex fairness first user turn" } },
    { timestamp: "2026-08-05T10:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "codex fairness assistant statement" } },
    { timestamp: "2026-08-05T10:00:04Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } },
    { timestamp: "2026-08-05T10:00:05Z", type: "event_msg", payload: { type: "user_message", message: "codex fairness last user turn" } },
    { timestamp: "2026-08-05T10:00:06Z", type: "event_msg", payload: { type: "task_complete" } },
  ];
  await writeFile(
    path.join(codexSessionDir, "fairness.jsonl"),
    `${codexRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  const claudeSessionId = "mixed-claude-session";
  const claudeRecords = [
    { type: "custom-title", sessionId: claudeSessionId, cwd: repository, timestamp: "2026-08-05T10:01:00Z", customTitle: "claude fairness session title" },
    { type: "user", sessionId: claudeSessionId, cwd: repository, timestamp: "2026-08-05T10:01:01Z", permissionMode: "plan", message: { role: "user", content: "claude fairness first user turn" } },
    {
      type: "assistant",
      sessionId: claudeSessionId,
      cwd: repository,
      timestamp: "2026-08-05T10:01:02Z",
      message: {
        role: "assistant",
        model: "claude-fixture",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "claude fairness assistant statement" },
          { type: "tool_use", id: "toolu_1", name: "Edit", input: {} },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    { type: "user", sessionId: claudeSessionId, cwd: repository, timestamp: "2026-08-05T10:01:03Z", permissionMode: "default", message: { role: "user", content: "claude fairness last user turn" } },
  ];
  await writeFile(
    path.join(claudeProjectDir, `${claudeSessionId}.jsonl`),
    `${claudeRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  return { root, repository, codexHome, claudeCodeHome, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

test("a tight global budget is allocated fairly across providers, not exhausted by whichever provider sorts first", async () => {
  const fixture = await createMixedProviderFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["claude-code", "codex"],
      codexHome: fixture.codexHome,
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
      narrativeEvidence: { maxExcerpts: 2 },
    });
    const bundle = snapshot.narrativeEvidence;
    assert.ok(bundle);
    assert.equal(bundle.excerpts.length, 2);

    const sessionProvider = new Map(snapshot.sessions.map((session) => [session.sessionRef, session.provider]));
    const providersRepresented = new Set(bundle.excerpts.map((excerpt) => sessionProvider.get(excerpt.sessionRef)));
    assert.deepEqual([...providersRepresented].sort(), ["claude-code", "codex"]);
    assert.ok(bundle.discarded.rejectedByBudget > 0);
  } finally {
    await fixture.cleanup();
  }
});

test("mixed-provider scans are deterministic across repeated runs", async () => {
  const fixture = await createMixedProviderFixture();
  try {
    const options = {
      repositoryPath: fixture.repository,
      consent: "local-scan" as const,
      providers: ["claude-code", "codex"] as const,
      codexHome: fixture.codexHome,
      claudeCodeHome: fixture.claudeCodeHome,
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
      narrativeEvidence: {},
    };
    const first = await buildProjectSnapshot({ ...options, providers: [...options.providers] });
    const second = await buildProjectSnapshot({ ...options, providers: [...options.providers] });
    assert.deepEqual(first.narrativeEvidence?.excerpts, second.narrativeEvidence?.excerpts);
  } finally {
    await fixture.cleanup();
  }
});

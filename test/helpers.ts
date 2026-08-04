import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LocalFixture {
  root: string;
  repository: string;
  codexHome: string;
  claudeCodeHome: string;
  outputDirectory: string;
  cleanup(): Promise<void>;
}

/** Mirrors packages/buildstory-scanner/src/sources/claude-code.ts's encodedDirectoryPrefix exactly. */
export function encodedClaudeCodeProjectDirectory(repositoryRoot: string): string {
  return path.resolve(repositoryRoot).replaceAll(/[^A-Za-z0-9]+/g, "-").toLocaleLowerCase("en-US");
}

async function git(repository: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync("git", ["-C", repository, ...args], {
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

export async function createLocalFixture(): Promise<LocalFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-test-"));
  const repository = path.join(root, "selected-repository");
  const codexHome = path.join(root, "codex-home");
  const claudeCodeHome = path.join(root, "claude-code-home");
  const outputDirectory = path.join(root, "output");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "03");
  const claudeProjectDirectory = path.join(
    claudeCodeHome,
    "projects",
    encodedClaudeCodeProjectDirectory(repository),
  );
  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(path.join(codexHome, "archived_sessions"), { recursive: true }),
    mkdir(claudeProjectDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);

  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.name", "Fixture Builder"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await git(repository, ["remote", "add", "origin", "https://private.example.invalid/org/secret-repository.git"]);
  await writeFile(path.join(repository, "fixture.txt"), "synthetic fixture\n", "utf8");
  await git(repository, ["add", "fixture.txt"]);
  await git(repository, ["commit", "--quiet", "-m", "fixture commit"], {
    GIT_AUTHOR_DATE: "2026-08-03T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-03T10:00:00Z",
  });

  const matchingRecords = [
    {
      timestamp: "2026-08-03T10:01:00Z",
      type: "session_meta",
      payload: { id: "fixture-session", timestamp: "2026-08-03T10:01:00Z", cwd: repository, model_provider: "openai" },
    },
    {
      timestamp: "2026-08-03T10:01:01Z",
      type: "turn_context",
      payload: { cwd: repository, model: "gpt-fixture" },
    },
    {
      timestamp: "2026-08-03T10:01:02Z",
      type: "event_msg",
      payload: { type: "user_message", message: "[synthetic transcript body omitted by scanner]" },
    },
    {
      timestamp: "2026-08-03T10:01:03Z",
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "[synthetic tool payload omitted by scanner]" },
    },
    {
      timestamp: "2026-08-03T10:01:04Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "[synthetic transcript body omitted by scanner]" },
    },
    {
      timestamp: "2026-08-03T10:01:05Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
            total_tokens: 130,
          },
        },
      },
    },
    {
      timestamp: "2026-08-03T10:01:06Z",
      type: "event_msg",
      payload: { type: "task_complete" },
    },
  ];
  await writeFile(
    path.join(sessionDirectory, "matching.jsonl"),
    `${matchingRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  const unrelatedRecords = [
    {
      timestamp: "2026-08-03T11:00:00Z",
      type: "session_meta",
      payload: { id: "unrelated", cwd: path.join(root, "different-repository"), model_provider: "openai" },
    },
    { timestamp: "2026-08-03T11:00:01Z", type: "event_msg", payload: { type: "user_message", message: "[not parsed]" } },
  ];
  await writeFile(
    path.join(sessionDirectory, "unrelated.jsonl"),
    `${unrelatedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  const claudeCodeSessionId = "fixture-cc-session";
  const claudeCodeMatchingRecords = [
    {
      type: "user",
      sessionId: claudeCodeSessionId,
      cwd: repository,
      timestamp: "2026-08-03T10:02:00Z",
      permissionMode: "plan",
      message: { role: "user", content: "synthetic user turn one" },
    },
    {
      type: "assistant",
      sessionId: claudeCodeSessionId,
      cwd: repository,
      timestamp: "2026-08-03T10:02:01Z",
      message: {
        role: "assistant",
        model: "claude-fixture",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "[synthetic transcript body omitted by scanner]" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation: { ephemeral_1h_input_tokens: 6, ephemeral_5m_input_tokens: 4 },
        },
      },
    },
    {
      type: "user",
      sessionId: claudeCodeSessionId,
      cwd: repository,
      timestamp: "2026-08-03T10:02:02Z",
      toolUseResult: { content: "[synthetic tool payload omitted by scanner]" },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "[synthetic tool payload omitted by scanner]" }],
      },
    },
    {
      type: "user",
      sessionId: claudeCodeSessionId,
      cwd: repository,
      timestamp: "2026-08-03T10:02:03Z",
      permissionMode: "default",
      message: { role: "user", content: "synthetic user turn two" },
    },
    {
      type: "assistant",
      sessionId: claudeCodeSessionId,
      cwd: repository,
      timestamp: "2026-08-03T10:02:04Z",
      message: {
        role: "assistant",
        model: "claude-fixture",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "[synthetic transcript body omitted by scanner]" }],
        usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 8 },
      },
    },
  ];
  await writeFile(
    path.join(claudeProjectDirectory, `${claudeCodeSessionId}.jsonl`),
    `${claudeCodeMatchingRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  const claudeCodeUnrelatedRecords = [
    {
      type: "user",
      sessionId: "fixture-cc-unrelated",
      cwd: path.join(root, "different-repository"),
      timestamp: "2026-08-03T11:02:00Z",
      message: { role: "user", content: "[not parsed]" },
    },
  ];
  await writeFile(
    path.join(claudeProjectDirectory, "fixture-cc-unrelated.jsonl"),
    `${claudeCodeUnrelatedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  const subagentDirectory = path.join(claudeProjectDirectory, claudeCodeSessionId, "subagents");
  await mkdir(subagentDirectory, { recursive: true });
  const subagentRecords = [
    {
      type: "assistant",
      sessionId: "fixture-cc-subagent",
      cwd: repository,
      timestamp: "2026-08-03T10:02:01Z",
      message: {
        role: "assistant",
        model: "claude-fixture",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "[synthetic transcript body omitted by scanner]" }],
        usage: { input_tokens: 25, output_tokens: 5 },
      },
    },
  ];
  await writeFile(
    path.join(subagentDirectory, "agent-fixture001.jsonl"),
    `${subagentRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(subagentDirectory, "agent-fixture001.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "fixture subagent", toolUseId: "toolu_1", spawnDepth: 1 }),
    "utf8",
  );

  return {
    root,
    repository,
    codexHome,
    claudeCodeHome,
    outputDirectory,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

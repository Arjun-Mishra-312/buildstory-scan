import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn } from "node:child_process";
import { createLocalFixture } from "./helpers.js";

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runProcess(args: string[], cwd?: string): Promise<ProcessResult> {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      windowsHide: true,
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("generate --off writes json markdown and html without contacting a model", async () => {
  const fixture = await createLocalFixture();
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "buildstory-generate-"));
  try {
    const result = await runProcess([
      "generate",
      "--repo", fixture.repository,
      "--consent", "local-scan",
      "--off",
      "--no-tui",
      "--output-dir", outputDirectory,
      "--codex-home", fixture.codexHome,
      "--claude-code-home", fixture.claudeCodeHome,
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /report\.json/);
    assert.match(result.stdout, /private hosted copy/);
    assert.doesNotMatch(result.stdout, /Interactive version → https:\/\/buildstory\.dev/);
    const json = JSON.parse(await readFile(path.join(outputDirectory, "report.json"), "utf8")) as { schemaVersion: string; generatedNarrative?: unknown };
    assert.equal(json.schemaVersion, "1.7.0");
    assert.equal(json.generatedNarrative, undefined);
    const markdown = await readFile(path.join(outputDirectory, "report.md"), "utf8");
    assert.match(markdown, /Open in BuildStory/);
    const html = await readFile(path.join(outputDirectory, "report.html"), "utf8");
    assert.match(html, /buildstory\.dev/);
  } finally {
    await fixture.cleanup();
  }
});

test("generate --json prints a snapshot and still writes files", async () => {
  const fixture = await createLocalFixture();
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "buildstory-generate-json-"));
  try {
    const result = await runProcess([
      "generate",
      "--repo", fixture.repository,
      "--consent", "local-scan",
      "--off",
      "--json",
      "--output-dir", outputDirectory,
      "--codex-home", fixture.codexHome,
      "--claude-code-home", fixture.claudeCodeHome,
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /"schemaVersion": "1\.7\.0"/);
    assert.doesNotMatch(result.stdout, /Interactive version/);
  } finally {
    await fixture.cleanup();
  }
});

test("generate without consent fails closed in non-interactive mode", async () => {
  const result = await runProcess(["generate", "--off", "--no-tui", "--repo", "."]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /CONSENT_REQUIRED/);
});

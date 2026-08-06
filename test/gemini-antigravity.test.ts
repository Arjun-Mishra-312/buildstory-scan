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

async function createRepositoryFixture(): Promise<{ root: string; repository: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-gemini-test-"));
  const repository = path.join(root, "selected-repository");
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.name", "Fixture Builder"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repository, "fixture.txt"), "synthetic fixture\n", "utf8");
  await git(repository, ["add", "fixture.txt"]);
  await git(repository, ["commit", "--quiet", "-m", "fixture commit"], {
    GIT_AUTHOR_DATE: "2026-08-05T09:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-05T09:00:00Z",
  });
  return { root, repository, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

test("Gemini Antigravity is detection-only: not-installed reports zero sessions honestly", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["gemini-antigravity"],
      antigravityHome: path.join(fixture.root, "does-not-exist"),
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
    });
    assert.equal(snapshot.sessions.length, 0);
    assert.deepEqual(snapshot.sourceSelection.providers[0], {
      provider: "gemini-antigravity",
      selected: true,
      repositoryScoped: true,
      rootsConsidered: 1,
      filesDiscovered: 0,
    sessionsMatched: 0,
    sessionsIncluded: 0,
    warnings: 1,
    diagnostic: "format-unsupported",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("Gemini Antigravity is never selected by a default (all-provider) scan", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
    });
    assert.equal(
      snapshot.sourceSelection.providers.some((selection) => selection.provider === "gemini-antigravity"),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an installed but unverified Gemini Antigravity directory still contributes zero sessions", async () => {
  const fixture = await createRepositoryFixture();
  const antigravityHome = path.join(fixture.root, "gemini-antigravity-home");
  try {
    await mkdir(antigravityHome, { recursive: true });
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["gemini-antigravity"],
      antigravityHome,
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
    });
    assert.equal(snapshot.sessions.length, 0);
    assert.ok(snapshot.quality.warnings.some((warning) => warning.code === "PROVIDER_FORMAT_UNVERIFIED"));
  } finally {
    await fixture.cleanup();
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalJson } from "../src/canonical-json.js";
import { buildProjectSnapshot } from "../src/scanner.js";
import { validateProjectSnapshot } from "../src/validation.js";

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync("git", ["-C", repository, ...args], { windowsHide: true, env: { ...process.env, ...env } });
}

interface CursorFixture {
  root: string;
  repository: string;
  cursorHome: string;
  cleanup(): Promise<void>;
}

async function createCursorFixture(): Promise<CursorFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-scanner-cursor-test-"));
  const repository = path.join(root, "selected-repository");
  const cursorHome = path.join(root, "cursor-workspace-storage");
  const scopedWorkspaceDir = path.join(cursorHome, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const unrelatedWorkspaceDir = path.join(cursorHome, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(scopedWorkspaceDir, { recursive: true }),
    mkdir(unrelatedWorkspaceDir, { recursive: true }),
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

  await writeFile(
    path.join(scopedWorkspaceDir, "workspace.json"),
    JSON.stringify({ folder: `file://${repository.replaceAll("\\", "/")}` }),
    "utf8",
  );
  await writeFile(
    path.join(unrelatedWorkspaceDir, "workspace.json"),
    JSON.stringify({ folder: `file://${path.join(root, "different-repository").replaceAll("\\", "/")}` }),
    "utf8",
  );

  const { DatabaseSync } = await import("node:sqlite");

  const scopedDb = new DatabaseSync(path.join(scopedWorkspaceDir, "state.vscdb"));
  scopedDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  const chatData = {
    tabs: [
      {
        bubbles: [
          { role: "user", text: "cursor narrative first user turn" },
          { role: "assistant", text: "cursor narrative assistant reply" },
          { role: "user", text: "cursor narrative last user turn" },
        ],
      },
    ],
  };
  scopedDb
    .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
    .run("workbench.panel.aichat.view.aichat.chatdata", JSON.stringify(chatData));
  scopedDb.close();
  await utimes(path.join(scopedWorkspaceDir, "state.vscdb"), new Date("2026-08-05T09:00:00Z"), new Date("2026-08-05T09:00:00Z"));

  const unrelatedDb = new DatabaseSync(path.join(unrelatedWorkspaceDir, "state.vscdb"));
  unrelatedDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  unrelatedDb
    .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
    .run(
      "workbench.panel.aichat.view.aichat.chatdata",
      JSON.stringify({ tabs: [{ bubbles: [{ role: "user", text: "this must never appear" }] }] }),
    );
  unrelatedDb.close();
  await utimes(path.join(unrelatedWorkspaceDir, "state.vscdb"), new Date("2026-08-05T09:00:00Z"), new Date("2026-08-05T09:00:00Z"));

  return { root, repository, cursorHome, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

test("Cursor sessions are repository-scoped via workspace.json and produce narrative-evidence excerpts", async () => {
  const fixture = await createCursorFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["cursor"],
      cursorHome: fixture.cursorHome,
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
    });
    validateProjectSnapshot(snapshot);
    assert.equal(snapshot.sessions.length, 1);
    const session = snapshot.sessions[0];
    assert.ok(session);
    assert.equal(session.provider, "cursor");
    assert.equal(session.turns, 2);
    assert.equal(session.assistantMessages, 1);
    assert.ok(
      snapshot.quality.warnings.some((warning) => warning.code === "PROVIDER_FORMAT_UNVERIFIED"),
      "Cursor sessions must always disclose the format-unverified diagnostic",
    );

    const serialized = canonicalJson(snapshot);
    assert.equal(serialized.includes("this must never appear"), false);
    assert.equal(serialized.includes(fixture.repository), false);

    const withEvidence = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["cursor"],
      cursorHome: fixture.cursorHome,
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
      narrativeEvidence: {},
    });
    const bundle = withEvidence.narrativeEvidence;
    assert.ok(bundle);
    assert.ok(bundle.excerpts.length > 0);
    assert.ok(bundle.excerpts.some((excerpt) => excerpt.text === "cursor narrative first user turn"));
    assert.ok(bundle.excerpts.some((excerpt) => excerpt.text === "cursor narrative last user turn"));
  } finally {
    await fixture.cleanup();
  }
});

test("a Cursor workspace storage root that does not exist is reported as not-installed, not an error", async () => {
  const fixture = await createCursorFixture();
  try {
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["cursor"],
      cursorHome: path.join(fixture.root, "does-not-exist"),
      since: "2026-08-05T00:00:00Z",
      until: "2026-08-06T00:00:00Z",
    });
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.sourceSelection.providers[0]?.diagnostic, "not-installed");
  } finally {
    await fixture.cleanup();
  }
});

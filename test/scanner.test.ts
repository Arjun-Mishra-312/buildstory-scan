import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { writeSnapshotFile } from "../src/output.js";
import { buildProjectSnapshot, inspectSelectedRepository } from "../src/scanner.js";
import { validateProjectSnapshot } from "../src/validation.js";
import { createLocalFixture } from "./helpers.js";

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

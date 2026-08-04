import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "../src/contract.js";
import { validateProjectSnapshot } from "../src/validation.js";

test("the portable example fixture conforms to the published JSON Schema", async () => {
  const fixturePath = fileURLToPath(new URL("../../examples/project-snapshot.example.json", import.meta.url));
  const fixture: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  validateProjectSnapshot(fixture);
  assert.equal((fixture as { schemaVersion: string }).schemaVersion, PROJECT_SNAPSHOT_SCHEMA_VERSION);
});

test("the schema fails closed on fields that could smuggle raw content", () => {
  assert.throws(() => validateProjectSnapshot({
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    sourceCode: "not allowed",
  }));
});

test("the schema rejects a remote host even when the rest of the fixture is valid", async () => {
  const fixturePath = fileURLToPath(new URL("../../examples/project-snapshot.example.json", import.meta.url));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    repository: { remote: Record<string, unknown> | null };
  };
  assert.ok(fixture.repository.remote);
  fixture.repository.remote.host = "private.example.invalid";
  assert.throws(() => validateProjectSnapshot(fixture), /additional properties/);
});

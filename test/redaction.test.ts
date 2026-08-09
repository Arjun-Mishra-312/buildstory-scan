import assert from "node:assert/strict";
import test from "node:test";
import { detectKnownSecrets, Redactor } from "../src/redaction.js";
import { detectPrivateLocations } from "../src/privacy-boundary.js";

test("redacts common credential formats deterministically", () => {
  const inputs = [
    "Bearer abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
    "AKIA1234567890ABCDEF",
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "xapp-1234567890-abcdefghijklmnop",
    "1//0abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN PRIVATE KEY-----\nsynthetic-key-material-without-an-end-marker",
    "postgres://builder:very-secret-password@example.invalid/database",
    "API_KEY=abcdefghijklmnopqrstuvwxyz123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz",
  ];
  const redactor = new Redactor();
  const output = inputs.map((input) => redactor.cleanMetadata(input, 300)).join("\n");

  for (const input of inputs) assert.notEqual(output.includes(input), true);
  assert.deepEqual(detectKnownSecrets(output), []);
  const summary = redactor.summary(true);
  assert.equal(summary.applied, true);
  assert.ok(summary.findings >= inputs.length);
  assert.equal(summary.finalLeakCheckPassed, true);
});

test("does not classify commit hashes as generic high-entropy secrets", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const redactor = new Redactor();
  assert.equal(redactor.cleanMetadata(hash), hash);
});

test("detects URLs, hosts, and local paths at the upload boundary", () => {
  assert.deepEqual(
    detectPrivateLocations([
      "https://private.example.invalid/repository",
      "git@github.com:private/repository.git",
      "C:\\Users\\builder\\private\\source.ts",
      "/home/builder/private/source.ts",
      "src/private/source.ts",
    ]),
    ["absolute-path", "raw-host", "relative-file-path", "remote-url"],
  );
  assert.deepEqual(
    detectPrivateLocations(["gpt-5.1-codex", "feature/privacy-boundary", "sha256:abc"]),
    [],
  );
});

test("drops quoted JSON secrets and redacts emails, uncommon hosts, and quoted paths with spaces", () => {
  const redactor = new Redactor();
  assert.equal(redactor.cleanExcerpt('{"api_key":"lowentropy-secret"}', 600), null);
  const cleaned = redactor.cleanExcerpt(
    'Email jane.builder@example.ca, open private.host.xyz and "C:\\Users\\Jane Doe\\private source.ts".',
    600,
  );
  assert.ok(cleaned);
  assert.doesNotMatch(cleaned!, /jane\.builder|example\.ca|private\.host\.xyz|Jane Doe|private source/);
  assert.match(cleaned!, /\[email-address\]/);
  assert.match(cleaned!, /\[raw-host\]/);
  assert.match(cleaned!, /\[absolute-path\]/);
});

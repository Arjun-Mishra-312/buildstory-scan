import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connectBuildStory } from "../src/connect.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "../src/contract.js";
import { ScannerError } from "../src/errors.js";
import { pollPairingUntilGranted } from "../src/pair.js";
import { uploadExistingSnapshot } from "../src/local-upload.js";
import { resolveOpenKey } from "../src/tui/open-keys.js";
import { createLocalFixture } from "./helpers.js";
import { buildProjectSnapshot } from "../src/scanner.js";

test("o never starts an upload until confirm is accepted", () => {
  assert.equal(resolveOpenKey("idle", "o"), "prompt-confirm");
  assert.equal(resolveOpenKey("idle", "y"), null);
  assert.equal(resolveOpenKey("confirm", "y"), "start-upload");
});

test("pairing poll expires without treating a grant as approved", async () => {
  await assert.rejects(
    () => pollPairingUntilGranted({
      pairingId: "pair_expired",
      intervalSeconds: 1,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      fetchImplementation: async () => {
        throw new Error("poll must not contact the API after expiry");
      },
    }),
    (error: unknown) => error instanceof ScannerError && error.code === "PAIR_EXPIRED",
  );
});

test("uploadExistingSnapshot PUTs the provided snapshot and does not rescan", async () => {
  const fixture = await createLocalFixture();
  const stateDirectory = path.join(fixture.root, "upload-existing-state");
  const snapshot = await buildProjectSnapshot({
    repositoryPath: fixture.repository,
    consent: "local-scan",
    providers: ["codex"],
    codexHome: fixture.codexHome,
    since: "2026-08-03T00:00:00Z",
    until: "2026-08-04T00:00:00Z",
  });
  const reportPath = path.join(fixture.root, "report.json");
  await writeFile(reportPath, JSON.stringify(snapshot));
  const originalSessions = snapshot.sessions.length;
  let uploaded = false;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "POST" && request.url === "/api/v1/cli/connect") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocolVersion: "1.0",
          status: "connected",
          uploadSessionId: JSON.parse(body).uploadSessionId,
          connectionId: "connection-existing-001",
          uploadGrant: {
            bearerToken: "fixture-existing-one-use-bearer-token",
            snapshotEndpoint: "/api/v1/cli/snapshots/existing-001",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
            maxBytes: 1024 * 1024,
          },
        }));
        return;
      }
      if (request.method === "PUT" && request.url === "/api/v1/cli/snapshots/existing-001") {
        uploaded = true;
        const received = JSON.parse(body) as { sessions: unknown[] };
        assert.equal(received.sessions.length, originalSessions);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocolVersion: "1.0",
          status: "accepted",
          receipt: {
            receiptId: "receipt-existing-001",
            scanId: snapshot.scanId,
            snapshotDigest: request.headers["x-buildstory-snapshot-digest"],
            acceptedAt: new Date().toISOString(),
          },
          statusUrl: "/api/v1/cli/status/existing-001",
          reportUrl: "/api/v1/cli/reports/existing-001",
        }));
        return;
      }
      response.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address() as AddressInfo;
    const apiBaseUrl = `http://127.0.0.1:${address.port}/`;
    await connectBuildStory({
      uploadSessionId: "session-existing-001",
      deviceCode: "DEVICE-CODE-EXISTING-001",
      apiBaseUrl,
      stateDirectory,
    });
    const fromDisk = JSON.parse(await readFile(reportPath, "utf8")) as typeof snapshot;
    const receipt = await uploadExistingSnapshot(fromDisk, { stateDirectory });
    assert.equal(uploaded, true);
    assert.equal(receipt.accepted, true);
    assert.match(receipt.snapshotDigest, /^sha256:/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fixture.cleanup();
  }
});
